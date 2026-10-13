"""Hush Heist: one secret Guard watches 2 of 6 vaults, everyone else secretly robs one.

Round flow:  intro (who is the Guard) -> pick (10 s) -> reveal -> next round.
Everyone is the Guard equally often, so the game lasts 4-6 rounds whatever the player count.

Scoring (vault loot values are public and change every round):
    Robber, vault unwatched and alone .... + that vault's loot
    Robber, vault watched ................ 0, caught (the Guard gets that loot for every robber caught)
    Robber, vault shared with a rival .... 0, bounced (nobody gets it)
    Anyone who never picked .............. 0

Secrecy: nobody's pick is sent to anybody until the reveal. During the round the server only
says WHO has locked in, never WHAT they chose.

Picks can be changed freely until the player locks in. If time runs out, an unlocked pick still
counts. The round ends early as soon as everybody who is here has locked in.
"""
from core.game_api import BaseGame

VAULTS = 6
WATCH = 2
LOOT = [1, 2, 2, 3, 4, 5]    # shuffled onto the six vaults every round
INTRO = 2.4                  # "X is the Guard"
PICK = 10.0                  # seconds to choose
SETTLE = 0.8                 # short pause after everybody has locked in
REVEAL = 5.5                 # seconds the result stays on screen
MIN_ROUNDS = 4


class Game(BaseGame):
    # ------------------------------------------------------------------ setup
    def start(self):
        ctx = self.ctx
        n = len(ctx.player_ids)
        self.order = list(ctx.player_ids)
        ctx.rng.shuffle(self.order)
        self.rounds = n * max(1, -(-MIN_ROUNDS // n))      # everybody guards equally often
        self.score = {pid: 0 for pid in ctx.player_ids}
        self.caught_total = {pid: 0 for pid in ctx.player_ids}
        self.round = 0
        self.phase = "wait"
        self.guard = None
        self.loot = [0] * VAULTS
        self.rob = {}                                      # robber -> vault (may be unlocked)
        self.watch_sel = []                                # guard's current picks (0-2 vaults)
        self.locked = set()
        self.t_end = 0.0
        self.last_reveal = None
        self.next_round()

    def _guard_for(self, round_no):
        n = len(self.order)
        for i in range(n):
            pid = self.order[(round_no - 1 + i) % n]
            if pid in self.here:
                return pid
        return self.order[0]

    # ----------------------------------------------------------------- rounds
    def next_round(self):
        ctx = self.ctx
        if self.round >= self.rounds:
            self._end()
            return
        self.round += 1
        self.guard = self._guard_for(self.round)
        self.loot = LOOT[:]
        ctx.rng.shuffle(self.loot)
        self.rob = {}
        self.watch_sel = []
        self.locked = set()
        self.last_reveal = None
        self.phase = "intro"
        ctx.broadcast({"k": "round", "r": self.round, "of": self.rounds, "guard": self.guard,
                       "loot": self.loot, "s": self.score, "gone": self.gone()})
        self.set_timer(INTRO, self._open)

    def _open(self):
        self.phase = "pick"
        self.t_end = self.ctx.now() + PICK
        self.ctx.broadcast({"k": "open", "dur": PICK})
        self.set_timer(PICK, self._resolve)
        self._check_done()

    def _needed(self):
        """Players the round waits for: the Guard, plus every robber whose phone is connected."""
        ctx = self.ctx
        is_bot = lambda pid: getattr(getattr(ctx, "hub", None) and ctx.hub.players.get(pid), "is_npc", False)
        need = [pid for pid in self.here if pid != self.guard and ctx.is_connected(pid) and not is_bot(pid)]
        if self.guard in self.here and not is_bot(self.guard):
            need.append(self.guard)
        return need

    def _check_done(self):
        if self.phase != "pick":
            return
        need = self._needed()
        if need and all(pid in self.locked for pid in need):
            self.set_timer(SETTLE, self._resolve)

    def _locked_ids(self):
        return [pid for pid in self.locked if pid in self.here]

    # --------------------------------------------------------------- messages
    def on_message(self, pid, data):
        if self.phase != "pick" or pid not in self.here or pid in self.locked:
            return
        k = data.get("k")
        v = data.get("v")
        if k == "lock":
            ok = len(self.watch_sel) == WATCH if pid == self.guard else pid in self.rob
            if not ok:
                return
            self.locked.add(pid)
            self.ctx.broadcast({"k": "locked", "ids": self._locked_ids()})
            self._check_done()
        elif k == "watch" and pid == self.guard:
            if not isinstance(v, list) or len(v) > WATCH:
                return
            picks = []
            for x in v:
                x = self.int_in(x, 0, VAULTS)
                if x is None or x in picks:
                    return
                picks.append(x)
            self.watch_sel = picks
        elif k == "rob" and pid != self.guard:
            v = self.int_in(v, 0, VAULTS)
            if v is not None:
                self.rob[pid] = v

    # ----------------------------------------------------------------- reveal
    def _resolve(self):
        if self.phase != "pick":
            return
        self.phase = "reveal"
        ctx = self.ctx

        # Guard who picked fewer than two vaults gets random ones; a Guard who picked none earns nothing.
        watch = list(self.watch_sel)
        asleep = not watch
        pool = [v for v in range(VAULTS) if v not in watch]
        ctx.rng.shuffle(pool)
        watch += pool[:WATCH - len(watch)]
        watch.sort()

        robbers = [pid for pid in ctx.player_ids if pid in self.here and pid != self.guard]
        crowd = {}
        for pid in robbers:
            v = self.rob.get(pid)
            if v is not None:
                crowd.setdefault(v, []).append(pid)

        out, recovered, caught_n = {}, 0, 0
        for pid in robbers:
            v = self.rob.get(pid)
            if v is None:
                out[pid] = {"o": "idle", "v": None, "pts": 0}
            elif v in watch:
                out[pid] = {"o": "caught", "v": v, "pts": 0}
                recovered += self.loot[v]
                caught_n += 1
            elif len(crowd[v]) > 1:
                out[pid] = {"o": "bounce", "v": v, "pts": 0}
            else:
                pts = self.loot[v]
                out[pid] = {"o": "loot", "v": v, "pts": pts}
                self.score[pid] += pts
        if self.guard in self.here:
            pts = 0 if asleep else recovered
            self.score[self.guard] += pts
            self.caught_total[self.guard] += caught_n
            out[self.guard] = {"o": "guard", "v": None, "pts": pts, "caught": caught_n, "asleep": asleep}

        self.last_reveal = {"k": "reveal", "watch": watch, "out": out, "s": dict(self.score),
                            "gone": self.gone()}
        ctx.broadcast(self.last_reveal)
        self.set_timer(REVEAL, self.next_round)

    def _end(self):
        self.phase = "done"
        notes = {pid: f"{pts} loot" for pid, pts in self.score.items()}
        self.ctx.finish(dict(self.score), None, "Hush Heist", notes)

    # ------------------------------------------------------ connection events
    def on_disconnect(self, pid):
        self._check_done()                 # stop waiting for a robber who dropped

    def on_reconnect(self, pid):
        left = max(0.0, self.t_end - self.ctx.now()) if self.phase == "pick" else 0.0
        mine = None
        if pid == self.guard:
            mine = list(self.watch_sel)
        elif pid in self.rob:
            mine = self.rob[pid]
        self.ctx.send(pid, {"k": "sync", "phase": self.phase, "r": self.round, "of": self.rounds,
                            "guard": self.guard, "loot": self.loot, "s": self.score,
                            "locked": self._locked_ids(), "mine": mine, "left": round(left, 1),
                            "gone": self.gone(), "reveal": self.last_reveal if self.phase == "reveal" else None})

    def on_leave(self, pid):
        self.rob.pop(pid, None)
        self.locked.discard(pid)
        super().on_leave(pid)              # drops them from self.here and tells everyone
        self._check_done()
