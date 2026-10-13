"""Discover games: every folder in games/ with a manifest.json is a game."""
from __future__ import annotations

import importlib
import json
import os
import re
import traceback
from dataclasses import dataclass, field

PUBLIC_KEYS = ("id", "name", "order", "tagline", "how", "kind", "duration", "controls",
               "min_players", "max_players", "accent", "css")


@dataclass
class GameInfo:
    id: str
    manifest: dict
    cls: type | None = None
    ready: bool = False
    error: str = ""
    path: str = field(default="")

    @property
    def min_players(self) -> int:
        return int(self.manifest.get("min_players", 2))

    @property
    def max_players(self) -> int:
        return int(self.manifest.get("max_players", 6))

    def public(self) -> dict:
        d = {k: self.manifest.get(k) for k in PUBLIC_KEYS if k in self.manifest}
        d["id"] = self.id
        d["ready"] = self.ready
        d["min_players"] = self.min_players
        d["max_players"] = self.max_players
        d["has_card"] = os.path.isfile(os.path.join(self.path, "card.svg"))
        if self.error:
            d["error"] = self.error
        return d


def discover_games(root: str) -> dict[str, GameInfo]:
    games_dir = os.path.join(root, "games")
    games: dict[str, GameInfo] = {}
    if not os.path.isdir(games_dir):
        return games
    for name in sorted(os.listdir(games_dir)):
        path = os.path.join(games_dir, name)
        manifest_path = os.path.join(path, "manifest.json")
        if not (os.path.isdir(path) and os.path.isfile(manifest_path)):
            continue
        if not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            print(f"  ! skipping games/{name}: folder names must be lowercase letters, digits, underscore")
            continue
        try:
            with open(manifest_path, encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception as e:
            print(f"  ! games/{name}/manifest.json is not valid JSON: {e}")
            continue
        manifest["id"] = name
        info = GameInfo(id=name, manifest=manifest, path=path)
        if manifest.get("ready"):
            try:
                module = importlib.import_module(f"games.{name}.server")
                info.cls = getattr(module, "Game")
                info.ready = True
            except Exception as e:
                info.error = f"{type(e).__name__}: {e}"
                print(f"  ! games/{name} failed to load and was disabled: {info.error}")
                traceback.print_exc()
        games[name] = info
    # playable games first, then by manifest "order", then by id
    ordered = sorted(games.values(), key=lambda g: (not g.ready, g.manifest.get("order", 50), g.id))
    return {g.id: g for g in ordered}
