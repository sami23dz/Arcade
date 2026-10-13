"""Find the address friends should type, and print it nicely (with a terminal QR if possible).

Why this is not just "connect a UDP socket to 8.8.8.8": when the phone is the hotspot and
has no mobile data / Wi-Fi uplink, there is NO default route, so that trick fails. We ask each
network interface directly instead (works without a route), then fall back to other tricks.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import socket
import subprocess
import sys

_vendor = os.path.join(os.path.dirname(__file__), "vendor")
if os.path.isdir(_vendor) and _vendor not in sys.path:
    sys.path.insert(0, _vendor)

# interface-name hints -> (rank, label). Lower rank = more likely to be what friends can reach.
_HINTS = [
    (r"^(ap\d*|swlan\d*|softap\d*|wlan1|wlan2|wigig_?\d*)$", 0, "hotspot"),
    (r"^(wlan\d*|wifi\d*|eth\d*|en\w*|br\d*)$", 1, "wifi/lan"),
    (r"^(rndis\d*|usb\d*)$", 2, "usb tethering"),
    (r"^(rmnet\w*|ccmni\d*|v4-rmnet\w*|pdp\d*|ppp\d*|tun\d*|wg\d*)$", 9, "mobile data / vpn (friends can't reach this)"),
]
_GUESS_NAMES = ["ap0", "ap1", "swlan0", "wlan0", "wlan1", "wlan2", "eth0", "rndis0", "br0", "p2p0"]


def _rank(name: str):
    for pattern, rank, label in _HINTS:
        if re.match(pattern, name):
            return rank, label
    return 5, "network"


def _interface_names() -> list[str]:
    names: list[str] = []
    try:
        names += [n for _, n in socket.if_nameindex()]
    except Exception:
        pass
    try:
        with open("/proc/net/dev") as f:
            for line in f.read().splitlines()[2:]:
                n = line.split(":", 1)[0].strip()
                if n:
                    names.append(n)
    except Exception:
        pass
    names += _GUESS_NAMES
    seen, out = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _ioctl_ip(sock, name: str) -> str | None:
    try:
        import fcntl
        import struct
        res = fcntl.ioctl(sock.fileno(), 0x8915, struct.pack("256s", name.encode()[:15]))  # SIOCGIFADDR
        return socket.inet_ntoa(res[20:24])
    except Exception:
        return None


def _usable(ip: str) -> bool:
    return bool(ip) and not ip.startswith(("127.", "169.254.", "0.")) and ip != "255.255.255.255"


def _from_commands() -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for cmd in (["ip", "-4", "-o", "addr"], ["ifconfig"]):
        if not shutil.which(cmd[0]):
            continue
        try:
            text = subprocess.run(cmd, capture_output=True, text=True, timeout=3).stdout
        except Exception:
            continue
        if cmd[0] == "ip":
            for m in re.finditer(r"^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)", text, re.M):
                out.append((m.group(2), m.group(1)))
        else:
            for block in re.split(r"\n(?=\S)", text):
                nm = re.match(r"(\S+?):?\s", block)
                ip = re.search(r"inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)", block)
                if nm and ip:
                    out.append((ip.group(1), nm.group(1)))
        if out:
            break
    return out


def candidate_ips() -> list[dict]:
    """Return [{'ip','iface','rank','label'}], most likely first."""
    found: dict[str, str] = {}
    sock = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for name in _interface_names():
            ip = _ioctl_ip(sock, name)
            if ip and _usable(ip):
                found.setdefault(ip, name)
    except Exception:
        pass
    finally:
        if sock:
            sock.close()

    if not found:
        for ip, name in _from_commands():
            if _usable(ip):
                found.setdefault(ip, name)

    if not found:  # needs a default route, so only helps when on normal Wi-Fi
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ip = s.getsockname()[0]
            s.close()
            if _usable(ip):
                found.setdefault(ip, "default-route")
        except Exception:
            pass

    result = []
    for ip, name in found.items():
        rank, label = _rank(name)
        result.append({"ip": ip, "iface": name, "rank": rank, "label": label})
    result.sort(key=lambda r: (r["rank"], r["ip"]))
    return result


def qr_svg(text: str) -> bytes | None:
    """SVG bytes of a QR code for `text`, or None if the optional `segno` package is missing."""
    try:
        import segno
    except ImportError:
        return None
    qr = segno.make(text, error="m", micro=False)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=10, border=2, dark="#0b0a1a", light="#ffffff", xmldecl=False, svgns=True)
    return buf.getvalue()


def print_terminal_qr(url: str) -> bool:
    try:
        import segno
    except ImportError:
        return False
    try:
        segno.make(url, error="l", micro=False).terminal(compact=True, border=1)
        return True
    except Exception:
        return False
