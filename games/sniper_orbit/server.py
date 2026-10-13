"""Sniper Orbit: 1 Sniper in the center tower vs Runners orbiting 360 degrees."""
from __future__ import annotations

import math
import random
import time
from core.game_api import BaseGame

TRACK_RADIUS = 36.0       # Radius of orbital track from tower in meters
TRACK_WIDTH = 6.0         # Lateral width of the track (+- 3m)
TOWER_HEIGHT = 7.5        # Height of the sniper tower
ROUND_TIME = 90.0         # Seconds per round
TICK = 0.08               # Server tick rate (~12.5 Hz)
BOLT_CYCLE = 1.3          # Seconds between sniper shots
MAGAZINE_SIZE = 5         # Ammo before reload
RELOAD_TIME = 2.4         # Seconds to reload
FULL_ORBIT = math.pi * 2  # 360 degrees

BIOMES = [
    {
        "id": "desert", "name": "Desert Dunes", "color": "#ffaa33",
        "ground": "#3d2b17", "accent": "#f5c542", "sky": "#2b1910",
        "low_cover": "Sand Dune", "high_cover": "Pillar Ruins",
    },
    {
        "id": "lava", "name": "Volcanic Core", "color": "#ff453a",
        "ground": "#260e12", "accent": "#ff6955", "sky": "#1a080c",
        "low_cover": "Basalt Slab", "high_cover": "Obsidian Column",
    },
    {
        "id": "plains", "name": "Verdant Plains", "color": "#30d158",
        "ground": "#132b18", "accent": "#5ee67f", "sky": "#0c1f11",
        "low_cover": "Stone Wall", "high_cover": "Ancient Megalith",
    },
    {
        "id": "ice", "name": "Glacial Ridge", "color": "#64d2ff",
        "ground": "#122736", "accent": "#a6e5ff", "sky": "#091724",
        "low_cover": "Ice Block", "high_cover": "Glacier Spire",
    },
    {
        "id": "cyber", "name": "Neon Grid", "color": "#bf5af2",
        "ground": "#1d1136", "accent": "#e085ff", "sky": "#120824",
        "low_cover": "Cyber Crate", "high_cover": "Holo Pylon",
    },
    {
        "id": "canyon", "name": "Red Canyon", "color": "#ff9f0a",
        "ground": "#3d1e13", "accent": "#ffbc52", "sky": "#261009",
        "low_cover": "Terracotta Crag", "high_cover": "Mesa Monolith",
    },
]

STANCE_SPEEDS = {
    "crawl": 2.1,   # Slowest, lowest profile (0.65m) - safe behind low cover
    "walk": 3.9,    # Steady (1.6m)
    "sprint": 6.8,  # Fast, full standing height (1.85m)
    "jump": 5.4,    # Leaping forward (height up to 2.4m)
}

STANCE_HEIGHTS = {
    "crawl": 0.65,
    "walk": 1.60,
    "sprint": 1.85,
    "jump": 2.35,
}


class Game(BaseGame):
    def start(self):
        ctx = self.ctx
        self.phase = "count"
        self.started_at = 0.0
        self.t_end = 0.0

        pids = list(ctx.player_ids)
        # Select 1 player as Sniper; the rest are Runners
        # In a 2+ player game, player 0 is sniper; for solo drill, player 0 is runner and a dummy sniper operates
        if len(pids) >= 2:
            self.sniper_id = pids[0]
            self.runner_ids = pids[1:]
        else:
            self.sniper_id = None
            self.runner_ids = pids

        # Pick 4 random distinct biomes for the 4 orbital sectors
        rng = random.Random(ctx.now())
        self.sectors = rng.sample(BIOMES, 4)

        # Generate cover obstacles along the 360 degree circle
        self.obstacles = self._generate_obstacles(rng)

        # Initialize Sniper State
        self.sniper = {
            "yaw": 0.0,
            "pitch": -0.15,
            "zoom": 1.0,
            "ammo": MAGAZINE_SIZE,
            "ready_at": 0.0,
            "reloading": False,
            "shots_fired": 0,
            "hits": 0,
        }

        # Initialize Runners State
        self.runners = {}
        for i, pid in enumerate(self.runner_ids):
            # Spread runners slightly at the starting line (theta ~ 0.18)
            start_angle = 0.18 + (i * 0.05)
            self.runners[pid] = {
                "id": pid,
                "angle": start_angle,
                "lane": -1.5 + (i * 1.0),
                "speed": 0.0,
                "lateral_speed": 0.0,
                "stance": "walk",
                "hp": 100,
                "alive": True,
                "escaped": False,
                "jump_until": 0.0,
            }

        self.scores = {pid: 0 for pid in ctx.player_ids}
        self.countdown(self._go)

    def _generate_obstacles(self, rng):
        obstacles = []
        # 4 sectors, each spanning pi / 2 radians (90 deg)
        for s_idx, sector in enumerate(self.sectors):
            s_start = s_idx * (FULL_ORBIT / 4.0)
            # Create 4 to 5 obstacles per sector with strategic spacing
            count = rng.randint(4, 5)
            for j in range(count):
                angle_offset = (j + 0.5) * (FULL_ORBIT / (4.0 * (count + 0.5))) + rng.uniform(-0.04, 0.04)
                obs_angle = s_start + angle_offset
                if obs_angle >= FULL_ORBIT - 0.15:
                    continue  # Keep the finish line extraction zone clear

                is_high = (j % 2 == 1)
                height = 2.8 if is_high else 1.35
                lane_offset = rng.uniform(-2.0, 2.0)
                width_ang = rng.uniform(0.045, 0.075)   # Angular span (~2.5 to 4.5 degrees)
                depth_rad = round(rng.uniform(1.2, 1.8), 2)

                obstacles.append({
                    "id": f"obs_{s_idx}_{j}",
                    "sector": s_idx,
                    "theme": sector["id"],
                    "angle": obs_angle,
                    "lane": lane_offset,
                    "depth_rad": depth_rad,
                    "is_high": is_high,
                    "height": height,
                    "width_ang": width_ang,
                    "name": sector["high_cover"] if is_high else sector["low_cover"],
                    "color": sector["accent"] if is_high else sector["color"],
                })
        return obstacles

    def _go(self):
        self.phase = "play"
        self.started_at = self.ctx.now()
        self.t_end = self.started_at + ROUND_TIME
        self.bot_active = False

        self.ctx.broadcast({
            "k": "go",
            "dur": ROUND_TIME,
            "sniper": self.sniper_id,
            "runners": self.runner_ids,
            "sectors": self.sectors,
            "obstacles": self.obstacles,
        })
        self.ticker = self.ctx.every(TICK, self._tick)
        self._broadcast_state()

    def _tick(self):
        if self.phase != "play":
            return
        now = self.ctx.now()
        if now >= self.t_end:
            self._end("time_up", "Time expired! The Sniper defended the tower.")
            return

        # Advance Runners Movement
        any_escaped = False
        all_down = len(self.runners) > 0

        # Bot simulation if enabled
        bot_active = getattr(self, "bot_active", False)

        for pid, r in self.runners.items():
            if not r["alive"]:
                continue
            all_down = False

            # Active NPC runner behavior
            is_npc = str(pid).startswith("npc_") or any(p.get("is_npc") for p in self.ctx.players if p.get("id") == pid)
            if is_npc and bot_active:
                r["speed"] = 4.6
                r["stance"] = "sprint" if math.sin(now * 2.0) > 0 else "walk"
                r["lateral_speed"] = math.sin(now * 1.5) * 1.8

            # Check jump expiry
            if r["stance"] == "jump" and now >= r["jump_until"]:
                r["stance"] = "run"

            # Angular movement speed based on stance
            linear_speed = r["speed"]
            if linear_speed != 0:
                # v = omega * r -> omega = v / r
                ang_speed = linear_speed / TRACK_RADIUS
                r["angle"] = max(0.02, min(FULL_ORBIT + 0.1, r["angle"] + (ang_speed * TICK)))

            # Lateral movement
            if r["lateral_speed"] != 0:
                r["lane"] = max(-TRACK_WIDTH / 2.0, min(TRACK_WIDTH / 2.0, r["lane"] + (r["lateral_speed"] * TICK)))

            # Check if runner reached the extraction bunker (360 degrees)
            if r["angle"] >= FULL_ORBIT:
                r["escaped"] = True
                any_escaped = True

        if any_escaped:
            self._end("escaped", "Runners reached the extraction bunker! Runners Win!")
            return

        if all_down:
            self._end("wiped", "All runners were eliminated! The Sniper Wins!")
            return

        # Active NPC sniper behavior
        is_sniper_npc = str(self.sniper_id).startswith("npc_") or any(p.get("is_npc") for p in self.ctx.players if p.get("id") == self.sniper_id)
        if is_sniper_npc and bot_active and not self.sniper["reloading"] and now >= self.sniper["ready_at"]:
            # Find a target runner
            for pid, r in self.runners.items():
                if r["alive"] and not r["escaped"]:
                    target_yaw = r["angle"]
                    curr_yaw = self.sniper["yaw"]
                    diff = (target_yaw - curr_yaw + math.pi) % FULL_ORBIT - math.pi
                    self.sniper["yaw"] = (curr_yaw + max(-0.06, min(0.06, diff)) + FULL_ORBIT) % FULL_ORBIT
                    if abs(diff) < 0.08 and random.random() < 0.25:
                        self._handle_sniper_shot()
                    break

        # Check reload timer for sniper
        if self.sniper["reloading"] and now >= self.sniper["ready_at"]:
            self.sniper["reloading"] = False
            self.sniper["ammo"] = MAGAZINE_SIZE
            if self.sniper_id:
                self.ctx.send(self.sniper_id, {"k": "reloaded", "ammo": MAGAZINE_SIZE})

        self._broadcast_state()

    def _broadcast_state(self):
        now = self.ctx.now()
        runner_list = []
        for pid, r in self.runners.items():
            runner_list.append({
                "id": pid,
                "angle": round(r["angle"], 4),
                "lane": round(r["lane"], 2),
                "stance": r["stance"],
                "hp": r["hp"],
                "alive": r["alive"],
                "escaped": r["escaped"],
                "pct": round(min(1.0, r["angle"] / FULL_ORBIT) * 100, 1),
            })

        self.ctx.broadcast({
            "k": "state",
            "phase": self.phase,
            "left": round(max(0.0, self.t_end - now), 1),
            "bot_active": getattr(self, "bot_active", False),
            "sniper": {
                "id": self.sniper_id,
                "yaw": round(self.sniper["yaw"], 4),
                "pitch": round(self.sniper["pitch"], 3),
                "ammo": self.sniper["ammo"],
                "reloading": self.sniper["reloading"],
            },
            "runners": runner_list,
        })

    def on_message(self, pid, data):
        if self.phase != "play":
            return
        kind = data.get("k")

        # Dev role swap with NPC
        if kind == "swap_role":
            for other_id in self.ctx.player_ids:
                is_other_npc = any(p.get("is_npc") for p in self.ctx.players if p.get("id") == other_id) or str(other_id).startswith("npc_")
                if other_id != pid and is_other_npc:
                    if self.sniper_id == pid:
                        # User becomes Runner, NPC becomes Sniper
                        self.sniper_id = other_id
                        self.runner_ids = [pid]
                        self.runners.pop(other_id, None)
                        self.runners[pid] = {
                            "id": pid, "angle": 0.18, "lane": 0.0, "speed": 0.0, "lateral_speed": 0.0,
                            "stance": "walk", "hp": 100, "alive": True, "escaped": False, "jump_until": 0.0
                        }
                    else:
                        # User becomes Sniper, NPC becomes Runner
                        self.sniper_id = pid
                        self.runner_ids = [other_id]
                        self.runners.pop(pid, None)
                        self.runners[other_id] = {
                            "id": other_id, "angle": 0.18, "lane": 0.0, "speed": 0.0, "lateral_speed": 0.0,
                            "stance": "walk", "hp": 100, "alive": True, "escaped": False, "jump_until": 0.0
                        }
                    self.ctx.broadcast({
                        "k": "go",
                        "dur": max(1.0, self.t_end - self.ctx.now()),
                        "sniper": self.sniper_id,
                        "runners": self.runner_ids,
                        "sectors": self.sectors,
                        "obstacles": self.obstacles,
                    })
                    self._broadcast_state()
                    return

        # Dev toggle bot movement
        if kind == "toggle_bot":
            self.bot_active = not getattr(self, "bot_active", False)
            self._broadcast_state()
            return

        # Sniper controls
        if pid == self.sniper_id or (self.sniper_id is None and kind in ("aim", "shoot", "reload")):
            if kind == "aim":
                self.sniper["yaw"] = float(data.get("yaw", self.sniper["yaw"])) % FULL_ORBIT
                self.sniper["pitch"] = max(-0.55, min(0.35, float(data.get("pitch", self.sniper["pitch"]))))
                self.sniper["zoom"] = float(data.get("zoom", 1.0))
            elif kind == "shoot":
                if "yaw" in data:
                    self.sniper["yaw"] = float(data.get("yaw", self.sniper["yaw"])) % FULL_ORBIT
                if "pitch" in data:
                    self.sniper["pitch"] = max(-0.55, min(0.35, float(data.get("pitch", self.sniper["pitch"]))))
                self._handle_sniper_shot()
            elif kind == "reload":
                self._handle_sniper_reload()

        # Runner controls
        if pid in self.runners and self.runners[pid]["alive"]:
            r = self.runners[pid]
            if kind == "move":
                # forward/backward drive: 1 (forward), 0 (stop), -1 (back)
                drive = max(-1.0, min(1.0, float(data.get("drive", 0.0))))
                strafe = max(-1.0, min(1.0, float(data.get("strafe", 0.0))))
                stance = str(data.get("stance", r["stance"]))
                if stance not in STANCE_SPEEDS:
                    stance = "walk"
                r["stance"] = stance
                base_speed = STANCE_SPEEDS[stance]
                r["speed"] = drive * base_speed
                r["lateral_speed"] = strafe * 3.2
            elif kind == "jump":
                now = self.ctx.now()
                if r["stance"] != "jump" and r["stance"] != "crawl":
                    r["stance"] = "jump"
                    r["jump_until"] = now + 0.65
                    self.ctx.broadcast({"k": "runner_jumped", "pid": pid})

    def _handle_sniper_reload(self):
        now = self.ctx.now()
        if self.sniper["reloading"] or self.sniper["ammo"] >= MAGAZINE_SIZE:
            return
        self.sniper["reloading"] = True
        self.sniper["ready_at"] = now + RELOAD_TIME
        self.ctx.broadcast({"k": "sniper_reloading", "dur": RELOAD_TIME})

    def _handle_sniper_shot(self):
        now = self.ctx.now()
        if self.sniper["reloading"] or now < self.sniper["ready_at"] or self.sniper["ammo"] <= 0:
            return

        self.sniper["ammo"] -= 1
        self.sniper["ready_at"] = now + BOLT_CYCLE
        self.sniper["shots_fired"] += 1

        yaw = self.sniper["yaw"]
        pitch = self.sniper["pitch"]

        # Check line-of-sight against all alive runners
        hit_pid = None
        blocked_obs = None
        min_err = 0.065  # Angular tolerance (~3.7 degrees)

        for pid, r in self.runners.items():
            if not r["alive"] or r["escaped"]:
                continue

            # Angular difference between sniper aim and runner
            ang_diff = abs((yaw - r["angle"] + math.pi) % FULL_ORBIT - math.pi)
            if ang_diff > min_err:
                continue

            # Runner is in the sniper's crosshairs! Check if cover blocks the shot
            runner_h = STANCE_HEIGHTS.get(r["stance"], 1.6)
            is_blocked, obs = self._check_cover_blocks(r["angle"], r["lane"], runner_h)
            if is_blocked:
                blocked_obs = obs
            else:
                hit_pid = pid
                break

        # Broadcast the shot fired event
        self.ctx.broadcast({
            "k": "sniper_shot",
            "yaw": yaw,
            "pitch": pitch,
            "hit": hit_pid,
            "blocked_by": blocked_obs["name"] if blocked_obs else None,
            "ammo_left": self.sniper["ammo"],
        })

        if hit_pid:
            self.sniper["hits"] += 1
            r = self.runners[hit_pid]
            r["hp"] -= 100  # Direct sniper hit is lethal
            r["alive"] = False
            self.scores[self.sniper_id or "sniper"] = self.scores.get(self.sniper_id or "sniper", 0) + 100
            self.ctx.broadcast({"k": "runner_down", "pid": hit_pid, "by": self.sniper_id})

            # Check if all runners are now eliminated
            if all(not runner["alive"] for runner in self.runners.values()):
                self._end("wiped", "All runners eliminated! The Sniper Wins!")

        # Auto reload if out of ammo
        if self.sniper["ammo"] <= 0:
            self.sniper["reloading"] = True
            self.sniper["ready_at"] = now + RELOAD_TIME
            self.ctx.broadcast({"k": "sniper_reloading", "dur": RELOAD_TIME})

    def _check_cover_blocks(self, runner_ang, runner_lane, runner_height):
        """Check if any obstacle between sniper tower (0,0,7.5m) and runner blocks line-of-sight."""
        for obs in self.obstacles:
            # Check angular proximity to obstacle
            diff = abs((runner_ang - obs["angle"] + math.pi) % FULL_ORBIT - math.pi)
            if diff > obs["width_ang"]:
                continue

            # Ray travels from tower (z=7.5) to runner (z=runner_height)
            # Distance from tower to obstacle is approx TRACK_RADIUS - 0.5
            # At distance of obstacle (t ~ 0.95), calculate ray height
            t = 0.95
            ray_z = (TOWER_HEIGHT * (1.0 - t)) + (runner_height * t)

            # If obstacle height is above the bullet trajectory, bullet strikes cover!
            if obs["height"] >= ray_z:
                return True, obs

        return False, None

    def on_reconnect(self, pid):
        now = self.ctx.now()
        runner_list = []
        for r_id, r in self.runners.items():
            runner_list.append({
                "id": r_id,
                "angle": round(r["angle"], 4),
                "lane": round(r["lane"], 2),
                "stance": r["stance"],
                "hp": r["hp"],
                "alive": r["alive"],
                "escaped": r["escaped"],
                "pct": round(min(1.0, r["angle"] / FULL_ORBIT) * 100, 1),
            })
        self.ctx.send(pid, {
            "k": "sync",
            "phase": self.phase,
            "left": round(max(0.0, self.t_end - now), 1),
            "sniper_id": self.sniper_id,
            "sniper": {
                "id": self.sniper_id,
                "yaw": round(self.sniper["yaw"], 4),
                "pitch": round(self.sniper["pitch"], 3),
                "ammo": self.sniper["ammo"],
                "reloading": self.sniper["reloading"],
            },
            "runners": runner_list,
            "sectors": self.sectors,
            "obstacles": self.obstacles,
        })

    def on_disconnect(self, pid):
        if pid in self.runners:
            self.runners[pid]["speed"] = 0.0

    def on_leave(self, pid):
        if pid in self.runners:
            self.runners[pid]["alive"] = False
        super().on_leave(pid)

    def _end(self, reason, msg):
        if self.phase != "play":
            return
        self.phase = "done"
        ticker = getattr(self, "ticker", None)
        if ticker:
            ticker.cancel()

        # Compute ranking & scores
        ranking = []
        if reason == "escaped":
            # Runners win
            for r_id in self.runner_ids:
                r = self.runners.get(r_id, {})
                score = 150 if r.get("escaped") else 50
                self.scores[r_id] = score
                ranking.append({"id": r_id, "score": score, "note": "Escaped! 360° completed"})
            if self.sniper_id:
                s_score = self.sniper["hits"] * 30
                self.scores[self.sniper_id] = s_score
                ranking.append({"id": self.sniper_id, "score": s_score, "note": f"{self.sniper['hits']} hits"})
        else:
            # Sniper wins
            if self.sniper_id:
                self.scores[self.sniper_id] = 200
                ranking.append({"id": self.sniper_id, "score": 200, "note": f"Tower defended! {self.sniper['hits']} eliminated"})
            for pid in self.runner_ids:
                r = self.runners.get(pid, {})
                pct = int(min(1.0, r.get("angle", 0) / FULL_ORBIT) * 100)
                score = pct
                self.scores[pid] = score
                ranking.append({"id": pid, "score": score, "note": f"Made it {pct}% around"})

        ranking.sort(key=lambda x: x["score"], reverse=True)
        winners = [ranking[0]["id"]] if ranking else []

        self.ctx.broadcast({"k": "end", "reason": reason, "msg": msg, "scores": self.scores})
        notes = {r["id"]: r["note"] for r in ranking}
        self.ctx.later(1.6, self.ctx.finish, self.scores, winners, "Sniper Orbit", notes)

    def stop(self):
        ticker = getattr(self, "ticker", None)
        if ticker:
            ticker.cancel()
