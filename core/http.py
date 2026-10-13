"""Tiny HTTP/1.1 server: static files + WebSocket upgrade. Standard library only."""
from __future__ import annotations

import asyncio
import json
import mimetypes
import os
from urllib.parse import parse_qs, unquote, urlsplit

from . import netinfo
from .ws import WebSocket, accept_key

MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
}

# Files a game folder may expose to browsers (never .py!).
GAME_PUBLIC_EXT = {
    ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".json", ".mp3", ".ogg", ".wav", ".woff2", ".txt",
}

STATUS_TEXT = {
    200: "OK", 304: "Not Modified", 400: "Bad Request", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 500: "Internal Server Error",
}

MAX_HEADER_BYTES = 16 * 1024
IDLE_TIMEOUT = 20.0

# Static files are kept in memory so a room full of phones loading at once doesn't hit the disk
# (or block the event loop on file reads) for every request. An entry is reused only while the
# file's mtime and size are unchanged, so editing a file while the server runs still works.
MAX_CACHED_FILE = 512 * 1024
_file_cache: dict[str, tuple[tuple[int, int], bytes, str]] = {}


def origin_ok(headers: dict) -> bool:
    """Refuse WebSocket upgrades that come from a web page on another site.

    Browsers do not apply the same-origin policy to WebSockets, so without this check any page
    open in the host's browser could connect to localhost:8000 and act as a player. Our own pages
    always send an Origin equal to the Host they were loaded from. Clients that send no Origin
    at all (scripts, test tools) are not browsers and are let through.
    """
    origin = headers.get("origin")
    if not origin:
        return True
    if origin.lower() == "null":
        return False
    host = headers.get("host", "").lower()
    fhost = headers.get("x-forwarded-host", "").lower()
    try:
        netloc = urlsplit(origin).netloc.lower()
    except ValueError:
        return False
    if fhost:
        fhosts = [h.strip() for h in fhost.split(",")]
        for h in fhosts:
            if netloc == h:
                return True
            if netloc.split(":")[0] == h.split(":")[0] and not (netloc.startswith(("127.", "localhost")) or h.startswith(("127.", "localhost"))):
                return True
    return bool(host) and netloc == host


def _etag_matches(header: str, etag: str) -> bool:
    """Does an If-None-Match header value cover this ETag? (weak validators compare equal here)"""
    for tag in header.split(","):
        tag = tag.strip()
        if tag.startswith("W/"):
            tag = tag[2:]
        if tag == "*" or tag == etag:
            return True
    return False


def safe_join(base: str, rel: str) -> str | None:
    """Join rel under base, refusing traversal, hidden files and symlink escapes."""
    if "\x00" in rel or "\\" in rel:
        return None
    parts = [p for p in rel.split("/") if p not in ("", ".")]
    if any(p == ".." or p.startswith(".") for p in parts):
        return None
    base_real = os.path.realpath(base)
    full = os.path.realpath(os.path.join(base_real, *parts))
    if full != base_real and not full.startswith(base_real + os.sep):
        return None
    return full


def build_response(status: int, body: bytes = b"", ctype: str = "text/plain; charset=utf-8",
                   head_only: bool = False, extra: dict | None = None, keep_alive: bool = True) -> bytes:
    headers = {
        "Content-Type": ctype,
        "Content-Length": str(len(body)),
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Connection": "keep-alive" if keep_alive else "close",
    }
    if extra:
        headers.update(extra)
    lines = [f"HTTP/1.1 {status} {STATUS_TEXT.get(status, 'OK')}"]
    lines += [f"{k}: {v}" for k, v in headers.items()]
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")
    return head if head_only else head + body


async def read_request(reader: asyncio.StreamReader):
    try:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), IDLE_TIMEOUT)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError,
            ConnectionError, OSError):
        return None
    if len(raw) > MAX_HEADER_BYTES:
        return None
    try:
        text = raw.decode("latin-1")
        lines = text.split("\r\n")
        method, target, version = lines[0].split(" ", 2)
    except ValueError:
        return {"bad": True}
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return {"method": method.upper(), "target": target, "version": version, "headers": headers}


def static_response(root: str, lobby, path: str, head_only: bool, keep_alive: bool, query: str = "",
                    if_none_match: str = "") -> bytes:
    path = unquote(path)
    if path == "/qr":
        data = (parse_qs(query).get("d") or [""])[0]
        if not data.startswith(("http://", "https://")) or len(data) > 300:
            return build_response(400, b"Bad QR data", head_only=head_only, keep_alive=keep_alive)
        svg = netinfo.qr_svg(data)
        if svg is None:
            return build_response(404, b"QR codes need: pip install segno", head_only=head_only, keep_alive=keep_alive)
        return build_response(200, svg, MIME_OVERRIDES[".svg"], head_only, keep_alive=keep_alive)
    if path == "/api/info":
        body = json.dumps({"games": lobby.games_public()}).encode()
        return build_response(200, body, MIME_OVERRIDES[".json"], head_only, keep_alive=keep_alive)

    if path.startswith("/g/"):
        rest = path[3:].split("/", 1)
        if len(rest) != 2 or not rest[1]:
            return build_response(404, b"Not found", head_only=head_only, keep_alive=keep_alive)
        game_id, rel = rest
        if game_id.startswith("_") or game_id.startswith("."):
            return build_response(404, b"Not found", head_only=head_only, keep_alive=keep_alive)
        full = safe_join(os.path.join(root, "games", game_id), rel)
        if full and os.path.splitext(full)[1].lower() not in GAME_PUBLIC_EXT:
            full = None
    else:
        if path == "/":
            path = "/index.html"
        full = safe_join(os.path.join(root, "web"), path.lstrip("/"))

    if not full:
        return build_response(404, b"Not found", head_only=head_only, keep_alive=keep_alive)
    try:
        st = os.stat(full)
    except OSError:
        return build_response(404, b"Not found", head_only=head_only, keep_alive=keep_alive)
    if not os.path.isfile(full):
        return build_response(404, b"Not found", head_only=head_only, keep_alive=keep_alive)

    stamp = (st.st_mtime_ns, st.st_size)
    hit = _file_cache.get(full)
    if hit and hit[0] == stamp:
        body, etag = hit[1], hit[2]
    else:
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return build_response(500, b"Could not read file", head_only=head_only, keep_alive=keep_alive)
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
        if len(body) <= MAX_CACHED_FILE:
            _file_cache[full] = (stamp, body, etag)

    ext = os.path.splitext(full)[1].lower()
    ctype = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
    # Fonts never change, so browsers may keep them; everything else is revalidated every time
    # ("no-cache" + ETag), which costs a tiny 304 instead of a full download.
    cache = "public, max-age=86400" if ext == ".woff2" else "no-cache"
    extra = {"ETag": etag, "Cache-Control": cache}
    if if_none_match and _etag_matches(if_none_match, etag):
        return build_response(304, b"", ctype, True, extra, keep_alive)
    return build_response(200, body, ctype, head_only, extra, keep_alive)


async def serve_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, lobby, root: str):
    try:
        while True:
            req = await read_request(reader)
            if req is None:
                break
            if req.get("bad"):
                writer.write(build_response(400, b"Bad request", keep_alive=False))
                break

            parts = urlsplit(req["target"])
            path = parts.path
            headers = req["headers"]

            # ---- WebSocket upgrade -------------------------------------------------
            if path == "/ws" and headers.get("upgrade", "").lower() == "websocket":
                key = headers.get("sec-websocket-key")
                if not key or req["method"] != "GET":
                    writer.write(build_response(400, b"Bad websocket request", keep_alive=False))
                    break
                if not origin_ok(headers):
                    writer.write(build_response(403, b"Cross-site connections are not allowed",
                                                keep_alive=False))
                    break
                writer.write((
                    "HTTP/1.1 101 Switching Protocols\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
                ).encode("latin-1"))
                ws = WebSocket(reader, writer)
                ws.start_keepalive()
                try:
                    await lobby.run_connection(ws)
                finally:
                    ws.stop_keepalive()
                break

            # ---- plain HTTP --------------------------------------------------------
            if req["method"] not in ("GET", "HEAD"):
                writer.write(build_response(405, b"Method not allowed", extra={"Allow": "GET, HEAD"},
                                            keep_alive=False))
                break
            keep_alive = headers.get("connection", "").lower() != "close" and req["version"] == "HTTP/1.1"
            writer.write(static_response(root, lobby, path, req["method"] == "HEAD", keep_alive, parts.query,
                                         headers.get("if-none-match", "")))
            if not keep_alive:
                break
    except (ConnectionError, OSError, asyncio.CancelledError):
        pass
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            writer.close()
        except Exception:
            pass
