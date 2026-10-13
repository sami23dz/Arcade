/* Arcade app shell: home, room, game host, results. Games plug in via Arcade.registerGame(). */
(function () {
  "use strict";
  var A = (window.Arcade = window.Arcade || {});
  var ui = A.ui, h = ui.h, $ = ui.$, audio = A.audio, fx = A.fx, net = A.net, COLORS = ui.COLORS;

  var NAMES = ["Neon Fox", "Pixel Owl", "Turbo Cat", "Cosmic Pup", "Laser Bat", "Disco Yak",
    "Comet Kid", "Jelly Bot", "Zippy Moth", "Astro Newt", "Glitch Gnu", "Mango Ray"];
  var rnd = function (n) { return Math.floor(Math.random() * n); };

  /* ------------------------------------------------------------- storage */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* blocked */ } }
  function readJson(s) { try { var v = JSON.parse(s); return v && typeof v === "object" ? v : null; } catch (e) { return null; } }

  var profile = readJson(lsGet("arcade.profile")) || { name: NAMES[rnd(NAMES.length)], color: rnd(6), avatar: rnd(12) };
  profile.color = profile.color | 0; profile.avatar = profile.avatar | 0;
  lsSet("arcade.profile", JSON.stringify(profile));

  /* --------------------------------------------------------------- state */
  var S = {
    me: null, games: [], gmap: {}, urls: [], online: [], room: null, prevRoom: null,
    selected: null, game: null, results: null, pendingJoin: null, ready: false, statusTimer: 0,
    devMode: lsGet("arcade.dev_mode") === "true", autoAddNpc: false
  };
  var els = {}, editors = [], muteBtns = [], connEls = [], devBadges = [], loadCache = {};

  var params = new URLSearchParams(location.search);
  var qRoom = (params.get("room") || "").replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4);
  if (qRoom.length === 4) S.pendingJoin = qRoom;
  if (location.search) { try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignore */ } }

  /* ----------------------------------------------------- game registration */
  A.games = A.games || {};
  A.registerGame = function (id, def) { A.games[id] = def; };

  /* ================================================================ helpers */
  function me() { return S.me || { id: "", name: profile.name, color: profile.color, avatar: profile.avatar }; }
  function gameName(id) { return (S.gmap[id] && S.gmap[id].name) || id; }
  function show(view) {
    ["home", "room", "game"].forEach(function (v) {
      var el = document.getElementById(v);
      var on = v === view;
      if (on && !el.classList.contains("active")) el.classList.add("active");
      if (!on) el.classList.remove("active");
    });
    S.view = view;
    document.title = view === "home" ? "Arcade" : S.room ? "Arcade " + S.room.code : "Arcade";
  }

  function toggleDevMode(forced) {
    S.devMode = (forced !== undefined) ? !!forced : !S.devMode;
    lsSet("arcade.dev_mode", S.devMode ? "true" : "false");
    audio.play(S.devMode ? "ready" : "unready");
    ui.toast(S.devMode ? "🛠️ Dev Mode Active: 1P test vs Idle NPC enabled" : "🛠️ Dev Mode Disabled", S.devMode ? "good" : "");
    updateDevBadges();
    if (S.view === "home") renderGames();
    else if (S.view === "room") renderRoom();
  }

  var logoTaps = [];
  function onLogoTap() {
    var now = Date.now();
    logoTaps = logoTaps.filter(function (t) { return now - t < 2500; });
    logoTaps.push(now);
    if (logoTaps.length >= 5) {
      logoTaps = [];
      toggleDevMode();
    }
  }

  function logoEl() {
    return h("div", { class: "logo", role: "button", tabindex: "0", "aria-label": "Arcade",
      on: { click: onLogoTap, keydown: function (e) { if (e.key === "Enter") onLogoTap(); } } },
      "Arcade".split("").map(function (c) { return h("span", { text: c, "aria-hidden": "true" }); }));
  }

  function devBadgeEl() {
    var b = h("button", { class: "dev-badge", type: "button", style: { display: S.devMode ? "inline-flex" : "none" },
      title: "Dev Mode Active. Tap to disable.",
      on: { click: function () { toggleDevMode(false); } } },
      h("i"), h("span", { text: "DEV" }));
    devBadges.push(b);
    return b;
  }
  function updateDevBadges() {
    devBadges.forEach(function (b) {
      b.style.display = S.devMode ? "inline-flex" : "none";
    });
  }

  // Keyboard shortcut listener for dev mode (`~`, `F2`, or typing "dev" / "npc")
  var keyBuf = "";
  window.addEventListener("keydown", function (e) {
    if (nameFocused()) return;
    if (e.key === "`" || e.key === "~" || e.key === "F2") {
      e.preventDefault();
      toggleDevMode();
      return;
    }
    if (e.key && e.key.length === 1) {
      keyBuf = (keyBuf + e.key.toLowerCase()).slice(-8);
      if (keyBuf.endsWith("dev") || keyBuf.endsWith("npc")) {
        keyBuf = "";
        toggleDevMode();
      }
    }
  });

  function muteButton() {
    var b = h("button", { class: "icon-btn", "aria-label": "Sound on or off", on: { click: function () {
      var m = audio.toggle(); if (!m) audio.play("pop");
    } } });
    muteBtns.push(b);
    paintMute(b);
    return b;
  }
  function paintMute(b) {
    ui.clear(b).appendChild(ui.icon(audio.isMuted() ? "mute" : "sound"));
    b.setAttribute("aria-pressed", audio.isMuted() ? "true" : "false");
  }
  audio.onChange(function () { muteBtns.forEach(paintMute); });

  function connEl() {
    var c = h("div", { class: "conn wait", title: "Connection" }, h("i"), h("span", { text: "" }));
    connEls.push(c);
    paintConn();
    return c;
  }
  function paintConn() {
    var open = net.status === "open";
    connEls.forEach(function (c) {
      c.className = "conn " + (open ? "" : net.status === "closed" ? "bad" : "wait");
      c.lastChild.textContent = open ? (net.rtt != null ? net.rtt + " ms" : "") : net.status === "closed" ? "offline" : "...";
    });
  }
  function send(obj) {
    if (!net.send(obj)) { ui.toast("Not connected yet. Reconnecting...", "error"); audio.play("error"); return false; }
    return true;
  }

  /* ============================================================== profile */
  var profTimer = 0;
  function pushProfile() { net.send({ t: "profile", name: profile.name, color: profile.color, avatar: profile.avatar }); }
  function setProfile(patch, immediate) {
    for (var k in patch) profile[k] = patch[k];
    lsSet("arcade.profile", JSON.stringify(profile));
    renderEditors();
    clearTimeout(profTimer);
    profTimer = setTimeout(pushProfile, immediate ? 0 : 350);
  }
  function nameFocused() { var a = document.activeElement; return !!(a && a.classList && a.classList.contains("name-input")); }
  function renderEditors() { editors.forEach(function (e) { e.render(); }); }

  function makeEditor() {
    var bigWrap = h("div");
    var input = h("input", {
      class: "name-input", type: "text", maxlength: "14", value: profile.name, autocomplete: "off",
      autocapitalize: "words", spellcheck: "false", "aria-label": "Your name", enterkeyhint: "done",
      on: {
        input: function () { setProfile({ name: input.value }, false); },
        blur: function () { if (!input.value.trim()) { input.value = (S.me && S.me.name) || NAMES[0]; setProfile({ name: input.value }, true); } },
        keydown: function (e) { if (e.key === "Enter") input.blur(); }
      }
    });
    var sw = COLORS.map(function (c, i) {
      return h("button", { class: "swatch", style: { "--c": c }, "aria-label": ui.COLOR_NAMES[i],
        on: { click: function () { audio.play("click"); setProfile({ color: i }, true); } } });
    });
    var strip = h("div", { class: "avatar-strip", role: "group", "aria-label": "Pick a character" });
    var el = h("section", { class: "me" },
      h("div", { class: "me-top" }, bigWrap, h("div", { class: "me-main" }, input, h("div", { class: "swatches", role: "group", "aria-label": "Pick a color" }, sw))),
      strip);
    var lastAvatar = -1;
    function render() {
      if (document.activeElement !== input) input.value = profile.name;
      ui.clear(bigWrap).appendChild(ui.avatar(profile, 88));
      if (lastAvatar !== -1 && lastAvatar !== profile.avatar && bigWrap.animate && !fx.reduced) {
        bigWrap.animate([{ transform: "scale(.75) rotate(-10deg)" }, { transform: "scale(1.08) rotate(3deg)" }, { transform: "scale(1)" }], { duration: 380, easing: "cubic-bezier(.34,1.56,.64,1)" });
      }
      lastAvatar = profile.avatar;
      sw.forEach(function (b, i) { b.setAttribute("aria-pressed", i === profile.color ? "true" : "false"); });
      ui.clear(strip);
      for (var i = 0; i < 12; i++) {
        strip.appendChild((function (i) {
          return h("button", { class: "av-opt", "aria-label": "Character " + (i + 1), "aria-pressed": i === profile.avatar ? "true" : "false",
            style: { "--c": COLORS[profile.color] }, on: { click: function () { audio.play("pop"); setProfile({ avatar: i }, true); } } },
            ui.avatar({ avatar: i, color: profile.color }, 38));
        })(i));
      }
    }
    var ed = { el: el, render: render };
    editors.push(ed);
    render();
    return ed;
  }

  /* ================================================================== home */
  function buildHome() {
    var root = $("#home");
    var editor = makeEditor();
    els.codeInput = h("input", {
      class: "input code-input", type: "text", inputmode: "text", maxlength: "4", placeholder: "CODE", autocomplete: "off",
      autocapitalize: "characters", autocorrect: "off", spellcheck: "false", "aria-label": "Room code", enterkeyhint: "go",
      on: {
        input: function () { var v = els.codeInput.value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 4); if (v !== els.codeInput.value) els.codeInput.value = v; },
        keydown: function (e) { if (e.key === "Enter") joinFromInput(); }
      }
    });
    els.gameRow = h("div", { class: "game-row", role: "list" });
    els.onlineHead = h("h2", { text: "Online now" });
    els.onlineCount = h("span", { class: "pill", text: "0" });
    els.onlineList = h("div", { class: "online-list" });

    root.appendChild(h("header", { class: "topbar" }, logoEl(), h("div", { class: "right" }, devBadgeEl(), connEl(), muteButton())));
    root.appendChild(h("div", { class: "scroll" }, h("div", { class: "col" },
      editor.el,
      h("section", { class: "actions-block" },
        h("button", { class: "btn btn-primary btn-xl", on: { click: function () { createRoom(S.selected); } } }, ui.icon("plus"), "Create a room"),
        h("div", { class: "join" }, els.codeInput,
          h("button", { class: "btn btn-ghost", text: "Join", on: { click: joinFromInput } }))),
      h("section", null, h("div", { class: "section-head" }, h("h2", { text: "Pick a game" })), els.gameRow),
      h("section", null, h("div", { class: "section-head" }, els.onlineHead, els.onlineCount), els.onlineList))));
  }

  function artStyle(g) { return g.has_card ? { backgroundImage: "url(/g/" + g.id + "/card.svg)" } : { backgroundImage: "linear-gradient(135deg," + COLORS[(g.accent | 0) % 6] + ",#1a1545)" }; }
  function rangeText(g) { return g.min_players === g.max_players ? String(g.min_players) : g.min_players + "-" + g.max_players; }

  function renderGames() {
    ui.clear(els.gameRow);
    S.games.forEach(function (g) {
      var locked = !g.ready;
      els.gameRow.appendChild(h("button", {
        class: "gcard" + (locked ? " locked" : "") + (S.selected === g.id ? " selected" : ""), role: "listitem",
        style: { "--ac": COLORS[(g.accent | 0) % 6] }, "aria-label": g.name + (locked ? ", coming soon" : ""),
        on: { click: function () { audio.play("click"); openGameSheet(g, false); } }
      },
        h("span", { class: "gartbox" },
          h("span", { class: "gart", style: artStyle(g) }),
          locked ? h("span", { class: "pill soon" }, ui.icon("lock", 14), "Soon") : null),
        h("span", { class: "gbody" },
          h("h3", { text: g.name }),
          h("span", { class: "meta", text: g.kind || "" }),
          h("span", { class: "meta", text: rangeText(g) + " players" }))));
    });
  }

  function statusText(p) {
    if (p.id === me().id) return "You";
    if (p.status === "playing") return "Playing " + gameName(p.game);
    if (p.status === "room") return p.room ? "In room " + p.room : "In a room";
    return "In the lobby";
  }
  function renderOnline() {
    var list = S.online.slice().sort(function (a, b) { return (a.id === me().id ? -1 : 0) - (b.id === me().id ? -1 : 0); });
    els.onlineCount.textContent = String(list.length);
    ui.clear(els.onlineList);
    if (list.length <= 1) {
      els.onlineList.appendChild(h("p", { class: "dim", text: "Only you so far. Friends who open this address show up here." }));
    }
    list.forEach(function (p) {
      var joinable = p.room && p.id !== me().id && !(S.room && S.room.code === p.room);
      els.onlineList.appendChild(h("div", { class: "who" },
        ui.avatar(p, 38),
        h("div", { class: "t" }, h("b", { text: p.name }), h("small", { text: statusText(p) })),
        joinable ? h("button", { class: "btn btn-sm btn-ghost", text: "Join", "aria-label": "Join " + p.name + "'s room",
          on: { click: function () { joinRoom(p.room); } } }) : null));
    });
  }

  function openGameSheet(g, inRoom) {
    S.selected = g.ready ? g.id : S.selected;
    renderGames();
    var locked = !g.ready;
    var facts = h("dl", { class: "facts" },
      h("dt", { text: "Players" }), h("dd", { text: rangeText(g) }),
      h("dt", { text: "Round" }), h("dd", { text: g.duration || "Quick" }),
      h("dt", { text: "Style" }), h("dd", { text: g.kind || "" }),
      h("dt", { text: "Controls" }), h("dd", { text: g.controls || "Tap" }));
    var s;
    var actions = h("div", { class: "actions" });
    if (locked) {
      actions.appendChild(h("button", { class: "btn", disabled: true, text: "Coming soon" }));
    } else if (inRoom) {
      actions.appendChild(h("button", { class: "btn btn-primary", text: "Play " + g.name, on: { click: function () { if (send({ t: "room.select", game: g.id })) s.close(); } } }));
    } else {
      actions.appendChild(h("button", { class: "btn btn-primary", text: "Create room with " + g.name, on: { click: function () { s.close(); createRoom(g.id); } } }));
      if (S.devMode) {
        actions.appendChild(h("button", {
          class: "btn btn-dev-solo", text: "🎮 Solo Test (1P vs NPC)",
          on: { click: function () { s.close(); S.autoAddNpc = true; createRoom(g.id); } }
        }));
      }
    }
    actions.appendChild(h("button", { class: "btn btn-ghost", text: "Close", on: { click: function () { s.close(); } } }));
    var body = h("div", null,
      h("div", { class: "art", style: artStyle(g) }),
      h("p", { text: g.tagline || "" }),
      h("p", { class: "dim", style: { marginTop: "6px" }, text: g.how || "" }),
      facts, actions);
    s = ui.sheet({ title: g.name, body: body });
  }

  function createRoom(gameId) {
    if (!gameId) { ui.toast("Pick a game that's ready to play.", "error"); return; }
    audio.play("pop");
    send({ t: "room.create", game: gameId });
  }
  function joinFromInput() {
    var code = els.codeInput.value.trim();
    if (code.length !== 4) { ui.toast("Enter the 4-letter room code.", "error"); audio.play("error"); els.codeInput.focus(); return; }
    joinRoom(code);
  }
  function joinRoom(code) { audio.play("click"); send({ t: "room.join", code: code }); }

  /* ================================================================== room */
  function baseUrl() {
    return ui.isLocalHost(location.hostname) ? (S.urls[0] || "") : location.origin;
  }

  var secretRoomTaps = [];
  function onSecretRoomTap() {
    var now = Date.now();
    secretRoomTaps = secretRoomTaps.filter(function (t) { return now - t < 2500; });
    secretRoomTaps.push(now);
    if (secretRoomTaps.length >= 5) {
      secretRoomTaps = [];
      toggleDevMode(true);
      if (S.room && S.room.host === me().id) {
        audio.play("pop");
        send({ t: "room.npc", action: "add" });
        ui.toast("🤖 Added Idle NPC to room!", "good");
      }
    }
  }

  function buildRoom() {
    var root = $("#room");
    els.codeBox = h("div", { class: "code", role: "button", tabindex: "0", "aria-label": "Room code. Tap to copy.",
      on: {
        click: function () { copyCode(); onSecretRoomTap(); },
        keydown: function (e) { if (e.key === "Enter" || e.key === " ") copyCode(); }
      } });
    els.hint = h("p", { class: "hint" });
    els.gpanel = h("section", { class: "gpanel" });
    els.membersTitle = h("h2", { text: "Players", style: { cursor: "pointer" }, on: { click: onSecretRoomTap } });
    els.membersCount = h("span", { class: "pill", text: "" });
    els.members = h("div", { class: "members" });
    els.foot = h("div", { class: "inner" });

    root.appendChild(h("header", { class: "topbar" },
      h("button", { class: "btn btn-ghost btn-sm", "aria-label": "Leave room", on: { click: function () { leaveRoom(false); } } }, ui.icon("back", 18), "Leave"),
      h("div", { class: "right" }, devBadgeEl(), connEl(), muteButton())));
    root.appendChild(h("div", { class: "scroll" }, h("div", { class: "col" },
      h("section", { class: "code-wrap" }, els.codeBox,
        h("div", { class: "code-actions" },
          h("button", { class: "btn btn-ghost btn-sm", on: { click: copyCode } }, ui.icon("copy", 18), "Copy code"),
          h("button", { class: "btn btn-ghost btn-sm", on: { click: showQr } }, ui.icon("qr", 18), "Show QR")),
        els.hint),
      els.gpanel,
      h("section", null, h("div", { class: "section-head" }, els.membersTitle, els.membersCount), els.members,
        h("p", { class: "small faint", style: { marginTop: "10px" }, text: "Tap your own row to change your look." })))));
    root.appendChild(h("div", { class: "foot" }, els.foot));
  }

  function copyCode() {
    if (!S.room) return;
    ui.copyText(S.room.code).then(function (ok) {
      ui.toast(ok ? "Code " + S.room.code + " copied" : "Couldn't copy. Read the code out loud instead.", ok ? "good" : "error");
      audio.play("click");
    });
    els.codeBox.classList.remove("bump"); void els.codeBox.offsetWidth; els.codeBox.classList.add("bump");
  }
  function showQr() {
    if (!S.room) return;
    var base = baseUrl();
    if (!base) { ui.toast("Open the Friends address printed in Termux to get a QR code.", "error"); return; }
    var url = base + "/?room=" + S.room.code;
    var img = h("img", { alt: "QR code to join room " + S.room.code, src: "/qr?d=" + encodeURIComponent(url), width: "280", height: "280" });
    var box = h("div", { class: "qr-box" }, img, h("p", { class: "dim small", text: url.replace(/^https?:\/\//, "") }));
    img.addEventListener("error", function () {
      ui.clear(box).appendChild(h("p", { class: "dim", text: "QR codes need one extra install in Termux: pip install segno. Then restart the server." }));
    });
    var s = ui.sheet({ title: "Scan to join", body: h("div", null, box,
      h("p", { class: "dim small", style: { textAlign: "center" }, text: "Friends need to be on your hotspot, then point their camera here." }),
      h("div", { class: "actions" }, h("button", { class: "btn btn-ghost", text: "Done", on: { click: function () { s.close(); } } }))) });
  }

  function renderRoom() {
    var r = S.room;
    if (!r) return;
    var my = me(), g = S.gmap[r.game] || { name: r.game, min_players: 2, max_players: 6 };
    var isHost = r.host === my.id;
    var mm = r.members.filter(function (m) { return m.id === my.id; })[0];

    // code tiles (rebuild only when the code changes, so the entrance plays once)
    if (els.codeBox.dataset.code !== r.code) {
      els.codeBox.dataset.code = r.code;
      ui.clear(els.codeBox);
      r.code.split("").forEach(function (ch, i) { els.codeBox.appendChild(h("div", { class: "tile", style: { "--i": i }, text: ch })); });
      audio.play("pop");
    }
    var base = baseUrl();
    ui.clear(els.hint);
    if (base) els.hint.append("Friends join the hotspot, open ", h("b", { text: base.replace(/^https?:\/\//, "") }), " and enter this code.");
    else els.hint.append("Friends join the hotspot, open the Friends address shown in Termux, and enter this code.");

    // game panel
    ui.clear(els.gpanel);
    els.gpanel.appendChild(h("div", { class: "row" },
      h("div", { class: "thumb", style: artStyle(g) }),
      h("div", { class: "info" },
        h("h3", { text: g.name }),
        h("span", { class: "pill" }, ui.icon("users", 14), rangeText(g) + " players"),
        isHost ? h("button", { class: "btn btn-ghost btn-sm", on: { click: openGamePicker } }, ui.icon("swap", 16), "Change game") : null)));
    if (g.how) els.gpanel.appendChild(h("p", { class: "how", text: g.how }));

    // members
    els.membersCount.textContent = r.members.length + "/" + Math.min(6, g.max_players || 6);
    ui.clear(els.members);
    r.members.forEach(function (m) {
      var mine = m.id === my.id;
      var isH = m.id === r.host;
      var isNpc = !!m.is_npc;
      var status;
      if (isNpc) status = h("span", { class: "pill good" }, ui.icon("check", 14), "Idle NPC");
      else if (!m.online) status = h("span", { class: "pill warn", text: "Reconnecting" });
      else if (isH) status = h("span", { class: "pill", text: "Host" });
      else if (m.ready) status = h("span", { class: "pill good" }, ui.icon("check", 14), "Ready");
      else status = h("span", { class: "pill", text: "Not ready" });
      var row = h("div", {
        class: "member" + (m.online ? "" : " off") + (S.seen[m.id] ? "" : " enter"), style: { "--c": COLORS[m.color % 6] },
        role: mine ? "button" : null, tabindex: mine ? "0" : null, title: mine ? "Change your look" : null,
        on: mine ? { click: openProfileSheet, keydown: function (e) { if (e.key === "Enter") openProfileSheet(); } } : null
      },
        ui.avatar(m, 46),
        h("div", { class: "nm" },
          h("span", { class: "n", text: m.name }),
          isH ? ui.icon("crown", 18) : null,
          mine ? h("span", { class: "me-tag", text: "you" }) : null,
          isNpc ? h("span", { class: "npc-tag", text: "BOT" }) : null),
        m.wins ? h("span", { class: "wins", title: m.wins + " round wins" }, ui.icon("trophy", 16), String(m.wins)) : null,
        status);
      els.members.appendChild(row);
      S.seen[m.id] = true;
    });

    // Dev Tools panel for host when devMode or NPC present
    if (isHost && (S.devMode || r.has_npc)) {
      var devPanel = h("div", { class: "dev-panel" },
        h("div", { class: "dev-panel-head" },
          h("div", { class: "dev-panel-title" },
            ui.icon("play", 14), h("span", { text: "Dev Tools: 1P vs Idle NPC" })
          ),
          h("button", { class: "btn btn-ghost btn-sm", style: { minHeight: "26px", padding: "0 8px", fontSize: "11px" }, text: "Hide Dev", on: { click: function () { toggleDevMode(false); } } })
        ),
        h("div", { class: "dev-panel-btns" },
          h("button", { class: "btn btn-ghost btn-sm", on: { click: function () { audio.play("pop"); send({ t: "room.npc", action: "add" }); } } },
            ui.icon("plus", 14), "Add Idle NPC"),
          r.has_npc ? h("button", { class: "btn btn-ghost btn-sm", on: { click: function () { audio.play("click"); send({ t: "room.npc", action: "remove" }); } } },
            ui.icon("close", 14), "Remove NPC") : null,
          (r.members.length === 1) ? h("button", { class: "btn btn-dev-solo btn-sm", on: { click: function () {
            audio.play("ready");
            send({ t: "room.npc", action: "add" });
          } } }, ui.icon("play", 14), "Quick 1P Setup (Add NPC)") : null
        )
      );
      els.members.appendChild(devPanel);
    }

    // footer: ready / start
    ui.clear(els.foot);
    var why = h("div", { class: "why" });
    var btn;
    if (isHost) {
      btn = h("button", { class: "btn btn-primary btn-xl", disabled: !r.can_start, on: { click: function () { send({ t: "room.start" }); } } }, ui.icon("play", 22), "Start game");
      why.textContent = r.can_start ? "Everyone is ready." : r.why;
      if (!r.can_start && r.members.length === 1 && S.devMode) {
        why.textContent = "Solo test: Tap '+ Add Idle NPC' above to start.";
      }
    } else {
      var ready = !!(mm && mm.ready);
      btn = h("button", { class: "btn btn-xl " + (ready ? "btn-good" : "btn-primary"), on: { click: function () {
        audio.play(ready ? "unready" : "ready"); send({ t: "room.ready", ready: !ready });
      } } }, ready ? ui.icon("check", 22) : null, ready ? "Ready. Tap to undo" : "I'm ready");
      why.textContent = ready ? "Waiting for the host to start." : "Tap when you're ready to play.";
    }
    els.foot.appendChild(why);
    els.foot.appendChild(btn);

    // Subtle secret hint when solo and not yet in dev mode
    if (isHost && !r.can_start && r.members.length === 1 && !S.devMode) {
      els.foot.appendChild(h("p", {
        class: "small faint",
        style: { marginTop: "10px", textAlign: "center", cursor: "pointer", opacity: "0.6" },
        text: "💡 Dev testing? Tap here or type 'dev' to test vs idle NPC.",
        on: { click: function () { toggleDevMode(true); send({ t: "room.npc", action: "add" }); } }
      }));
    }
  }

  function roomSounds(prev, cur) {
    if (!cur || !prev || prev.code !== cur.code) return;
    var before = {}; prev.members.forEach(function (m) { before[m.id] = m; });
    var my = me().id;
    cur.members.forEach(function (m) {
      var b = before[m.id];
      if (!b) { if (m.id !== my) audio.play("join"); }
      else if (m.ready && !b.ready && m.id !== my && m.id !== cur.host) audio.play("ready");
    });
    var now = {}; cur.members.forEach(function (m) { now[m.id] = 1; });
    prev.members.forEach(function (m) { if (!now[m.id]) audio.play("leave"); });
  }

  function openGamePicker() {
    var s;
    var body = h("div", null);
    S.games.forEach(function (g) {
      body.appendChild(h("button", {
        class: "pick-row" + (g.ready ? "" : " locked") + (S.room && S.room.game === g.id ? " current" : ""),
        on: { click: function () { s.close(); openGameSheet(g, true); } }
      },
        h("span", { class: "thumb", style: artStyle(g) }),
        h("span", { style: { flex: "1", minWidth: "0" } },
          h("h3", { text: g.name }),
          h("span", { class: "small dim", text: g.ready ? g.tagline : "Coming soon" }))));
    });
    s = ui.sheet({ title: "Choose a game", body: h("div", null, body,
      h("div", { class: "actions" }, h("button", { class: "btn btn-ghost", text: "Close", on: { click: function () { s.close(); } } }))) });
  }

  function openProfileSheet() {
    var ed = makeEditor();
    var s = ui.sheet({
      title: "Your look",
      body: h("div", null, h("div", { style: { marginTop: "12px" } }, ed.el),
        h("div", { class: "actions" }, h("button", { class: "btn btn-primary", text: "Done", on: { click: function () { s.close(); } } }))),
      onClose: function () { editors = editors.filter(function (e) { return e !== ed; }); }
    });
  }

  function leaveRoom(force) {
    var r = S.room;
    if (!r) return;
    function go() { audio.play("leave"); net.send({ t: "room.leave" }); }
    if (r.state === "playing" && !force) {
      ui.confirm("Leave this round?", "You'll drop out of the room and your seat opens up.", "Leave", "btn-primary").then(function (ok) { if (ok) go(); });
    } else go();
  }

  /* ================================================================== game */
  /* A game's files come over the host's hotspot, which can hiccup. Try up to three times (so a
     blip doesn't throw anybody out of the room) before giving up. A client.js that loads but
     doesn't register itself is a bug, not a network problem, so that fails straight away. */
  var LOAD_RETRY_MS = [700, 1800];

  function addTag(el) {
    return new Promise(function (resolve, reject) {
      el.onload = function () { resolve(); };
      el.onerror = function () {
        if (el.parentNode) el.parentNode.removeChild(el);      // don't leave dead tags behind
        reject(new Error("could not load " + (el.src || el.href)));
      };
      document.head.appendChild(el);
    });
  }

  function loadGame(info, onRetry) {
    if (loadCache[info.id]) return loadCache[info.id];
    var cssDone = !info.css;
    function attempt(n) {
      var jobs = [];
      if (!cssDone) {
        var l = document.createElement("link");
        l.rel = "stylesheet"; l.href = "/g/" + info.id + "/style.css";
        jobs.push(addTag(l).then(function () { cssDone = true; }));
      }
      if (!A.games[info.id]) {
        var s = document.createElement("script");
        s.src = "/g/" + info.id + "/client.js";
        jobs.push(addTag(s));
      }
      return Promise.all(jobs).then(function () {
        if (A.games[info.id]) return A.games[info.id];
        var e = new Error("client.js did not call Arcade.registerGame('" + info.id + "')");
        e.fatal = true;
        throw e;
      }).catch(function (e) {
        if (e.fatal || n >= LOAD_RETRY_MS.length) throw e;
        if (onRetry) onRetry(n + 1);
        return new Promise(function (go) { setTimeout(go, LOAD_RETRY_MS[n]); })
          .then(function () { return attempt(n + 1); });
      });
    }
    var p = A.games[info.id] ? Promise.resolve(A.games[info.id]) : attempt(0);
    p.catch(function () { delete loadCache[info.id]; });
    loadCache[info.id] = p;
    return p;
  }

  function destroyGame() {
    if (!S.game) return;
    var gm = S.game;
    S.game = null;
    try { if (gm.view && gm.view.destroy) gm.view.destroy(); } catch (e) { if (window.console) console.error(e); }
    ui.clear(els.gameRoot);
  }

  function startGame(m) {
    if (S.game && S.game.run === m.run && S.game.id === m.game) { net.send({ t: "loaded" }); show("game"); return; }
    destroyGame();
    closeResults();
    var info = S.gmap[m.game];
    if (!info) { ui.toast("This game isn't installed on your device.", "error"); net.send({ t: "room.leave" }); return; }
    var gm = S.game = { id: m.game, run: m.run, players: m.players, view: null, buffer: [] };
    ui.clear(els.gameRoot).appendChild(h("div", { class: "game-loading", text: "Loading " + info.name + "..." }));
    if (!m.resume) audio.play("start");
    show("game");
    updateWake();
    loadGame(info, function () {
      var note = els.gameRoot.querySelector(".game-loading");
      if (note && S.game === gm) note.textContent = "Loading " + info.name + "... (retrying)";
    }).then(function (def) {
      if (S.game !== gm) return;
      ui.clear(els.gameRoot);
      var api = {
        gameId: m.game, root: els.gameRoot, players: m.players, kit: A,
        me: m.players.filter(function (p) { return p.id === me().id; })[0] || me(),
        send: function (d) { net.send({ t: "g", d: d }); },
        leave: function () { leaveRoom(true); }
      };
      gm.view = def.mount(els.gameRoot, api) || {};
      gm.buffer.splice(0).forEach(function (d) { if (gm.view.message) gm.view.message(d); });
      net.send({ t: "loaded" });
    }).catch(function (e) {
      if (window.console) console.error(e);
      if (S.game !== gm) return;
      ui.toast("The game failed to load. Check the Termux window.", "error", 5000);
      net.send({ t: "room.leave" });
    });
  }

  function onGameMessage(m) {
    var gm = S.game;
    if (!gm) return;
    if (!gm.view) { gm.buffer.push(m.d); return; }
    try { if (gm.view.message) gm.view.message(m.d); } catch (e) { if (window.console) console.error(e); }
  }

  /* ============================================================== results */
  function closeResults() {
    if (!S.results) return;
    var el = S.results;
    S.results = null;
    el.style.transition = "opacity .2s"; el.style.opacity = "0";
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  function showResults(res) {
    closeResults();
    var my = me().id;
    var winners = res.winners || [];
    var iWon = winners.indexOf(my) !== -1;
    var rows = res.ranking || [];
    var winRows = rows.filter(function (r) { return winners.indexOf(r.id) !== -1; });
    var headline, sub;
    if (!winRows.length) { headline = "Round over"; sub = ""; }
    else if (winRows.length === 1) { headline = iWon ? "You win!" : winRows[0].name + " wins!"; sub = winRows[0].note || ""; }
    else { headline = iWon ? "You tied for the win!" : "It's a tie!"; sub = winRows.map(function (r) { return r.name; }).join(" and "); }

    var top = rows.slice(0, 3);
    var order = top.length === 3 ? [top[1], top[0], top[2]] : top.length === 2 ? [top[1], top[0]] : top;
    var podium = h("div", { class: "podium", role: "list" });
    var bars = [];
    order.forEach(function (r) {
      var isW = winners.indexOf(r.id) !== -1;
      var bar = h("div", { class: "bar", style: { "--c": COLORS[r.color % 6] }, text: String(r.rank) });
      bars.push({ bar: bar, h: r.rank === 1 ? 168 : r.rank === 2 ? 122 : 90 });
      podium.appendChild(h("div", { class: "pod", role: "listitem" },
        isW ? h("div", { class: "crown" }, ui.icon("crown", 30)) : null,
        ui.avatar(r, isW ? 78 : 62),
        h("div", { class: "nm", text: r.name }),
        h("div", { class: "sc", style: { color: COLORS[r.color % 6] }, text: String(r.score) }),
        bar));
    });

    var list = h("div", { class: "rank-list" });
    rows.forEach(function (r) {
      list.appendChild(h("div", { class: "rank-row" + (r.id === my ? " me" : ""), style: { "--c": COLORS[r.color % 6] } },
        h("div", { class: "rk", text: String(r.rank) }),
        ui.avatar(r, 40),
        h("div", { class: "nm" }, r.name + (r.id === my ? " (you)" : ""), r.note ? h("small", { text: r.note }) : null),
        h("div", { class: "sc", text: String(r.score) })));
    });

    var overlay = h("div", { class: "results", role: "dialog", "aria-label": "Round results",
      style: { "--wc": winRows.length ? COLORS[winRows[0].color % 6] : "#a66bff" } },
      h("div", { class: "wrap" },
        h("div", { class: "headline" }, h("h1", { text: headline }),
          h("p", { text: (res.title ? res.title : gameName(res.game)) + (sub ? ". " + sub : "") })),
        podium, list,
        h("div", { class: "btns" }, h("button", { class: "btn btn-primary btn-xl", text: "Back to room", on: { click: function () { audio.play("click"); closeResults(); } } }))));
    document.getElementById("overlay-root").appendChild(overlay);
    S.results = overlay;
    requestAnimationFrame(function () { requestAnimationFrame(function () { bars.forEach(function (b) { b.bar.style.height = b.h + "px"; }); }); });

    if (iWon) {
      audio.play("win"); ui.vibrate([40, 40, 80]);
      setTimeout(function () { fx.confetti(170); }, 350);
    } else {
      audio.play("lose");
      if (winRows.length) setTimeout(function () { fx.burst(window.innerWidth / 2, 150, { color: COLORS[winRows[0].color % 6], n: 26, speed: 300, shape: "star", size: 5 }); }, 400);
    }
  }

  function onGameEnd(res) {
    destroyGame();
    show("room");
    showResults(res);
  }

  /* =============================================================== routing */
  var wake = null;
  function updateWake() {
    if (!navigator.wakeLock) return; // only exists on https/localhost; harmless when absent
    var need = !document.hidden && !!S.room;
    if (need && !wake) {
      navigator.wakeLock.request("screen").then(function (l) {
        wake = l; l.addEventListener("release", function () { wake = null; });
      }).catch(function () { /* not allowed */ });
    } else if (!need && wake) { wake.release().catch(function () { /* ignore */ }); wake = null; }
  }
  document.addEventListener("visibilitychange", updateWake);

  function route() {
    var r = S.room, view;
    if (!r) { if (S.game) destroyGame(); view = "home"; }
    else if (r.state === "playing" && S.game) view = "game";
    else view = "room";
    show(view);
    updateWake();
  }

  /* ================================================================ events */
  net.on("welcome", function (m) {
    S.me = m.me; S.games = m.games || []; S.urls = m.urls || [];
    S.gmap = {}; S.games.forEach(function (g) { S.gmap[g.id] = g; });
    ssSet("arcade.session", JSON.stringify({ pid: m.pid, token: m.token }));
    if (!S.selected || !S.gmap[S.selected] || !S.gmap[S.selected].ready) {
      var first = S.games.filter(function (g) { return g.ready; })[0];
      S.selected = first ? first.id : null;
    }
    if (!nameFocused()) { profile.name = m.me.name; lsSet("arcade.profile", JSON.stringify(profile)); }
    if (!m.resumed) { destroyGame(); closeResults(); S.room = null; S.prevRoom = null; S.seen = {}; }
    S.ready = true;
    renderGames(); renderEditors(); renderOnline();
    if (S.pendingJoin) {
      var code = S.pendingJoin; S.pendingJoin = null;
      els.codeInput.value = code;
      send({ t: "room.join", code: code });
    }
  });
  net.on("me", function (m) {
    S.me = m.me;
    if (!nameFocused()) { profile.name = m.me.name; lsSet("arcade.profile", JSON.stringify(profile)); }
    renderEditors(); renderOnline();
  });
  net.on("presence", function (m) { S.online = m.players || []; renderOnline(); });
  net.on("room", function (m) {
    var prev = S.room;
    S.room = m.room;
    // the round ended while we were away (we never saw game.end): drop the stale game view
    if (m.room && m.room.state === "lobby" && S.game) destroyGame();
    if (m.room) {
      if (S.autoAddNpc && m.room.host === me().id && m.room.members.length === 1) {
        S.autoAddNpc = false;
        send({ t: "room.npc", action: "add" });
      }
      roomSounds(prev, m.room);
      if (!prev || prev.code !== m.room.code) S.seen = {};
      renderRoom();
    } else { S.seen = {}; els.codeBox.dataset.code = ""; }
    route();
    renderOnline();
  });
  net.on("game.start", startGame);
  net.on("game.end", function (m) { onGameEnd(m.results); });
  net.on("game.abort", function (m) {
    destroyGame(); closeResults();
    ui.toast(m.reason || "The round was cancelled.", "error", 4500);
    route();
  });
  net.on("g", onGameMessage);
  net.on("error", function (m) { ui.toast(m.msg || "Something went wrong.", "error"); audio.play("error"); });
  net.on("rtt", paintConn);

  net.onStatus(function (st) {
    paintConn();
    clearTimeout(S.statusTimer);
    var banner = document.getElementById("banner");
    if (st === "open") { banner.hidden = true; return; }
    S.statusTimer = setTimeout(function () {
      if (net.status === "open") return;
      document.getElementById("banner-text").textContent = S.ready ? "Reconnecting..." : "Connecting...";
      banner.hidden = false;
    }, 1200);
  });

  /* Android back button / swipe: never fall out of the arcade by accident. */
  try { history.replaceState({ arcade: 1 }, ""); history.pushState({ arcade: 2 }, ""); } catch (e) { /* ignore */ }
  window.addEventListener("popstate", function () {
    try { history.pushState({ arcade: 2 }, ""); } catch (e) { /* ignore */ }
    var scrim = document.querySelector(".scrim:not(.out)");
    if (scrim) { scrim.click(); return; }
    if (S.results) { closeResults(); return; }
    if (S.room) leaveRoom(false);
  });

  /* ================================================================== boot */
  function boot() {
    els.gameRoot = document.getElementById("game-root");
    S.seen = {};
    buildHome();
    buildRoom();
    var chrome = document.getElementById("game-chrome");
    chrome.appendChild(muteButton());
    chrome.appendChild(h("button", { class: "icon-btn", "aria-label": "Leave round", on: { click: function () { leaveRoom(false); } } }, ui.icon("close")));
    fx.init();
    show("home");
    paintConn();
    net.start(function () {
      var s = readJson(ssGet("arcade.session")) || {};
      return { t: "hello", pid: s.pid, token: s.token, name: profile.name, color: profile.color, avatar: profile.avatar };
    });
  }
  boot();

  A._state = S; // handy in the browser console while testing
})();
