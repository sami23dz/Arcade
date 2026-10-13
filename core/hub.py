"""Hub: players, rooms, the lobby protocol and the game lifecycle.

Everything runs on one asyncio thread and game code is synchronous, so there are no locks.

Client -> server messages (JSON, always {"t": type, ...}):
    hello       {pid?, token?, name, color, avatar}      first message on every connection
    profile     {name, color, avatar}
    room.create {game}        room.join {code}      room.leave {}
    room.ready  {ready}       room.select {game}    room.start {}
    loaded      {}            client mounted the game view
    g           {d: {...}}    game message, forwarded to the game's on_message
    ping        {c}

Server -> client:
    welcome {pid, token, resumed, me, games, urls}     presence {players}
    room {room|null}       game.start / game.end / game.abort      g {d}
    error {code, msg}      pong {c}
"""
from __future__ import annotations

import asyncio
import hmac
import json
import random
import re
import secrets
import time
import traceback

from .games import GameInfo
from .ws import WebSocket, WSClosed

PALETTE = 6            # player colors 0..5
AVATARS = 12           # avatar designs 0..11
ROOM_MAX = 6
GRACE = 90.0           # seconds a dropped player keeps their seat
HOST_MIGRATE_DELAY = 6.0
LOAD_TIMEOUT = 7.0     # wait this long for every client to load a game before starting
CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ"   # no vowels (no accidental words), no look-alikes
MAX_CLIENT_MSG = 8192
NAME_MAX = 14
DEFAULT_NAMES = [
    "Neon Fox", "Pixel Owl", "Turbo Cat", "Cosmic Pup", "Laser Bat", "Disco Yak",
    "Comet Kid", "Jelly Bot", "Zippy Moth", "Astro Newt", "Glitch Gnu", "Mango Ray",
]


def dumps(obj) -> str:
    return json.dumps(obj, separators=(",", ":"))


class UserError(Exception):
    def __init__(self, msg: str, code: str = "error"):
        super().__init__(msg)
        self.code = code


def clean_name(raw, fallback: str) -> str:
    s = re.sub(r"[\x00-\x1f\x7f<>]", "", str(raw or ""))
    s = " ".join(s.split())[:NAME_MAX].strip()
    return s or fallback


def clean_index(raw, limit: int, fallback: int) -> int:
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return fallback
    return v if 0 <= v < limit else fallback


class Player:
    def __init__(self, pid: str, token: str):
        self.id = pid
        self.token = token
        self.name = ""
        self.color = 0
        self.avatar = 0
        self.ws: WebSocket | None = None
        self.room: Room | None = None
        self.expire_handle = None
        self.tokens = 200.0          # message budget (rate limiting)
        self.last_refill = time.monotonic()
        self.is_npc = False

    @property
    def online(self) -> bool:
        if self.is_npc:
            return True
        return self.ws is not None and not self.ws.closed

    def send(self, obj) -> bool:
        if self.is_npc:
            return True
        if not self.online:
            return False
        try:
            self.ws.send_text(obj if isinstance(obj, str) else dumps(obj))
            return True
        except WSClosed:
            return False

    def allow(self) -> bool:
        if self.is_npc:
            return True
        now = time.monotonic()
        self.tokens = min(240.0, self.tokens + (now - self.last_refill) * 120.0)
        self.last_refill = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


class Member:
    __slots__ = ("pid", "ready", "color", "wins")

    def __init__(self, pid: str, color: int):
        self.pid = pid
        self.ready = False
        self.color = color
        self.wins = 0


class Room:
    def __init__(self, code: str, game_id: str, host: str):
        self.code = code
        self.game_id = game_id
        self.host = host
        self.members: dict[str, Member] = {}
        self.state = "lobby"          # lobby | playing
        self.ctx: GameContext | None = None
        self.game = None
        self.started = False          # game.start() has been called
        self.run = 0
        self.pending: set[str] = set()
        self.load_timer = None


class Timer:
    """Handle returned by ctx.later / ctx.every."""
    __slots__ = ("ctx", "fn", "args", "interval", "next", "handle", "dead")

    def __init__(self, ctx, fn, args, interval=None):
        self.ctx, self.fn, self.args, self.interval = ctx, fn, args, interval
        self.next = 0.0
        self.handle = None
        self.dead = False

    def cancel(self):
        self.dead = True
        if self.handle:
            self.handle.cancel()
            self.handle = None
        self.ctx._timers.discard(self)

    def _fire_once(self):
        self.ctx._timers.discard(self)
        if not self.dead:
            self.ctx._run(self.fn, *self.args)

    def _fire_repeat(self):
        if self.dead:
            return
        loop = self.ctx.loop
        self.next += self.interval
        now = loop.time()
        if self.next < now:                       # fell behind: skip ahead rather than pile up
            self.next = now + self.interval
        self.handle = loop.call_at(self.next, self._fire_repeat)
        self.ctx._run(self.fn, *self.args)


class GameContext:
    """What a game sees. Documented in core/game_api.py."""

    def __init__(self, hub: "Hub", room: Room, players: list[dict]):
        self.hub = hub
        self.room = room
        self.loop = asyncio.get_running_loop()
        self.players = players
        self.player_ids = [p["id"] for p in players]
        self.rng = random.Random()
        self.done = False
        self.errors = 0
        self._timers: set[Timer] = set()

    # ---- messaging ---------------------------------------------------------
    def send(self, pid: str, data) -> None:
        p = self.hub.players.get(pid)
        if p:
            p.send({"t": "g", "d": data})

    def broadcast(self, data, exclude: str | None = None) -> None:
        text = dumps({"t": "g", "d": data})
        for pid in self.player_ids:
            if pid == exclude:
                continue
            p = self.hub.players.get(pid)
            if p and p.room is self.room:
                p.send(text)

    def is_connected(self, pid: str) -> bool:
        p = self.hub.players.get(pid)
        return bool(p and p.online and p.room is self.room)

    def connected_ids(self) -> list[str]:
        return [pid for pid in self.player_ids if self.is_connected(pid)]

    def now(self) -> float:
        return self.loop.time()

    # ---- timers ------------------------------------------------------------
    def later(self, delay: float, fn, *args) -> Timer:
        t = Timer(self, fn, args)
        t.handle = self.loop.call_later(max(0.0, delay), t._fire_once)
        self._timers.add(t)
        return t

    def every(self, interval: float, fn, *args) -> Timer:
        t = Timer(self, fn, args, interval)
        t.next = self.loop.time() + interval
        t.handle = self.loop.call_at(t.next, t._fire_repeat)
        self._timers.add(t)
        return t

    def _cancel_timers(self) -> None:
        for t in list(self._timers):
            t.cancel()

    # ---- lifecycle ---------------------------------------------------------
    def finish(self, scores: dict, winners=None, title=None, notes=None) -> None:
        if self.done:
            return
        self.done = True
        self.loop.call_soon(self.hub._finish_game, self.room, self, scores, winners, title, notes)

    def abort(self, reason: str = "The round was cancelled.") -> None:
        if self.done:
            return
        self.done = True
        self.loop.call_soon(self.hub._abort_game, self.room, self, reason)

    def _run(self, fn, *args):
        """Run game code; a crash in a game must never take the server down."""
        if self.done:
            return
        try:
            fn(*args)
        except Exception:
            traceback.print_exc()
            self.errors += 1
            if self.errors >= 8:
                self.abort("The game hit an error and was stopped.")


class Hub:
    def __init__(self, games: dict[str, GameInfo]):
        self.games = games
        self.players: dict[str, Player] = {}
        self.rooms: dict[str, Room] = {}
        self.urls: list[str] = []
        self._presence_handle = None
        self.handlers = {
            "profile": self.h_profile,
            "room.create": self.h_create,
            "room.join": self.h_join,
            "room.leave": self.h_leave,
            "room.ready": self.h_ready,
            "room.select": self.h_select,
            "room.start": self.h_start,
            "room.npc": self.h_npc,
            "loaded": self.h_loaded,
            "g": self.h_game,
            "ping": self.h_ping,
        }

    # ------------------------------------------------------------ logging
    def log(self, msg: str) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    def games_public(self) -> list[dict]:
        return [g.public() for g in self.games.values()]

    # ----------------------------------------------------- connection loop
    async def run_connection(self, ws: WebSocket) -> None:
        player: Player | None = None
        try:
            try:
                first = await asyncio.wait_for(ws.recv(), 10)
            except asyncio.TimeoutError:
                return
            msg = self._parse(first)
            if not msg or msg.get("t") != "hello":
                return
            player = self._attach(ws, msg)
            while True:
                raw = await ws.recv()
                if raw is None:
                    break
                if len(raw) > MAX_CLIENT_MSG:
                    continue
                msg = self._parse(raw)
                if not msg:
                    continue
                if not player.allow():
                    continue
                self._dispatch(player, msg)
        finally:
            if player is not None and player.ws is ws:
                self._detach(player)
            await ws.close()

    @staticmethod
    def _parse(raw):
        if not raw:
            return None
        try:
            msg = json.loads(raw)
        except ValueError:
            return None
        return msg if isinstance(msg, dict) else None

    def _dispatch(self, p: Player, msg: dict) -> None:
        fn = self.handlers.get(msg.get("t"))
        if fn is None:
            return
        try:
            fn(p, msg)
        except UserError as e:
            p.send({"t": "error", "code": e.code, "msg": str(e)})
        except Exception:
            traceback.print_exc()
            p.send({"t": "error", "code": "server", "msg": "Something went wrong on the host phone."})

    # ------------------------------------------------- attach / detach
    def _attach(self, ws: WebSocket, hello: dict) -> Player:
        pid = str(hello.get("pid") or "")
        token = str(hello.get("token") or "")
        player = self.players.get(pid)
        resumed = bool(player and hmac.compare_digest(player.token, token))
        if resumed:
            old = player.ws
            player.ws = ws
            if old is not None and old is not ws:
                old.abort()                       # newer connection wins (page reload / second tab)
            if player.expire_handle:
                player.expire_handle.cancel()
                player.expire_handle = None
        else:
            while True:
                pid = "p" + secrets.token_hex(3)
                if pid not in self.players:
                    break
            player = Player(pid, secrets.token_urlsafe(12))
            player.ws = ws
            self.players[pid] = player

        self._apply_profile(player, hello, initial=not resumed)
        self.log(f"{player.name} {'came back' if resumed else 'joined'} ({sum(1 for q in self.players.values() if q.online)} online)")

        player.send({
            "t": "welcome", "pid": player.id, "token": player.token, "resumed": resumed,
            "me": self._me(player), "games": self.games_public(), "urls": self.urls,
        })
        room = player.room
        if resumed and room is not None:
            player.send({"t": "room", "room": self.room_view(room)})
            if room.state == "playing" and room.ctx and not room.ctx.done:
                player.send({"t": "game.start", "game": room.game_id, "run": room.run,
                             "players": room.ctx.players, "resume": True})
            self._broadcast_room(room)            # everyone sees them as online again
        else:
            player.send({"t": "room", "room": None})
        self._presence_dirty()
        return player

    def _detach(self, p: Player) -> None:
        p.ws = None
        room = p.room
        self.log(f"{p.name} disconnected")
        if room is not None:
            if room.state == "playing" and room.ctx and not room.ctx.done:
                room.pending.discard(p.id)
                if room.started:
                    room.ctx._run(room.game.on_disconnect, p.id)
                elif not room.pending:
                    self._begin_game(room, room.run)
            self._broadcast_room(room)
            if room.host == p.id and len(room.members) > 1:
                asyncio.get_running_loop().call_later(HOST_MIGRATE_DELAY, self._maybe_migrate, room, p.id)
        p.expire_handle = asyncio.get_running_loop().call_later(GRACE, self._expire, p)
        self._presence_dirty()

    def _expire(self, p: Player) -> None:
        if p.online or self.players.get(p.id) is not p:
            return
        self.log(f"{p.name} timed out")
        self._leave_room(p)
        self.players.pop(p.id, None)
        self._presence_dirty()

    def _maybe_migrate(self, room: Room, old_host: str) -> None:
        if self.rooms.get(room.code) is not room or room.host != old_host:
            return
        hp = self.players.get(old_host)
        if hp and hp.online:
            return
        for pid in room.members:
            q = self.players.get(pid)
            if pid != old_host and q and q.online:
                room.host = pid
                self.log(f"room {room.code}: host is now {q.name}")
                self._broadcast_room(room)
                return

    # ------------------------------------------------------- profile
    def _me(self, p: Player) -> dict:
        return {"id": p.id, "name": p.name, "color": p.color, "avatar": p.avatar}

    def _unique_name(self, name: str, me: Player) -> str:
        taken = {q.name.lower() for q in self.players.values() if q is not me and q.online}
        if name.lower() not in taken:
            return name
        for n in range(2, 100):
            suffix = f" {n}"
            candidate = name[:NAME_MAX - len(suffix)] + suffix
            if candidate.lower() not in taken:
                return candidate
        return name

    def _apply_profile(self, p: Player, msg: dict, initial: bool = False) -> None:
        fallback = p.name or random.choice(DEFAULT_NAMES)
        name = clean_name(msg.get("name"), fallback)
        p.name = self._unique_name(name, p)
        p.avatar = clean_index(msg.get("avatar"), AVATARS, p.avatar if not initial else random.randrange(AVATARS))
        p.color = clean_index(msg.get("color"), PALETTE, p.color if not initial else random.randrange(PALETTE))

    def h_profile(self, p: Player, msg: dict) -> None:
        old_color = p.color
        self._apply_profile(p, msg)
        room = p.room
        if room is not None:
            m = room.members[p.id]
            if p.color != m.color:
                taken = {x.color for pid, x in room.members.items() if pid != p.id}
                if p.color in taken:
                    p.send({"t": "error", "code": "color", "msg": "That color is already taken in this room."})
                elif room.state == "lobby":
                    m.color = p.color
                else:
                    p.send({"t": "error", "code": "color", "msg": "Colors are locked during a round."})
            self._broadcast_room(room)
        p.send({"t": "me", "me": self._me(p)})
        self._presence_dirty()

    # ------------------------------------------------------- presence
    def _presence_dirty(self) -> None:
        if self._presence_handle is None:
            self._presence_handle = asyncio.get_running_loop().call_later(0.25, self._flush_presence)

    def _flush_presence(self) -> None:
        self._presence_handle = None
        rows = []
        for p in self.players.values():
            if not p.online:
                continue
            row = {"id": p.id, "name": p.name, "color": p.color, "avatar": p.avatar, "status": "home"}
            r = p.room
            if r is not None:
                row["status"] = "playing" if r.state == "playing" else "room"
                row["game"] = r.game_id
                g = self.games.get(r.game_id)
                if r.state == "lobby" and g and len(r.members) < min(ROOM_MAX, g.max_players):
                    row["room"] = r.code           # joinable from the online list
            rows.append(row)
        text = dumps({"t": "presence", "players": rows})
        for p in self.players.values():
            p.send(text)

    # ----------------------------------------------------------- rooms
    def room_view(self, room: Room) -> dict:
        members = []
        for pid, m in room.members.items():
            p = self.players[pid]
            is_npc = getattr(p, "is_npc", False)
            members.append({"id": pid, "name": p.name, "avatar": p.avatar, "color": m.color,
                            "ready": m.ready or pid == room.host or is_npc, "online": p.online or is_npc,
                            "wins": m.wins, "is_npc": is_npc})
        ok, why = self._can_start(room)
        has_npc = any(getattr(self.players[pid], "is_npc", False) for pid in room.members)
        return {"code": room.code, "game": room.game_id, "host": room.host, "state": room.state,
                "members": members, "can_start": ok, "why": why, "has_npc": has_npc}

    def _broadcast_room(self, room: Room) -> None:
        text = dumps({"t": "room", "room": self.room_view(room)})
        for pid in room.members:
            self.players[pid].send(text)

    def _can_start(self, room: Room) -> tuple[bool, str]:
        g = self.games.get(room.game_id)
        if room.state != "lobby":
            return False, "A round is in progress"
        if not g or not g.ready:
            return False, "This game isn't available yet"
        n = len(room.members)
        if n < g.min_players:
            need = g.min_players - n
            return False, f"Waiting for {need} more player{'s' if need > 1 else ''}"
        if n > min(ROOM_MAX, g.max_players):
            return False, f"Too many players for this game (max {g.max_players})"
        for pid, m in room.members.items():
            p = self.players[pid]
            if not p.online and not getattr(p, "is_npc", False):
                return False, f"{p.name} is offline"
        for pid, m in room.members.items():
            if pid != room.host and not m.ready and not getattr(self.players[pid], "is_npc", False):
                return False, f"Waiting for {self.players[pid].name} to get ready"
        return True, ""

    def _new_code(self) -> str:
        for _ in range(200):
            code = "".join(random.choice(CODE_ALPHABET) for _ in range(4))
            if code not in self.rooms:
                return code
        raise UserError("Could not make a room code, try again.")

    @staticmethod
    def _free_color(room: Room, preferred: int) -> int:
        used = {m.color for m in room.members.values()}
        if preferred not in used:
            return preferred
        for c in range(PALETTE):
            if c not in used:
                return c
        return preferred

    def h_create(self, p: Player, msg: dict) -> None:
        game_id = str(msg.get("game") or "")
        g = self.games.get(game_id)
        if not g or not g.ready:
            raise UserError("That game isn't available yet.", "no_game")
        self._leave_room(p)
        room = Room(self._new_code(), game_id, p.id)
        room.members[p.id] = Member(p.id, p.color)
        self.rooms[room.code] = room
        p.room = room
        self.log(f"{p.name} created room {room.code} ({g.manifest.get('name', game_id)})")
        self._broadcast_room(room)
        self._presence_dirty()

    def h_join(self, p: Player, msg: dict) -> None:
        code = re.sub(r"[^A-Za-z]", "", str(msg.get("code") or "")).upper()
        room = self.rooms.get(code)
        if not room:
            raise UserError(f"No room with code {code or '????'}. Check the letters and try again.", "no_room")
        if p.room is room:
            self._broadcast_room(room)
            return
        if room.state != "lobby":
            raise UserError("That room is mid-round. Try again when it ends.", "in_progress")
        g = self.games.get(room.game_id)
        if len(room.members) >= min(ROOM_MAX, g.max_players if g else ROOM_MAX):
            raise UserError("That room is full.", "full")
        self._leave_room(p)
        room.members[p.id] = Member(p.id, self._free_color(room, p.color))
        p.room = room
        self.log(f"{p.name} joined room {room.code}")
        self._broadcast_room(room)
        self._presence_dirty()

    def h_leave(self, p: Player, msg: dict) -> None:
        self._leave_room(p)

    def _leave_room(self, p: Player) -> None:
        room = p.room
        if room is None:
            return
        p.room = None
        room.members.pop(p.id, None)
        room.pending.discard(p.id)
        self.log(f"{p.name} left room {room.code}")
        if room.state == "playing" and room.ctx and not room.ctx.done:
            if room.started:
                room.ctx._run(room.game.on_leave, p.id)
            g = self.games.get(room.game_id)
            if not room.ctx.done and g and len(room.members) < g.min_players:
                room.ctx.abort("Not enough players left to continue.")
            elif not room.started and not room.pending and room.members:
                self._begin_game(room, room.run)
        if not room.members:
            self._destroy_room(room)
        else:
            if room.host == p.id:
                self._pick_host(room)
            self._broadcast_room(room)
        p.send({"t": "room", "room": None})
        self._presence_dirty()

    def _pick_host(self, room: Room) -> None:
        for pid in room.members:
            p = self.players.get(pid)
            if p and p.online and not getattr(p, "is_npc", False):
                room.host = pid
                return
        # Only NPCs remain (or no human players)
        self._destroy_room(room)

    def _destroy_room(self, room: Room) -> None:
        for pid in list(room.members):
            if pid.startswith("npc_") or getattr(self.players.get(pid), "is_npc", False):
                self.players.pop(pid, None)
        if room.load_timer:
            room.load_timer.cancel()
            room.load_timer = None
        ctx = room.ctx
        if ctx is not None:
            ctx.done = True
            ctx._cancel_timers()
            self._stop_game_safely(room)
        self.rooms.pop(room.code, None)
        self.log(f"room {room.code} closed")

    def h_ready(self, p: Player, msg: dict) -> None:
        room = self._need_room(p)
        if room.state != "lobby":
            return
        room.members[p.id].ready = bool(msg.get("ready"))
        self._broadcast_room(room)

    def h_select(self, p: Player, msg: dict) -> None:
        room = self._need_room(p)
        if room.host != p.id:
            raise UserError("Only the host can change the game.")
        if room.state != "lobby":
            raise UserError("Wait for the round to finish first.")
        game_id = str(msg.get("game") or "")
        g = self.games.get(game_id)
        if not g or not g.ready:
            raise UserError("That game isn't available yet.", "no_game")
        if len(room.members) > min(ROOM_MAX, g.max_players):
            raise UserError(f"{g.manifest.get('name', game_id)} supports up to {g.max_players} players.")
        room.game_id = game_id
        for m in room.members.values():
            m.ready = False
        self._broadcast_room(room)
        self._presence_dirty()

    def _need_room(self, p: Player) -> Room:
        if p.room is None:
            raise UserError("You're not in a room.", "no_room")
        return p.room

    # ------------------------------------------------------ game lifecycle
    def h_npc(self, p: Player, msg: dict) -> None:
        room = self._need_room(p)
        if room.host != p.id:
            raise UserError("Only the host can manage test NPCs.", "not_host")
        if room.state != "lobby":
            raise UserError("Wait for the round to finish first.", "in_progress")
        action = msg.get("action", "add")
        g = self.games.get(room.game_id)
        max_p = min(ROOM_MAX, g.max_players if g else ROOM_MAX)

        if action == "add":
            if len(room.members) >= max_p:
                raise UserError(f"Room is full (max {max_p} players).", "full")
            npc_num = len([m for m in room.members if m.startswith("npc_")]) + 1
            npc_names = ["Idle Bot", "Dummy NPC", "Sleepy Bot", "Test Drone", "AFK Bot"]
            name = npc_names[(npc_num - 1) % len(npc_names)]
            if npc_num > len(npc_names):
                name = f"{name} {npc_num}"
            npc_pid = f"npc_{secrets.token_hex(3)}"
            npc = Player(npc_pid, "npc_token")
            npc.name = name
            npc.avatar = 7  # Jelly Bot
            npc.is_npc = True
            npc.color = self._free_color(room, (p.color + npc_num) % PALETTE)
            self.players[npc_pid] = npc

            member = Member(npc_pid, npc.color)
            member.ready = True
            room.members[npc_pid] = member
            self.log(f"{p.name} added test NPC {npc.name} to room {room.code}")
            self._broadcast_room(room)
            self._presence_dirty()

        elif action == "remove":
            npcs = [pid for pid in room.members if pid.startswith("npc_") or getattr(self.players.get(pid), "is_npc", False)]
            if npcs:
                target_pid = npcs[-1]
                room.members.pop(target_pid, None)
                self.players.pop(target_pid, None)
                self.log(f"{p.name} removed test NPC {target_pid} from room {room.code}")
                self._broadcast_room(room)
                self._presence_dirty()

        elif action == "clear":
            npcs = [pid for pid in list(room.members) if pid.startswith("npc_") or getattr(self.players.get(pid), "is_npc", False)]
            for pid in npcs:
                room.members.pop(pid, None)
                self.players.pop(pid, None)
            self.log(f"{p.name} cleared test NPCs from room {room.code}")
            self._broadcast_room(room)
            self._presence_dirty()

    def h_start(self, p: Player, msg: dict) -> None:
        room = self._need_room(p)
        if room.host != p.id:
            raise UserError("Only the host can start the game.")
        ok, why = self._can_start(room)
        if not ok:
            raise UserError(why, "cant_start")
        info = self.games[room.game_id]
        players = [{"id": pid, "name": self.players[pid].name, "color": m.color,
                    "avatar": self.players[pid].avatar, "slot": i,
                    "is_npc": getattr(self.players[pid], "is_npc", False)}
                   for i, (pid, m) in enumerate(room.members.items())]
        ctx = GameContext(self, room, players)
        try:
            game = info.cls(ctx)
        except Exception:
            traceback.print_exc()
            raise UserError("That game crashed while starting. Check the Termux window.")
        room.run += 1
        room.state = "playing"
        room.started = False
        room.ctx, room.game = ctx, game
        room.pending = {pid for pid in room.members if self.players[pid].online and not getattr(self.players[pid], "is_npc", False)}
        self.log(f"room {room.code}: starting {info.id} with {len(players)} players")
        text = dumps({"t": "game.start", "game": room.game_id, "run": room.run, "players": players, "resume": False})
        for pid in room.members:
            self.players[pid].send(text)
        self._broadcast_room(room)
        self._presence_dirty()
        room.load_timer = asyncio.get_running_loop().call_later(LOAD_TIMEOUT, self._begin_game, room, room.run)

    def h_loaded(self, p: Player, msg: dict) -> None:
        room = p.room
        if room is None or room.state != "playing" or not room.ctx or room.ctx.done:
            return
        if room.started:
            room.ctx._run(room.game.on_reconnect, p.id)
        else:
            room.pending.discard(p.id)
            if not room.pending:
                self._begin_game(room, room.run)

    def _begin_game(self, room: Room, run: int) -> None:
        if (self.rooms.get(room.code) is not room or room.run != run
                or room.state != "playing" or room.started or not room.ctx or room.ctx.done):
            return
        if room.load_timer:
            room.load_timer.cancel()
            room.load_timer = None
        room.started = True
        room.ctx._run(room.game.start)

    def h_game(self, p: Player, msg: dict) -> None:
        room = p.room
        if room is None or room.state != "playing" or not room.started or not room.ctx or room.ctx.done:
            return
        data = msg.get("d")
        if isinstance(data, dict):
            room.ctx._run(room.game.on_message, p.id, data)

    def _stop_game_safely(self, room: Room) -> None:
        game = room.game
        if game is None:
            return
        try:
            game.stop()
        except Exception:
            traceback.print_exc()
        finally:
            room.game = None

    def _end_round(self, room: Room, ctx: GameContext) -> bool:
        """Common teardown. Returns False if this round is already gone."""
        if room.ctx is not ctx or self.rooms.get(room.code) is not room:
            return False
        ctx._cancel_timers()
        if room.load_timer:
            room.load_timer.cancel()
            room.load_timer = None
        self._stop_game_safely(room)
        room.ctx = None
        room.state = "lobby"
        room.started = False
        room.pending = set()
        for m in room.members.values():
            if getattr(self.players.get(m.pid), "is_npc", False):
                m.ready = True
            else:
                m.ready = False
        return True

    def _finish_game(self, room: Room, ctx: GameContext, scores, winners, title, notes) -> None:
        if not self._end_round(room, ctx):
            return
        rows = []
        for pl in ctx.players:
            sc = (scores or {}).get(pl["id"], 0)
            if not isinstance(sc, (int, float)):
                sc = 0
            rows.append({"id": pl["id"], "name": pl["name"], "color": pl["color"], "avatar": pl["avatar"],
                         "score": round(sc, 2) if isinstance(sc, float) else sc,
                         "note": str((notes or {}).get(pl["id"], ""))})
        rows.sort(key=lambda r: -r["score"])      # stable: ties keep seat order
        rank, prev = 0, object()
        for i, r in enumerate(rows):
            if r["score"] != prev:
                rank, prev = i + 1, r["score"]
            r["rank"] = rank
        if winners is None:
            winners = [r["id"] for r in rows if r["rank"] == 1]
        for pid in winners:
            m = room.members.get(pid)
            if m:
                m.wins += 1
        results = {"game": room.game_id, "title": title, "ranking": rows, "winners": list(winners)}
        self.log(f"room {room.code}: round finished, winner(s): "
                 f"{', '.join(r['name'] for r in rows if r['id'] in winners) or 'none'}")
        text = dumps({"t": "game.end", "results": results})
        for pid in room.members:
            self.players[pid].send(text)
        self._broadcast_room(room)
        self._presence_dirty()

    def _abort_game(self, room: Room, ctx: GameContext, reason: str) -> None:
        if not self._end_round(room, ctx):
            return
        self.log(f"room {room.code}: round aborted ({reason})")
        text = dumps({"t": "game.abort", "reason": reason})
        for pid in room.members:
            self.players[pid].send(text)
        self._broadcast_room(room)
        self._presence_dirty()

    # ---------------------------------------------------------------- misc
    def h_ping(self, p: Player, msg: dict) -> None:
        p.send({"t": "pong", "c": msg.get("c")})
