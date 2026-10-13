"""The contract every game follows. Copy games/warmup/ to start a new game.

A game lives in games/<id>/ and has:

    manifest.json   name, tagline, how-to (2 sentences), min/max players, "ready": true
    server.py       defines `class Game(BaseGame)`  (authoritative game logic, runs on the host phone)
    client.js       calls Arcade.registerGame('<id>', {...})  (draws the game in the browser)
    style.css       optional, loaded automatically when manifest has "css": true
    card.svg        art for the game picker

The server never awaits inside game code: handlers are plain synchronous functions, and
timing is done with ctx.later() / ctx.every(), which are cleaned up automatically.

ctx (GameContext) gives you:
    ctx.players               [{id, name, color, avatar, slot}] fixed for the whole round
    ctx.player_ids            just the ids
    ctx.rng                   a random.Random for this round
    ctx.now()                 monotonic seconds
    ctx.send(pid, data)       message one player      (data = any JSON-able dict)
    ctx.broadcast(data)       message everyone in the round
    ctx.is_connected(pid)     is that player's socket currently up?
    ctx.later(sec, fn, *args) -> Timer   (call .cancel() to stop it)
    ctx.every(sec, fn, *args) -> Timer   fixed-rate ticker, skips ahead instead of piling up
    ctx.finish(scores, winners=None, title=None, notes=None)
                              ends the round; scores = {pid: number}, higher is better
    ctx.abort(reason)         cancels the round and returns everyone to the room

BaseGame also gives you a few helpers so games don't each re-invent them:
    self.here                 set of player ids still in the round (kept up to date by on_leave)
    self.gone()               ids of players who left for good (handy in sync/reveal messages)
    self.set_timer(sec, fn)   your one "main" timer: setting a new one cancels the previous one
    self.countdown(then)      broadcasts {k:'count', n:3..1} once a second, then calls then()
    self.int_in(v, lo, hi)    v if it is a real int in [lo, hi) else None (for validating client input)
    self.gone_extra()         override to add fields to the {k:'gone', id} message sent on leave

(If your game defines its own __init__, call super().__init__(ctx) first so self.here exists.)
"""
from __future__ import annotations


class BaseGame:
    def __init__(self, ctx):
        self.ctx = ctx
        self.here = set(ctx.player_ids)    # players still in the round (not left for good)
        self.timer = None                  # the main timer managed by set_timer()

    # ----------------------------------------------------------- helpers
    @staticmethod
    def int_in(v, lo: int, hi: int):
        """v if it is a genuine int in [lo, hi), else None. (bool is an int subclass, so the
        exact type is checked: a client sending true/false must not pass as 1/0.)"""
        return v if type(v) is int and lo <= v < hi else None

    def gone(self) -> list:
        """Ids of players who left for good, in seat order."""
        return [pid for pid in self.ctx.player_ids if pid not in self.here]

    def set_timer(self, delay: float, fn, *args):
        """Run fn(*args) after delay seconds, replacing any timer set before with set_timer()."""
        if self.timer:
            self.timer.cancel()
        self.timer = self.ctx.later(delay, fn, *args)
        return self.timer

    def countdown(self, then, steps: int = 3) -> None:
        """Broadcast {k:'count', n:steps}..{n:1} one second apart, then call then()."""
        ctx = self.ctx
        ctx.broadcast({"k": "count", "n": steps})
        for i in range(1, steps):
            ctx.later(i, ctx.broadcast, {"k": "count", "n": steps - i})
        ctx.later(steps, then)

    def gone_extra(self) -> dict:
        """Extra fields for the {k:'gone', id} broadcast sent when someone leaves for good."""
        return {}

    # --------------------------------------------------- lifecycle hooks

    def start(self):
        """Called once every client has loaded the game (or after a short timeout)."""

    def on_message(self, pid: str, data: dict):
        """A player sent {t:'g', d:data} from client.js via api.send(data)."""

    def on_disconnect(self, pid: str):
        """A player's connection dropped. They have ~90 s to come back."""

    def on_reconnect(self, pid: str):
        """A player is back (or reloaded their page). Send them the full current state."""

    def on_leave(self, pid: str):
        """A player left for good (pressed Leave, or never came back).

        The default removes them from self.here and broadcasts {k:'gone', id, ...gone_extra()}.
        Override it to do more, and call super().on_leave(pid) to keep that behaviour."""
        self.here.discard(pid)
        self.ctx.broadcast({"k": "gone", "id": pid, **self.gone_extra()})

    def stop(self):
        """Round over or aborted. Timers are cancelled for you; free anything else here."""
