# Arcade

Local multiplayer games. One phone runs the server in Termux; friends join over its hotspot and play in their browsers.
No internet needed once it's installed. The server uses only Python's standard library.

## Install (Termux, once)

```sh
pkg update && pkg upgrade -y
pkg install -y python unzip
pip install segno          # optional: QR codes
termux-setup-storage       # once: lets Termux read your Downloads folder
cp ~/storage/downloads/arcade.zip ~ && cd ~ && unzip -o arcade.zip && cd arcade
```

## Run

```sh
sh start.sh                # or: python server.py
```

Turn on your phone's hotspot first. The server prints two addresses:

- **You (host)**: `http://localhost:8000`, open it in your own browser.
- **Friends**: `http://192.168.x.x:8000`, they join your hotspot and open this. A QR code is printed too.

Create a room, share the 4-letter code (or tap **Show QR** and have friends scan it), everyone taps **I'm ready**, host taps **Start game**.

Options: `--port 8080`, `--host 192.168.43.1` (force the address shown to friends), `--no-qr`.

## If something doesn't work

- **Friends can't open the page**: they must be connected to *your hotspot*. Check the address in the terminal; if the wrong one is shown, restart with `--host <your hotspot IP>` (Android: Settings > Hotspot, or run `ifconfig`).
- **The game freezes when you switch apps**: Android may put Termux to sleep. Use `sh start.sh` (it takes a wake lock) and set Termux to "Unrestricted" in Android's battery settings.
- **Friends' screens dim and they drop out**: they reconnect automatically when the screen comes back, but a longer screen timeout helps. Browsers only keep the screen awake on https/localhost, so this can't be fixed from our side.
- **No sound**: tap anywhere once, browsers block sound until the first tap. Check the speaker button top-right.
- **Port busy**: an older copy is still running. Close it, or use `--port 8001`.

## Folders

```
arcade/
  server.py            start here
  start.sh             Termux helper (wake lock + server)
  core/                shared server core
    ws.py              WebSocket (RFC 6455), standard library only
    http.py            static files, /qr, websocket upgrade
    hub.py             players, rooms, ready-up, reconnect, game lifecycle
    games.py           finds games/*/manifest.json
    game_api.py        the contract a game follows + shared helpers (read this first)
    netinfo.py         hotspot IP detection, QR
  web/                 shared UI kit + lobby (Neon Dusk)
    css/kit.css        tokens + components    css/app.css  screens
    js/kit/            ui.js (avatars, sheets, toasts), audio.js (synth sfx), fx.js (particles)
    js/net.js          reconnecting WebSocket    js/app.js  home / room / results
    fonts/             Space Grotesk + DM Sans (OFL licence), bundled
  games/
    warmup/            tap race, also the template for new games
    hush_heist/        bluff-and-guess vault game (2-6 players, ~1 min)
    screen_riot/       symbol race + pranks that flip/blur/shuffle rivals' boards (2-6 players, 90 sec)
    tectonic/          13×13 territory arena: paint floor, raise timed walls, launch rivals (2–6 players, 90 sec)
  tests/               developer tests (need extra packages, not needed on the phone)
  requirements-dev.txt packages for those tests
```

## Adding a game

Copy `games/warmup/` to `games/<new_id>/` (lowercase letters, digits, underscore), then edit:

- `manifest.json`: name, tagline, two-sentence `how`, player range, `"ready": true`
- `server.py`: `class Game(BaseGame)`, the rules (see `core/game_api.py`)
- `client.js`: `Arcade.registerGame("<new_id>", { mount(root, api) { ... return { message, destroy } } })`
- `card.svg`: picker art; `style.css` if the manifest has `"css": true`

Restart the server. The lobby, rooms, ready-up, reconnects and results screen come for free.

`BaseGame` also does the repetitive parts for you: `self.countdown(then)` (the 3-2-1), `self.set_timer(sec, fn)`
(one main timer that replaces the last), `self.here` / `self.gone()` (who is still in the round, kept up to date on
leave), and `self.int_in(v, lo, hi)` (validate numbers from the client). Details are at the top of `core/game_api.py`.

## Developer tests (optional, on a computer)

```sh
pip install -r requirements-dev.txt && playwright install chromium
python tests/run_all.py             # everything; tests missing a package are skipped with a hint
python tests/run_all.py --quick     # only the tests that need nothing installed
```

Or one at a time:

```sh
python tests/test_hush_heist.py     # game rules only, needs nothing extra
python tests/test_screen_riot.py    # game rules only, needs nothing extra
python tests/test_tectonic.py       # game rules only, needs nothing extra
python tests/test_game_api.py       # the shared BaseGame helpers (needs nothing extra)
python tests/test_http.py           # caching, ETag, Origin check, path safety (needs nothing extra)
python tests/test_ws.py             # WebSocket layer (needs websockets)
python tests/test_server.py         # lobby/rooms end to end (needs websockets)
python tests/ui_smoke.py            # emulated phones: lobby, room, Warm-Up, reconnect (needs playwright + segno)
python tests/ui_screen_riot.py      # emulated phones play a Screen Riot round (needs playwright)
python tests/ui_load_retry.py       # a flaky download must not kick anyone out (needs playwright)
```
