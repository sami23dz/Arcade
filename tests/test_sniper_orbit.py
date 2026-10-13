"""Test Sniper Orbit rules and line-of-sight: python tests/test_sniper_orbit.py"""
import heapq
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from games.sniper_orbit import server as so
from games.sniper_orbit.server import Game


class Timer:
    def __init__(self, at, fn):
        self.at, self.fn, self.dead = at, fn, False

    def cancel(self):
        self.dead = True


class Ctx:
    def __init__(self, n=2, seed=1):
        self.player_ids = [f"p{i}" for i in range(n)]
        self.players = [{"id": pid} for pid in self.player_ids]
        self.rng = random.Random(seed)
        self.sent, self.t, self.fin = [], 0.0, None
        self.queue, self.seq = [], 0

    def broadcast(self, data, exclude=None):
        self.sent.append(("*", data))

    def send(self, pid, data):
        self.sent.append((pid, data))

    def later(self, delay, fn, *args):
        timer = Timer(self.t + delay, lambda: fn(*args))
        self.seq += 1
        heapq.heappush(self.queue, (timer.at, self.seq, timer))
        return timer

    def every(self, delay, fn, *args):
        return Timer(self.t + delay, lambda: fn(*args))

    def now(self):
        return self.t

    def finish(self, scores, winners=None, title=None, notes=None):
        self.fin = (scores, winners, title, notes)

    def advance(self, dt):
        end = self.t + dt
        while self.queue and self.queue[0][0] <= end:
            at, _, timer = heapq.heappop(self.queue)
            self.t = at
            if not timer.dead:
                timer.fn()
        self.t = end

    def messages(self, kind, to=None):
        return [data for pid, data in self.sent
                if data.get("k") == kind and (to is None or pid == to)]

    def last(self, kind, to=None):
        return self.messages(kind, to)[-1]


fails = 0


def check(name, condition):
    global fails
    print(("ok   " if condition else "FAIL ") + name)
    fails += not condition


ctx = Ctx(2)
game = Game(ctx)
game.start()
check("starts with a countdown", len(ctx.messages("count")) == 1)

# Advance past countdown
ctx.advance(3.0)
check("countdown starts the 90-second round", game.phase == "play" and game.t_end == 93.0)
check("assigns player 0 as Sniper and player 1 as Runner", game.sniper_id == "p0" and "p1" in game.runner_ids)
check("selects 4 random sectors", len(game.sectors) == 4)
check("generates strategic cover obstacles", len(game.obstacles) >= 12)

# Runner moves forward along the orbit
r = game.runners["p1"]
init_angle = r["angle"]
game.on_message("p1", {"k": "move", "drive": 1.0, "stance": "sprint"})
game._tick()
check("runner advances along orbital angle", game.runners["p1"]["angle"] > init_angle)
check("runner stance changes to sprint", game.runners["p1"]["stance"] == "sprint")

# Runner changes stance to crawl
game.on_message("p1", {"k": "move", "drive": 1.0, "stance": "crawl"})
check("runner stance changes to crawl", game.runners["p1"]["stance"] == "crawl")

# Cover line-of-sight test
# Place an obstacle directly in front of runner
obs = game.obstacles[0]
is_blocked, hit_obs = game._check_cover_blocks(obs["angle"], 0.0, runner_height=0.65)
check("crawling behind low cover blocks sniper line-of-sight", is_blocked and hit_obs is not None)

# Sniper fires while runner is behind cover
game.sniper["yaw"] = obs["angle"]
game.sniper["ammo"] = 5
game.on_message("p0", {"k": "shoot"})
shot_msg = ctx.last("sniper_shot")
check("shot is recorded with ammo consumption", shot_msg["ammo_left"] == 4)

# Open gap shot eliminates runner
game.obstacles = []  # Clear obstacles for open gap test
game.runners["p1"]["angle"] = 1.0
game.sniper["yaw"] = 1.0
game.sniper["ready_at"] = 0.0
game.on_message("p0", {"k": "shoot", "yaw": 1.0, "pitch": -0.15})
kill_shot = ctx.last("sniper_shot")
check("unobstructed shot hits runner", kill_shot["hit"] == "p1")
check("hit runner is eliminated", game.runners["p1"]["alive"] is False)
check("sniper wins when all runners are down", game.phase == "done")

# Dev role swap test with NPC
ctx2 = Ctx(2)
ctx2.players = [{"id": "p0", "name": "Host", "is_npc": False}, {"id": "npc_1", "name": "Idle Bot", "is_npc": True}]
ctx2.player_ids = ["p0", "npc_1"]
game2 = Game(ctx2)
game2.start()
ctx2.advance(3.0)
check("initial roles: host is sniper, npc is runner", game2.sniper_id == "p0" and "npc_1" in game2.runner_ids)

# Host requests role swap with NPC
game2.on_message("p0", {"k": "swap_role"})
check("after swap: host is runner, npc is sniper", game2.sniper_id == "npc_1" and "p0" in game2.runner_ids)
check("host runner state initialized", "p0" in game2.runners and game2.runners["p0"]["alive"])
check("npc removed from runners map", "npc_1" not in game2.runners)

# Swap back
game2.on_message("p0", {"k": "swap_role"})
check("swap back: host is sniper, npc is runner", game2.sniper_id == "p0" and "npc_1" in game2.runner_ids)
check("npc runner state initialized", "npc_1" in game2.runners and game2.runners["npc_1"]["alive"])

# Reconnect test
game2.on_reconnect("p0")
sync_msg = ctx2.last("sync", to="p0")
check("sync message contains sniper and runners", sync_msg["sniper_id"] == "p0" and len(sync_msg["runners"]) == 1)

print(f"\nFAILURES: {fails}")
sys.exit(1 if fails else 0)
