/* Sniper Orbit: High-Performance 3D Panoramic Arena Client */
Arcade.registerGame("sniper_orbit", {
  mount: function (root, api) {
    "use strict";
    var ui = api.kit.ui, h = ui.h, audio = api.kit.audio, fx = api.kit.fx;
    var me = api.me, players = api.players, byId = {};
    players.forEach(function (p) { byId[p.id] = p; });

    var TRACK_RADIUS = 36.0, TRACK_WIDTH = 6.0, TOWER_HEIGHT = 7.5, FULL_ORBIT = Math.PI * 2;
    var NEAR_PLANE = 0.22;

    var isSniper = false;
    var sniperId = null;
    var sectors = [], obstacles = [];
    var phase = "wait", tEnd = 0;
    var botActive = false;

    // Game state models
    var sniperState = { yaw: 0, pitch: -0.15, ammo: 5, reloading: false };
    var runnersState = {};
    var myRunner = { angle: 0.18, lane: 0, stance: "walk", hp: 100, alive: true, pct: 0 };

    // Client-side predictive physics for butter-smooth walking
    var clientAngle = 0.18;
    var clientLane = 0;
    var lastFrameTime = performance.now();

    // Aim & Scope
    var isScoped = false;
    var recoilY = 0;
    var localYaw = 0, localPitch = -0.15;
    var tracer = null; // { from: [x,y,z], to: [x,y,z], t: 0 }
    var muzzleFlash = 0;
    var boltCycleTime = 0;

    // Movement & Stance inputs
    var inputDrive = 0, inputStrafe = 0, currentStance = "walk";
    var stepCycle = 0, jumpOffset = 0, isJumping = false, jumpStartTime = 0;
    var lastStepSound = 0;

    var animFrame = null, timer = null;

    // DOM Elements Construction
    var canvas = h("canvas", { class: "so-canvas" });
    var speedLines = h("div", { class: "so-speed-lines" });
    var sniperAlertVignette = h("div", { class: "so-sniper-alert-vignette" });
    var viewport = h("div", { class: "so-viewport" }, canvas, speedLines, sniperAlertVignette);

    // Orientation helper for portrait screens
    var landscapeHint = h("div", { class: "so-landscape-hint" },
      ui.icon("play", 14),
      h("span", { text: "⤹ Rotate Phone to Landscape" })
    );

    // Top HUD: Role badge & dev test controls
    var roleBadge = h("div", { class: "so-role-badge" }, h("span", { class: "dot" }), h("b", { text: "Connecting..." }));
    var btnSwapRole = h("button", { class: "so-dev-btn", style: { display: "none" }, text: "⇄ Swap Role" });
    var btnToggleBot = h("button", { class: "so-dev-btn", style: { display: "none" }, text: "🤖 Bot: Idle" });
    var devBtns = h("div", { class: "so-dev-btns" }, btnSwapRole, btnToggleBot);
    var topLeft = h("div", { class: "so-top-left" }, roleBadge, devBtns);

    // Center Timer
    var timerVal = h("div", { class: "so-timer-val", text: "90" });
    var timerLbl = h("div", { class: "so-timer-lbl", text: "Seconds" });
    var timerBox = h("div", { class: "so-timer-box" }, timerVal, timerLbl);

    // Top Right: Mini Radar & Telemetry
    var radarCenter = h("div", { class: "so-radar-center" });
    var radarRing = h("div", { class: "so-radar-ring" });
    var radarSweep = h("div", { class: "so-radar-sweep" });
    var radarBunker = h("div", { class: "so-radar-bunker" });
    radarBunker.style.left = (36 + 25) + "px";
    radarBunker.style.top = "36px";
    var radar = h("div", { class: "so-radar" }, radarSweep, radarRing, radarCenter, radarBunker);
    var radarDots = {};

    var progressFill = h("div", { class: "so-progress-fill" });
    var progressBar = h("div", { class: "so-progress-bar" }, progressFill);
    var sectorTag = h("div", { class: "so-sector-tag", text: "Sector 1" });
    var distanceTag = h("div", { class: "so-distance-tag", text: "226m to Bunker" });
    var telemetryRow = h("div", { class: "so-telemetry-row" }, sectorTag, distanceTag);
    var coverBadge = h("div", { class: "so-cover-badge exposed", text: "⚠️ EXPOSED" });
    var telemetry = h("div", { class: "so-telemetry" }, telemetryRow, progressBar, coverBadge);
    var topRight = h("div", { class: "so-top-right" }, telemetry, radar);

    var hudTop = h("div", { class: "so-hud-top" }, topLeft, timerBox, topRight);

    // Sniper Scope Reticle
    var scopeHLine = h("div", { class: "so-scope-h-line" });
    var scopeVLine = h("div", { class: "so-scope-v-line" });
    var scopeDot = h("div", { class: "so-scope-dot" });
    var scopeInnerRing = h("div", { class: "so-scope-inner-ring" });
    var scopeAzimuth = h("span", { text: "AZ: 000°" });
    var scopeElev = h("span", { text: "EL: -8.5°" });
    var scopeMag = h("span", { text: "3.5x OPTIC" });
    var scopeTelemetry = h("div", { class: "so-scope-hud-telemetry" }, scopeAzimuth, scopeElev, scopeMag);
    var scopeReticle = h("div", { class: "so-scope-reticle" }, scopeInnerRing, scopeHLine, scopeVLine, scopeDot, scopeTelemetry);
    var scopeOverlay = h("div", { class: "so-scope-overlay" }, scopeReticle);
    var hitmarker = h("div", { class: "so-hitmarker" });

    // Warning Glint for runners
    var glintWarning = h("div", { class: "so-glint-warning" },
      ui.icon("lightning", 16), h("span", { text: "SNIPER GLINT — DUCK BEHIND COVER!" })
    );

    // Bolt Action Cycling Indicator
    var boltBar = h("div", { class: "so-bolt-bar" }, ui.icon("lightning", 12), h("span", { text: "CYCLING BOLT..." }));

    // Status Message Toast
    var statusMsg = h("div", { class: "so-status-msg", text: "Prepare for orbit..." });

    // Left Thumb: Virtual Analog Joystick
    var joyThumb = h("div", { class: "so-joystick-thumb" });
    var joyCrosshair = h("div", { class: "so-joystick-crosshair" });
    var joyN = h("span", { class: "so-joystick-arrow so-joy-n", text: "▲" });
    var joyS = h("span", { class: "so-joystick-arrow so-joy-s", text: "▼" });
    var joyW = h("span", { class: "so-joystick-arrow so-joy-w", text: "◀" });
    var joyE = h("span", { class: "so-joystick-arrow so-joy-e", text: "▶" });
    var joyBase = h("div", { class: "so-joystick-base" }, joyCrosshair, joyN, joyS, joyW, joyE, joyThumb);
    var joyLbl = h("div", { class: "so-joystick-lbl", text: "ANALOG STICK" });
    var joyWrap = h("div", { class: "so-joystick-wrap" }, joyBase, joyLbl);

    // Right Thumb: Stances & Action Buttons
    var stanceCrawl = h("button", { class: "so-stance-btn", type: "button", text: "CRAWL" });
    var stanceWalk = h("button", { class: "so-stance-btn active", type: "button", text: "WALK" });
    var stanceRun = h("button", { class: "so-stance-btn", type: "button", text: "SPRINT" });
    var stancesBox = h("div", { class: "so-stances" }, stanceCrawl, stanceWalk, stanceRun);

    var btnFire = h("button", { class: "so-action-btn so-btn-fire", type: "button", text: "FIRE" });
    var btnScope = h("button", { class: "so-action-btn so-btn-scope", type: "button", text: "SCOPE" });
    var ammoPips = h("div", { class: "so-ammo-pips" });
    var ammoVal = h("span", { text: "5/5" });
    var ammoBox = h("div", { class: "so-ammo-box" }, ammoPips, ammoVal);
    var btnJump = h("button", { class: "so-action-btn so-btn-jump", type: "button", text: "JUMP" });
    var actionsBox = h("div", { class: "so-actions" });

    var rightControls = h("div", { class: "so-right-controls" }, stancesBox, actionsBox);
    var hudBottom = h("div", { class: "so-hud-bottom" }, joyWrap, rightControls);

    var hud = h("div", { class: "so-hud" }, hudTop, glintWarning, boltBar, statusMsg, hudBottom);
    var gameRoot = h("div", { class: "so-game" }, viewport, landscapeHint, scopeOverlay, hitmarker, hud);
    root.appendChild(gameRoot);

    var ctx = canvas.getContext("2d");

    // Audio effects
    function playGunshot() {
      audio.play("whoosh");
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      try {
        var ac = new C();
        var t0 = ac.currentTime;
        var osc = ac.createOscillator(), g = ac.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(190, t0);
        osc.frequency.exponentialRampToValueAtTime(22, t0 + 0.38);
        g.gain.setValueAtTime(0.7, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
        osc.connect(g); g.connect(ac.destination);
        osc.start(t0); osc.stop(t0 + 0.6);
      } catch (err) { /* ignore */ }
    }

    function playBoltCycle() {
      audio.play("click");
      setTimeout(function () { audio.play("tap"); }, 420);
    }

    function playHitmarker() {
      hitmarker.classList.add("pop");
      setTimeout(function () { hitmarker.classList.remove("pop"); }, 160);
      audio.play("click");
    }

    function playStep() {
      var now = Date.now();
      if (now - lastStepSound > (currentStance === "sprint" ? 280 : 420)) {
        lastStepSound = now;
        audio.play("tap");
      }
    }

    // Resize Canvas
    function resize() {
      var w = viewport.clientWidth || window.innerWidth;
      var h = viewport.clientHeight || window.innerHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }
    window.addEventListener("resize", resize);
    resize();

    // Toggle force landscape on portrait tap
    landscapeHint.addEventListener("click", function () {
      gameRoot.classList.toggle("force-landscape");
      setTimeout(resize, 100);
    });

    // Dev Bot and Role Swap Handlers
    btnSwapRole.onclick = function () {
      api.send({ k: "swap_role" });
      audio.play("pop");
    };

    btnToggleBot.onclick = function () {
      api.send({ k: "toggle_bot" });
      audio.play("pop");
    };

    // Stance selector
    function setStance(s) {
      currentStance = s;
      stanceCrawl.classList.toggle("active", s === "crawl");
      stanceWalk.classList.toggle("active", s === "walk");
      stanceRun.classList.toggle("active", s === "sprint");
      speedLines.classList.toggle("active", s === "sprint" && inputDrive > 0.15);
      sendRunnerMove();
    }
    stanceCrawl.addEventListener("click", function () { setStance("crawl"); });
    stanceWalk.addEventListener("click", function () { setStance("walk"); });
    stanceRun.addEventListener("click", function () { setStance("sprint"); });

    // Look-Relative Movement Physics:
    // Transforms raw analog stick input (drive = forward/back, strafe = left/right)
    // relative to the camera look direction so "the way you look is the way the analog walks"!
    function getRunnerVelocityFactors() {
      if (inputDrive === 0 && inputStrafe === 0) {
        return { drive: 0, strafe: 0 };
      }
      // Camera horizontal yaw relative to track radius:
      // camYaw = clientAngle + Math.PI/2 + localYaw
      // relYaw = camYaw - clientAngle = Math.PI/2 + localYaw
      var relYaw = Math.PI / 2 + localYaw;

      var v_tangent = inputDrive * Math.sin(relYaw) - inputStrafe * Math.cos(relYaw);
      var v_radial = inputDrive * Math.cos(relYaw) + inputStrafe * Math.sin(relYaw);

      v_tangent = Math.max(-1.0, Math.min(1.0, v_tangent));
      v_radial = Math.max(-1.0, Math.min(1.0, v_radial));
      if (Math.abs(v_tangent) < 0.0001) v_tangent = 0;
      if (Math.abs(v_radial) < 0.0001) v_radial = 0;

      return { drive: v_tangent, strafe: v_radial };
    }

    function sendRunnerMove() {
      if (!isSniper && phase === "play") {
        var v = getRunnerVelocityFactors();
        api.send({ k: "move", drive: v.drive, strafe: v.strafe, stance: currentStance });
      }
    }

    function sendSniperAim() {
      if (isSniper && phase === "play") {
        api.send({ k: "aim", yaw: localYaw, pitch: localPitch, zoom: isScoped ? 3.5 : 1.0 });
      }
    }

    // Virtual Analog Joystick Logic
    var joyPointerId = null;
    var JOY_RADIUS = 40; // Max thumb displacement

    function handleJoyMove(cx, cy) {
      var rect = joyBase.getBoundingClientRect();
      var centerX = rect.left + rect.width / 2;
      var centerY = rect.top + rect.height / 2;

      var dx = cx - centerX;
      var dy = cy - centerY;
      var dist = Math.hypot(dx, dy);

      var clampedDist = Math.min(JOY_RADIUS, dist);
      var angle = Math.atan2(dy, dx);

      var thumbX = Math.cos(angle) * clampedDist;
      var thumbY = Math.sin(angle) * clampedDist;

      joyThumb.style.transform = "translate(" + thumbX.toFixed(1) + "px, " + thumbY.toFixed(1) + "px)";

      var normX = dx / JOY_RADIUS;
      var normY = dy / JOY_RADIUS;
      var mag = Math.min(1.0, dist / JOY_RADIUS);

      if (mag < 0.12) {
        inputDrive = 0;
        inputStrafe = 0;
      } else {
        // Up is forward (+drive), down is backward (-drive)
        inputDrive = Math.max(-1.0, Math.min(1.0, -normY));
        // Right is +strafe, left is -strafe
        inputStrafe = Math.max(-1.0, Math.min(1.0, normX));
      }

      speedLines.classList.toggle("active", currentStance === "sprint" && inputDrive > 0.15);
      sendRunnerMove();
    }

    function resetJoy() {
      joyPointerId = null;
      joyThumb.style.transform = "translate(0px, 0px)";
      inputDrive = 0;
      inputStrafe = 0;
      speedLines.classList.remove("active");
      sendRunnerMove();
    }

    joyBase.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      e.stopPropagation();
      joyPointerId = e.pointerId;
      try { joyBase.setPointerCapture(e.pointerId); } catch (_) {}
      handleJoyMove(e.clientX, e.clientY);
    });

    joyBase.addEventListener("pointermove", function (e) {
      if (e.pointerId === joyPointerId) {
        handleJoyMove(e.clientX, e.clientY);
      }
    });

    function onJoyEnd(e) {
      if (e.pointerId === joyPointerId) {
        resetJoy();
        try { joyBase.releasePointerCapture(e.pointerId); } catch (_) {}
      }
    }
    joyBase.addEventListener("pointerup", onJoyEnd);
    joyBase.addEventListener("pointercancel", onJoyEnd);

    // Jump button
    btnJump.addEventListener("click", function () {
      if (!isSniper && phase === "play" && !isJumping) {
        isJumping = true;
        jumpStartTime = Date.now();
        api.send({ k: "jump" });
        audio.play("pop");
      }
    });

    // Scope button
    btnScope.addEventListener("click", function () {
      isScoped = !isScoped;
      btnScope.classList.toggle("active", isScoped);
      scopeOverlay.classList.toggle("active", isScoped);
      audio.play("click");
      sendSniperAim();
    });

    // Fire button
    btnFire.addEventListener("click", function () {
      if (isSniper && phase === "play" && !btnFire.disabled) {
        api.send({ k: "shoot", yaw: localYaw, pitch: localPitch });
        recoilY = 0.09;
        muzzleFlash = 1.0;
        boltBar.classList.add("active");
        boltCycleTime = Date.now() + 1300;
        playGunshot();
        playBoltCycle();
      }
    });

    // Dedicated Camera Look Pointer System:
    // Tracks a dedicated lookPointerId completely isolated from the joystick pointer!
    // Prevents pointer collision tweaks where multi-touch caused violent camera jumps.
    var lookPointerId = null;
    var lookDownX = 0, lookDownY = 0, lookLastX = 0, lookLastY = 0, lookDownTime = 0;

    function handlePointerDelta(dx, dy) {
      var sensitivity = isScoped ? 0.002 : 0.0045;
      localYaw = (localYaw - dx * sensitivity + FULL_ORBIT) % FULL_ORBIT;
      localPitch = Math.max(-0.45, Math.min(0.35, localPitch - dy * sensitivity));
      if (isSniper) {
        sendSniperAim();
      } else {
        if (inputDrive !== 0 || inputStrafe !== 0) {
          sendRunnerMove();
        }
      }
    }

    viewport.addEventListener("pointerdown", function (e) {
      if (e.target !== canvas && e.target !== viewport) return;
      if (e.pointerId === joyPointerId) return;
      if (lookPointerId !== null) return;

      lookPointerId = e.pointerId;
      lookDownX = lookLastX = e.clientX;
      lookDownY = lookLastY = e.clientY;
      lookDownTime = Date.now();
      try { viewport.setPointerCapture(e.pointerId); } catch (_) {}
    });

    viewport.addEventListener("pointermove", function (e) {
      if (e.pointerId !== lookPointerId) return;
      var dx = e.clientX - lookLastX;
      var dy = e.clientY - lookLastY;
      lookLastX = e.clientX;
      lookLastY = e.clientY;
      handlePointerDelta(dx, dy);
    });

    function onLookEnd(e) {
      if (e.pointerId !== lookPointerId) return;
      var moveDist = Math.hypot(e.clientX - lookDownX, e.clientY - lookDownY);
      var duration = Date.now() - lookDownTime;
      lookPointerId = null;
      try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}

      if (isSniper && e.button === 0 && moveDist < 10 && duration < 350 && !btnFire.disabled) {
        btnFire.click();
      }
    }

    viewport.addEventListener("pointerup", onLookEnd);
    viewport.addEventListener("pointercancel", onLookEnd);

    viewport.addEventListener("contextmenu", function (e) {
      e.preventDefault();
      if (isSniper) btnScope.click();
    });

    // Keyboard support (WASD drives analog stick seamlessly in look-relative direction)
    var keys = {};
    function onKeyDown(e) {
      if (e.repeat) return;
      var k = e.key.toLowerCase();
      keys[k] = true;

      if (k === " " || k === "enter") {
        e.preventDefault();
        if (isSniper) btnFire.click();
        else btnJump.click();
      } else if (k === "c" || k === "control") {
        setStance("crawl");
      } else if (k === "z" || k === "x") {
        setStance("walk");
      } else if (k === "shift") {
        setStance("sprint");
      } else if (k === "q" || k === "e") {
        if (isSniper) btnScope.click();
      }

      checkKeyboardMovement();
    }

    function onKeyUp(e) {
      var k = e.key.toLowerCase();
      delete keys[k];
      if (k === "shift" && currentStance === "sprint") {
        setStance("walk");
      }
      checkKeyboardMovement();
    }

    function checkKeyboardMovement() {
      if (isSniper || joyPointerId !== null) return;
      var drive = 0, strafe = 0;
      if (keys["w"] || keys["arrowup"]) drive += 1;
      if (keys["s"] || keys["arrowdown"]) drive -= 0.65;
      if (keys["a"] || keys["arrowleft"]) strafe -= 1;
      if (keys["d"] || keys["arrowright"]) strafe += 1;

      inputDrive = drive;
      inputStrafe = strafe;

      var joyX = strafe * 30;
      var joyY = -drive * 30;
      joyThumb.style.transform = "translate(" + joyX + "px, " + joyY + "px)";

      speedLines.classList.toggle("active", currentStance === "sprint" && inputDrive > 0.15);
      sendRunnerMove();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Update Role Layout
    function setupRoleLayout() {
      isSniper = (sniperId === me.id);
      ui.clear(actionsBox);
      var hasNpc = players.some(function (p) { return p.is_npc || (p.id && String(p.id).indexOf("npc_") === 0); });

      if (hasNpc) {
        btnSwapRole.style.display = "inline-flex";
        btnToggleBot.style.display = "inline-flex";
        btnToggleBot.textContent = botActive ? "🤖 Bot: Running" : "🤖 Bot: Idle";
        btnToggleBot.classList.toggle("active", botActive);
      } else {
        btnSwapRole.style.display = "none";
        btnToggleBot.style.display = "none";
      }

      if (isSniper) {
        roleBadge.className = "so-role-badge is-sniper";
        roleBadge.querySelector("b").textContent = "Sniper (Tower)";
        statusMsg.textContent = "You are the Sniper. Look around the track, scope in, eliminate runners!";
        stancesBox.style.display = "none";
        joyWrap.style.display = "none";
        telemetry.style.display = "none";
        sniperAlertVignette.classList.remove("active");
        actionsBox.appendChild(ammoBox);
        actionsBox.appendChild(btnScope);
        actionsBox.appendChild(btnFire);
      } else {
        roleBadge.className = "so-role-badge is-runner";
        roleBadge.querySelector("b").textContent = "Runner (Orbit 360°)";
        statusMsg.textContent = "Run the 360° orbital track! Crawl behind low cover to stay safe!";
        stancesBox.style.display = "flex";
        joyWrap.style.display = "flex";
        telemetry.style.display = "flex";
        actionsBox.appendChild(btnJump);
      }
    }

    // 3D Math: Camera Space Transformation
    function worldToCam(x, y, z, camX, camY, camZ, camYaw, camPitch) {
      var dx = x - camX;
      var dy = y - camY;
      var dz = z - camZ;

      var cosY = Math.cos(camYaw), sinY = Math.sin(camYaw);
      var fwd = dx * cosY + dy * sinY;
      var right = dx * sinY - dy * cosY;

      var cosP = Math.cos(camPitch), sinP = Math.sin(camPitch);
      var depth = fwd * cosP + dz * sinP;
      var up = -fwd * sinP + dz * cosP;

      return { rx: right, ry: up, rz: depth };
    }

    // Sutherland-Hodgman Polygon Clipping against near plane rz >= NEAR_PLANE
    function clipPolyNear(verts, nearPlane) {
      var out = [];
      var len = verts.length;
      for (var i = 0; i < len; i++) {
        var a = verts[i];
        var b = verts[(i + 1) % len];
        var aIn = a.rz >= nearPlane;
        var bIn = b.rz >= nearPlane;
        if (aIn && bIn) {
          out.push(b);
        } else if (aIn && !bIn) {
          var t = (nearPlane - a.rz) / (b.rz - a.rz);
          out.push({
            rx: a.rx + t * (b.rx - a.rx),
            ry: a.ry + t * (b.ry - a.ry),
            rz: nearPlane
          });
        } else if (!aIn && bIn) {
          var t = (nearPlane - a.rz) / (b.rz - a.rz);
          out.push({
            rx: a.rx + t * (b.rx - a.rx),
            ry: a.ry + t * (b.ry - a.ry),
            rz: nearPlane
          });
          out.push(b);
        }
      }
      return out;
    }

    function projectCamVert(v, focal, width, height) {
      return {
        x: width / 2 + (v.rx / v.rz) * focal,
        y: height / 2 - (v.ry / v.rz) * focal,
        scale: focal / v.rz,
        depth: v.rz
      };
    }

    // Line of sight cover checker for runner
    function isRunnerCovered(runnerAng, runnerLane, runnerH) {
      for (var i = 0; i < obstacles.length; i++) {
        var obs = obstacles[i];
        var diff = Math.abs((runnerAng - obs.angle + Math.PI) % FULL_ORBIT - Math.PI);
        if (diff <= (obs.width_ang || 0.06)) {
          var t = 0.95;
          var rayZ = (TOWER_HEIGHT * (1.0 - t)) + (runnerH * t);
          if (obs.height >= rayZ) {
            return true;
          }
        }
      }
      return false;
    }

    // Main 3D Render Loop with Painter's Algorithm Depth Sorting
    function render() {
      var w = canvas.width, h = canvas.height;
      if (!w || !h) { animFrame = requestAnimationFrame(render); return; }

      var nowTime = performance.now();
      var dt = Math.min(0.1, (nowTime - lastFrameTime) / 1000);
      lastFrameTime = nowTime;

      // Recoil recovery
      if (recoilY > 0) {
        recoilY = Math.max(0, recoilY - 0.008);
      }

      // Bolt cycling
      if (boltCycleTime > 0 && Date.now() >= boltCycleTime) {
        boltCycleTime = 0;
        boltBar.classList.remove("active");
      }

      // Smooth client-side physics prediction for butter-smooth walking
      if (!isSniper && phase === "play") {
        var stanceSpeeds = { crawl: 2.1, walk: 3.9, sprint: 6.8, jump: 5.4 };
        var currentSpeed = (stanceSpeeds[currentStance] || 3.9);

        // Movement is calculated in the direction of the camera view
        var v = getRunnerVelocityFactors();

        if (v.drive !== 0) {
          var angDelta = ((v.drive * currentSpeed) / TRACK_RADIUS) * dt;
          clientAngle = Math.max(0.01, Math.min(FULL_ORBIT + 0.1, clientAngle + angDelta));
          playStep();
        }

        if (v.strafe !== 0) {
          clientLane = Math.max(-TRACK_WIDTH / 2 + 0.4, Math.min(TRACK_WIDTH / 2 - 0.4, clientLane + v.strafe * 3.2 * dt));
        }

        // Reconcile with server state
        if (myRunner && myRunner.alive) {
          var serverAng = myRunner.angle;
          if (Math.abs(serverAng - clientAngle) > 0.8) {
            clientAngle = serverAng;
          } else {
            clientAngle += (serverAng - clientAngle) * 0.15;
          }
          clientLane += ((myRunner.lane || 0) - clientLane) * 0.2;
        }

        // Jump physics
        if (isJumping) {
          var elapsed = (Date.now() - jumpStartTime) / 1000;
          if (elapsed < 0.65) {
            jumpOffset = Math.sin((elapsed / 0.65) * Math.PI) * 0.85;
          } else {
            isJumping = false;
            jumpOffset = 0;
          }
        }
      }

      // Step head bobbing
      var headBobX = 0, headBobY = 0;
      if (!isSniper && (inputDrive !== 0 || inputStrafe !== 0)) {
        var bobSpeed = currentStance === "sprint" ? 0.024 : (currentStance === "walk" ? 0.015 : 0.008);
        var bobIntensity = currentStance === "sprint" ? 0.09 : (currentStance === "walk" ? 0.04 : 0.02);
        stepCycle += bobSpeed;
        headBobY = Math.sin(stepCycle * 2) * bobIntensity;
        headBobX = Math.cos(stepCycle) * (bobIntensity * 0.4);
      }

      // Camera determination
      var camX, camY, camZ, camYaw, camPitch;
      var fov = isScoped ? 0.32 : (currentStance === "sprint" && inputDrive > 0.15 ? 1.38 : 1.25);
      var focal = (w / 2) / Math.tan(fov / 2);

      if (isSniper) {
        camX = 0; camY = 0; camZ = TOWER_HEIGHT;
        camYaw = localYaw;
        camPitch = localPitch + recoilY;

        var azDeg = Math.round(((FULL_ORBIT - localYaw) % FULL_ORBIT) * (180 / Math.PI));
        var elDeg = Math.round(localPitch * (180 / Math.PI) * 10) / 10;
        scopeAzimuth.textContent = "AZ: " + String(azDeg).padStart(3, "0") + "°";
        scopeElev.textContent = "EL: " + (elDeg >= 0 ? "+" : "") + elDeg + "°";
      } else {
        var rAng = clientAngle;
        var rLane = clientLane;
        var rRad = TRACK_RADIUS + rLane;
        camX = Math.cos(rAng) * rRad;
        camY = Math.sin(rAng) * rRad;

        var hMap = { crawl: 0.6, walk: 1.55, sprint: 1.75, jump: 2.3 };
        camZ = (hMap[currentStance] || 1.55) + headBobY + jumpOffset;

        camYaw = (rAng + Math.PI / 2 + localYaw + headBobX + FULL_ORBIT) % FULL_ORBIT;
        camPitch = localPitch;

        // Tactical cover indicator
        var covered = isRunnerCovered(rAng, rLane, camZ);
        coverBadge.className = "so-cover-badge " + (covered ? "safe" : "exposed");
        coverBadge.textContent = covered ? "🛡️ SHIELDED BY COVER" : "⚠️ EXPOSED TO SNIPER";
      }

      ctx.clearRect(0, 0, w, h);

      // 1. Sky & Horizon Ground Atmosphere
      var horizonY = h / 2 + Math.tan(camPitch) * focal;
      var clampH = Math.max(0, Math.min(h, horizonY));

      if (clampH > 0) {
        var skyGrad = ctx.createLinearGradient(0, 0, 0, clampH);
        skyGrad.addColorStop(0, "#04020a");
        skyGrad.addColorStop(1, "#120a28");
        ctx.fillStyle = skyGrad;
        ctx.fillRect(0, 0, w, clampH);

        ctx.fillStyle = "rgba(255,255,255,0.7)";
        for (var st = 1; st < 28; st++) {
          var starX = (st * 137.5) % w;
          var starY = (st * 89.3) % (clampH * 0.85);
          ctx.fillRect(starX, starY, 1.5, 1.5);
        }
      }

      if (clampH < h) {
        var groundGrad = ctx.createLinearGradient(0, clampH, 0, h);
        groundGrad.addColorStop(0, "#0e0920");
        groundGrad.addColorStop(1, "#05030b");
        ctx.fillStyle = groundGrad;
        ctx.fillRect(0, clampH, w, h - clampH);
      }

      // 2. Distant Ground Grid Rings
      ctx.strokeStyle = "rgba(45, 226, 255, 0.08)";
      ctx.lineWidth = 1;
      var gridRadii = [14, 25, 48, 62];
      for (var gr = 0; gr < gridRadii.length; gr++) {
        var gRad = gridRadii[gr];
        ctx.beginPath();
        var gStarted = false;
        for (var ga = 0; ga <= FULL_ORBIT; ga += FULL_ORBIT / 36) {
          var cPt = worldToCam(Math.cos(ga) * gRad, Math.sin(ga) * gRad, 0, camX, camY, camZ, camYaw, camPitch);
          if (cPt.rz >= NEAR_PLANE) {
            var gp = projectCamVert(cPt, focal, w, h);
            if (!gStarted) { ctx.moveTo(gp.x, gp.y); gStarted = true; }
            else ctx.lineTo(gp.x, gp.y);
          } else {
            gStarted = false;
          }
        }
        ctx.stroke();
      }

      // 3. UNIFIED RENDER QUEUE (Painter's Algorithm Depth Sorting)
      var renderList = [];

      // A) Track Segments (72 segments around 360°)
      var TOTAL_TRACK_SEGMENTS = 72;
      for (var seg = 0; seg < TOTAL_TRACK_SEGMENTS; seg++) {
        var a1 = (seg / TOTAL_TRACK_SEGMENTS) * FULL_ORBIT;
        var a2 = ((seg + 1) / TOTAL_TRACK_SEGMENTS) * FULL_ORBIT;
        var sIndex = Math.min(3, Math.floor((seg / TOTAL_TRACK_SEGMENTS) * 4));
        var secTheme = sectors[sIndex] || { color: "#ffaa33", ground: "#22170f", accent: "#f5c542" };

        var wIn = TRACK_RADIUS - TRACK_WIDTH / 2;
        var wOut = TRACK_RADIUS + TRACK_WIDTH / 2;

        var vIn1 = { x: Math.cos(a1) * wIn, y: Math.sin(a1) * wIn, z: 0 };
        var vOut1 = { x: Math.cos(a1) * wOut, y: Math.sin(a1) * wOut, z: 0 };
        var vOut2 = { x: Math.cos(a2) * wOut, y: Math.sin(a2) * wOut, z: 0 };
        var vIn2 = { x: Math.cos(a2) * wIn, y: Math.sin(a2) * wIn, z: 0 };

        var midA = (a1 + a2) / 2;
        var midX = Math.cos(midA) * TRACK_RADIUS;
        var midY = Math.sin(midA) * TRACK_RADIUS;
        var dist = Math.hypot(midX - camX, midY - camY, 0 - camZ);

        renderList.push({
          type: "track_segment",
          dist: dist,
          verts: [vIn1, vOut1, vOut2, vIn2],
          seg: seg,
          theme: secTheme,
          a1: a1,
          a2: a2
        });
      }

      // B) Sector Gates / Holographic Arches
      for (var gIdx = 0; gIdx < 4; gIdx++) {
        var gAngle = gIdx * (FULL_ORBIT / 4);
        var gSec = sectors[gIdx] || { color: "#ffaa33", name: "Sector " + (gIdx + 1) };
        var gDist = Math.hypot(Math.cos(gAngle) * TRACK_RADIUS - camX, Math.sin(gAngle) * TRACK_RADIUS - camY, 0 - camZ);

        renderList.push({
          type: "arch",
          dist: gDist,
          angle: gAngle,
          theme: gSec,
          index: gIdx
        });
      }

      // C) Massive Sci-Fi Extraction Bunker at Finish Line (360°)
      var bkAngle = 0.0;
      var bkCenterX = Math.cos(bkAngle) * TRACK_RADIUS;
      var bkCenterY = Math.sin(bkAngle) * TRACK_RADIUS;
      var bkDist = Math.hypot(bkCenterX - camX, bkCenterY - camY, 2.8 - camZ);
      renderList.push({
        type: "bunker",
        dist: bkDist,
        angle: bkAngle
      });

      // D) Central Sniper Tower
      var towerDist = Math.hypot(0 - camX, 0 - camY, TOWER_HEIGHT / 2 - camZ);
      renderList.push({
        type: "tower",
        dist: towerDist
      });

      // E) Obstacles (Extruded 3D Boxes)
      obstacles.forEach(function (obs) {
        var oR = TRACK_RADIUS + obs.lane;
        var ox = Math.cos(obs.angle) * oR;
        var oy = Math.sin(obs.angle) * oR;
        var oDist = Math.hypot(ox - camX, oy - camY, obs.height / 2 - camZ);

        renderList.push({
          type: "obstacle",
          dist: oDist,
          obs: obs,
          x: ox,
          y: oy
        });
      });

      // F) Runners (Other players & Bots)
      for (var rId in runnersState) {
        var r = runnersState[rId];
        if (!r.alive) continue;
        if (!isSniper && rId === me.id) continue;

        var rRad = TRACK_RADIUS + r.lane;
        var rx = Math.cos(r.angle) * rRad;
        var ry = Math.sin(r.angle) * rRad;
        var hMap = { crawl: 0.65, walk: 1.55, sprint: 1.8, jump: 2.3 };
        var rz = hMap[r.stance] || 1.55;
        var rDist = Math.hypot(rx - camX, ry - camY, rz - camZ);

        renderList.push({
          type: "runner",
          dist: rDist,
          runner: r,
          x: rx,
          y: ry,
          z: rz
        });
      }

      // G) Bullet Tracer
      if (tracer && tracer.t < 1.0) {
        var trMidX = (tracer.from[0] + tracer.to[0]) / 2;
        var trMidY = (tracer.from[1] + tracer.to[1]) / 2;
        var trDist = Math.hypot(trMidX - camX, trMidY - camY, 1.5 - camZ);
        renderList.push({
          type: "tracer",
          dist: trDist,
          tracer: tracer
        });
      }

      // Sort Back-To-Front (Furthest distance drawn first)
      renderList.sort(function (a, b) { return b.dist - a.dist; });

      // Render Each Sorted 3D Element
      for (var i = 0; i < renderList.length; i++) {
        var item = renderList[i];

        if (item.type === "track_segment") {
          var cVerts = item.verts.map(function (v) {
            return worldToCam(v.x, v.y, v.z, camX, camY, camZ, camYaw, camPitch);
          });
          var clipped = clipPolyNear(cVerts, NEAR_PLANE);

          if (clipped.length >= 3) {
            var screenPoly = clipped.map(function (v) {
              return projectCamVert(v, focal, w, h);
            });

            ctx.fillStyle = (item.seg % 2 === 0) ? (item.theme.ground || "#181429") : "#110e1e";
            ctx.beginPath();
            ctx.moveTo(screenPoly[0].x, screenPoly[0].y);
            for (var pIdx = 1; pIdx < screenPoly.length; pIdx++) {
              ctx.lineTo(screenPoly[pIdx].x, screenPoly[pIdx].y);
            }
            ctx.closePath();
            ctx.fill();

            // Outer curb strip
            var pOut1 = worldToCam(item.verts[1].x, item.verts[1].y, 0, camX, camY, camZ, camYaw, camPitch);
            var pOut2 = worldToCam(item.verts[2].x, item.verts[2].y, 0, camX, camY, camZ, camYaw, camPitch);
            var curbClipped = clipPolyNear([pOut1, pOut2], NEAR_PLANE);
            if (curbClipped.length >= 2) {
              var sc1 = projectCamVert(curbClipped[0], focal, w, h);
              var sc2 = projectCamVert(curbClipped[1], focal, w, h);
              ctx.strokeStyle = (item.seg % 2 === 0) ? (item.theme.color || "#ffaa33") : "#ffffff";
              ctx.lineWidth = 2.5;
              ctx.beginPath();
              ctx.moveTo(sc1.x, sc1.y);
              ctx.lineTo(sc2.x, sc2.y);
              ctx.stroke();
            }

            // Inner curb strip
            var pIn1 = worldToCam(item.verts[0].x, item.verts[0].y, 0, camX, camY, camZ, camYaw, camPitch);
            var pIn2 = worldToCam(item.verts[3].x, item.verts[3].y, 0, camX, camY, camZ, camYaw, camPitch);
            var inClipped = clipPolyNear([pIn1, pIn2], NEAR_PLANE);
            if (inClipped.length >= 2) {
              var sci1 = projectCamVert(inClipped[0], focal, w, h);
              var sci2 = projectCamVert(inClipped[1], focal, w, h);
              ctx.strokeStyle = item.theme.color || "#ffaa33";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(sci1.x, sci1.y);
              ctx.lineTo(sci2.x, sci2.y);
              ctx.stroke();
            }

            // Dashed center lane
            if (item.seg % 2 === 0) {
              var midA1 = (item.a1 + item.a2) / 2;
              var midA2 = item.a2;
              var cM1 = worldToCam(Math.cos(midA1) * TRACK_RADIUS, Math.sin(midA1) * TRACK_RADIUS, 0, camX, camY, camZ, camYaw, camPitch);
              var cM2 = worldToCam(Math.cos(midA2) * TRACK_RADIUS, Math.sin(midA2) * TRACK_RADIUS, 0, camX, camY, camZ, camYaw, camPitch);
              var midClipped = clipPolyNear([cM1, cM2], NEAR_PLANE);
              if (midClipped.length >= 2) {
                var scm1 = projectCamVert(midClipped[0], focal, w, h);
                var scm2 = projectCamVert(midClipped[1], focal, w, h);
                ctx.strokeStyle = "rgba(255, 235, 59, 0.75)";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(scm1.x, scm1.y);
                ctx.lineTo(scm2.x, scm2.y);
                ctx.stroke();
              }
            }
          }
        } else if (item.type === "arch") {
          var aRadIn = TRACK_RADIUS - TRACK_WIDTH / 2 - 0.4;
          var aRadOut = TRACK_RADIUS + TRACK_WIDTH / 2 + 0.4;
          var cIn = worldToCam(Math.cos(item.angle) * aRadIn, Math.sin(item.angle) * aRadIn, 0, camX, camY, camZ, camYaw, camPitch);
          var cOut = worldToCam(Math.cos(item.angle) * aRadOut, Math.sin(item.angle) * aRadOut, 0, camX, camY, camZ, camYaw, camPitch);
          var cTopIn = worldToCam(Math.cos(item.angle) * aRadIn, Math.sin(item.angle) * aRadIn, 5.5, camX, camY, camZ, camYaw, camPitch);
          var cTopOut = worldToCam(Math.cos(item.angle) * aRadOut, Math.sin(item.angle) * aRadOut, 5.5, camX, camY, camZ, camYaw, camPitch);

          if (cIn.rz >= NEAR_PLANE && cOut.rz >= NEAR_PLANE && cTopIn.rz >= NEAR_PLANE && cTopOut.rz >= NEAR_PLANE) {
            var pIn = projectCamVert(cIn, focal, w, h);
            var pOut = projectCamVert(cOut, focal, w, h);
            var pTopIn = projectCamVert(cTopIn, focal, w, h);
            var pTopOut = projectCamVert(cTopOut, focal, w, h);

            ctx.strokeStyle = item.theme.color || "#ffaa33";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(pIn.x, pIn.y);
            ctx.lineTo(pTopIn.x, pTopIn.y);
            ctx.lineTo(pTopOut.x, pTopOut.y);
            ctx.lineTo(pOut.x, pOut.y);
            ctx.stroke();

            if (pTopIn.scale > 0.08) {
              ctx.fillStyle = item.theme.color || "#ffaa33";
              ctx.font = "bold 10px var(--font-d, sans-serif)";
              ctx.textAlign = "center";
              ctx.fillText("GATE " + (item.index + 1) + ": " + (item.theme.name || "").toUpperCase(), (pTopIn.x + pTopOut.x) / 2, Math.min(pTopIn.y, pTopOut.y) - 6);
            }
          }
        } else if (item.type === "bunker") {
          var bAngle = item.angle;
          var halfAng = 0.038;
          var a1 = bAngle - halfAng;
          var a2 = bAngle + halfAng;
          var rIn = TRACK_RADIUS - TRACK_WIDTH / 2;
          var rOut = TRACK_RADIUS + TRACK_WIDTH / 2;

          // 1. Extraction Landing Pad on Ground (z = 0.02)
          var padA1 = bAngle - 0.055, padA2 = bAngle + 0.055;
          var padVerts = [
            { x: Math.cos(padA1) * rIn, y: Math.sin(padA1) * rIn, z: 0.02 },
            { x: Math.cos(padA2) * rIn, y: Math.sin(padA2) * rIn, z: 0.02 },
            { x: Math.cos(padA2) * rOut, y: Math.sin(padA2) * rOut, z: 0.02 },
            { x: Math.cos(padA1) * rOut, y: Math.sin(padA1) * rOut, z: 0.02 }
          ];
          var cPad = padVerts.map(function (v) { return worldToCam(v.x, v.y, v.z, camX, camY, camZ, camYaw, camPitch); });
          var padClipped = clipPolyNear(cPad, NEAR_PLANE);
          if (padClipped.length >= 3) {
            var padScreen = padClipped.map(function (v) { return projectCamVert(v, focal, w, h); });
            ctx.fillStyle = "rgba(10, 22, 40, 0.9)";
            ctx.strokeStyle = "rgba(45, 226, 255, 0.75)";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(padScreen[0].x, padScreen[0].y);
            for (var pi = 1; pi < padScreen.length; pi++) ctx.lineTo(padScreen[pi].x, padScreen[pi].y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Diagonal hazard finish threshold line across the track
            var thLine1 = worldToCam(Math.cos(bAngle) * rIn, Math.sin(bAngle) * rIn, 0.04, camX, camY, camZ, camYaw, camPitch);
            var thLine2 = worldToCam(Math.cos(bAngle) * rOut, Math.sin(bAngle) * rOut, 0.04, camX, camY, camZ, camYaw, camPitch);
            var thClipped = clipPolyNear([thLine1, thLine2], NEAR_PLANE);
            if (thClipped.length >= 2) {
              var scTh1 = projectCamVert(thClipped[0], focal, w, h);
              var scTh2 = projectCamVert(thClipped[1], focal, w, h);
              ctx.strokeStyle = "#00f0ff";
              ctx.lineWidth = 3.5;
              ctx.beginPath();
              ctx.moveTo(scTh1.x, scTh1.y);
              ctx.lineTo(scTh2.x, scTh2.y);
              ctx.stroke();
            }
          }

          // 2. 3D Fortified Architecture (Left Pylon, Right Pylon, Overhead Arch)
          var rL1 = rIn - 1.8, rL2 = rIn + 0.3;
          var rR1 = rOut - 0.3, rR2 = rOut + 1.8;
          var rA1 = rIn + 0.3, rA2 = rOut - 0.3;

          var bunkerFaces = [];
          function addBunkerBox(ba1, ba2, br1, br2, bz1, bz2, wallColor, topColor) {
            var p1 = { x: Math.cos(ba1) * br1, y: Math.sin(ba1) * br1 };
            var p2 = { x: Math.cos(ba2) * br1, y: Math.sin(ba2) * br1 };
            var p3 = { x: Math.cos(ba2) * br2, y: Math.sin(ba2) * br2 };
            var p4 = { x: Math.cos(ba1) * br2, y: Math.sin(ba1) * br2 };

            var fList = [
              // Front Face (facing runners along track approach)
              { verts: [{x:p1.x, y:p1.y, z:bz1}, {x:p4.x, y:p4.y, z:bz1}, {x:p4.x, y:p4.y, z:bz2}, {x:p1.x, y:p1.y, z:bz2}], fill: wallColor },
              // Back Face
              { verts: [{x:p3.x, y:p3.y, z:bz1}, {x:p2.x, y:p2.y, z:bz1}, {x:p2.x, y:p2.y, z:bz2}, {x:p3.x, y:p3.y, z:bz2}], fill: wallColor },
              // Inner Side Face
              { verts: [{x:p2.x, y:p2.y, z:bz1}, {x:p1.x, y:p1.y, z:bz1}, {x:p1.x, y:p1.y, z:bz2}, {x:p2.x, y:p2.y, z:bz2}], fill: wallColor },
              // Outer Side Face
              { verts: [{x:p4.x, y:p4.y, z:bz1}, {x:p3.x, y:p3.y, z:bz1}, {x:p3.x, y:p3.y, z:bz2}, {x:p4.x, y:p4.y, z:bz2}], fill: wallColor },
              // Top Face
              { verts: [{x:p1.x, y:p1.y, z:bz2}, {x:p2.x, y:p2.y, z:bz2}, {x:p3.x, y:p3.y, z:bz2}, {x:p4.x, y:p4.y, z:bz2}], fill: topColor }
            ];
            if (bz1 > 0) {
              // Bottom Face (for overhead archway ceiling)
              fList.push({ verts: [{x:p4.x, y:p4.y, z:bz1}, {x:p3.x, y:p3.y, z:bz1}, {x:p2.x, y:p2.y, z:bz1}, {x:p1.x, y:p1.y, z:bz1}], fill: wallColor });
            }
            fList.forEach(function (f) {
              var cx = (f.verts[0].x + f.verts[1].x + f.verts[2].x + f.verts[3].x) / 4;
              var cy = (f.verts[0].y + f.verts[1].y + f.verts[2].y + f.verts[3].y) / 4;
              var cz = (f.verts[0].z + f.verts[1].z + f.verts[2].z + f.verts[3].z) / 4;
              f.dist = Math.hypot(cx - camX, cy - camY, cz - camZ);
              bunkerFaces.push(f);
            });
          }

          // Left Inner Pylon (0 to 5.6m height)
          addBunkerBox(a1, a2, rL1, rL2, 0, 5.6, "#0b1424", "#14233e");
          // Right Outer Pylon (0 to 5.6m height)
          addBunkerBox(a1, a2, rR1, rR2, 0, 5.6, "#0b1424", "#14233e");
          // Overhead Transverse Bridge Arch (4.3m to 5.6m height)
          addBunkerBox(a1, a2, rA1, rA2, 4.3, 5.6, "#101d36", "#1c325c");

          // Sort Bunker Faces Back-to-Front
          bunkerFaces.sort(function (a, b) { return b.dist - a.dist; });
          bunkerFaces.forEach(function (f) {
            var cVerts = f.verts.map(function (v) { return worldToCam(v.x, v.y, v.z, camX, camY, camZ, camYaw, camPitch); });
            var clipped = clipPolyNear(cVerts, NEAR_PLANE);
            if (clipped.length >= 3) {
              var sPoly = clipped.map(function (v) { return projectCamVert(v, focal, w, h); });
              ctx.fillStyle = f.fill;
              ctx.strokeStyle = "rgba(45, 226, 255, 0.65)";
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.moveTo(sPoly[0].x, sPoly[0].y);
              for (var si = 1; si < sPoly.length; si++) ctx.lineTo(sPoly[si].x, sPoly[si].y);
              ctx.closePath();
              ctx.fill();
              ctx.stroke();
            }
          });

          // 3. Holographic Force-Field Curtain inside Arch Opening
          var gateVerts = [
            { x: Math.cos(bAngle) * rA1, y: Math.sin(bAngle) * rA1, z: 0.05 },
            { x: Math.cos(bAngle) * rA2, y: Math.sin(bAngle) * rA2, z: 0.05 },
            { x: Math.cos(bAngle) * rA2, y: Math.sin(bAngle) * rA2, z: 4.3 },
            { x: Math.cos(bAngle) * rA1, y: Math.sin(bAngle) * rA1, z: 4.3 }
          ];
          var cGate = gateVerts.map(function (v) { return worldToCam(v.x, v.y, v.z, camX, camY, camZ, camYaw, camPitch); });
          var gateClipped = clipPolyNear(cGate, NEAR_PLANE);
          if (gateClipped.length >= 3) {
            var sGate = gateClipped.map(function (v) { return projectCamVert(v, focal, w, h); });
            ctx.fillStyle = "rgba(45, 226, 255, 0.18)";
            ctx.strokeStyle = "rgba(0, 240, 255, 0.85)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sGate[0].x, sGate[0].y);
            for (var gi = 1; gi < sGate.length; gi++) ctx.lineTo(sGate[gi].x, sGate[gi].y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }

          // 4. Vertical Ion Sky Beacon from Arch Emitter (z = 5.6 to 48.0)
          var midX = Math.cos(bAngle) * TRACK_RADIUS;
          var midY = Math.sin(bAngle) * TRACK_RADIUS;
          var cBeamBase = worldToCam(midX, midY, 5.6, camX, camY, camZ, camYaw, camPitch);
          var cBeamTop = worldToCam(midX, midY, 48.0, camX, camY, camZ, camYaw, camPitch);
          var beamClipped = clipPolyNear([cBeamBase, cBeamTop], NEAR_PLANE);
          if (beamClipped.length >= 2) {
            var pB1 = projectCamVert(beamClipped[0], focal, w, h);
            var pB2 = projectCamVert(beamClipped[1], focal, w, h);
            var beamW = Math.max(3, Math.min(16, 5.0 * pB1.scale));
            var beamGrad = ctx.createLinearGradient(pB1.x, pB1.y, pB2.x, pB2.y);
            beamGrad.addColorStop(0, "rgba(45, 226, 255, 0.85)");
            beamGrad.addColorStop(1, "rgba(45, 226, 255, 0)");
            ctx.strokeStyle = beamGrad;
            ctx.lineWidth = beamW;
            ctx.beginPath();
            ctx.moveTo(pB1.x, pB1.y);
            ctx.lineTo(pB2.x, pB2.y);
            ctx.stroke();
          }

          // 5. 3D-Anchored Holographic HUD Sign (z = 6.4)
          var cSign = worldToCam(midX, midY, 6.4, camX, camY, camZ, camYaw, camPitch);
          if (cSign.rz >= NEAR_PLANE) {
            var pSign = projectCamVert(cSign, focal, w, h);
            if (pSign.scale > 0.06) {
              var badgeW = Math.min(180, Math.max(100, pSign.scale * 12));
              var badgeH = Math.min(32, Math.max(18, pSign.scale * 2.2));
              ctx.fillStyle = "rgba(7, 16, 31, 0.9)";
              ctx.strokeStyle = "#2de2ff";
              ctx.lineWidth = 1.5;
              ctx.fillRect(pSign.x - badgeW / 2, pSign.y - badgeH / 2, badgeW, badgeH);
              ctx.strokeRect(pSign.x - badgeW / 2, pSign.y - badgeH / 2, badgeW, badgeH);
              ctx.fillStyle = "#ffffff";
              ctx.font = "bold " + Math.max(9, Math.min(13, Math.round(badgeH * 0.42))) + "px var(--font-d, sans-serif)";
              ctx.textAlign = "center";
              ctx.fillText("★ EXTRACTION BUNKER ★", pSign.x, pSign.y - 2);
              ctx.fillStyle = "#2de2ff";
              ctx.font = "bold " + Math.max(8, Math.min(10, Math.round(badgeH * 0.32))) + "px monospace";
              ctx.fillText("360° ESCAPE ZONE", pSign.x, pSign.y + Math.round(badgeH * 0.32));
            }
          }
        } else if (item.type === "tower") {
          var cTBase = worldToCam(0, 0, 0, camX, camY, camZ, camYaw, camPitch);
          var cTTop = worldToCam(0, 0, TOWER_HEIGHT, camX, camY, camZ, camYaw, camPitch);

          if (cTBase.rz >= NEAR_PLANE && cTTop.rz >= NEAR_PLANE) {
            var pTBase = projectCamVert(cTBase, focal, w, h);
            var pTTop = projectCamVert(cTTop, focal, w, h);

            var towerW = Math.max(14, 40 * pTBase.scale);
            ctx.fillStyle = "#1e1338";
            ctx.strokeStyle = "#8b5cf6";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(pTBase.x - towerW, pTBase.y);
            ctx.lineTo(pTTop.x - towerW * 0.65, pTTop.y);
            ctx.lineTo(pTTop.x + towerW * 0.65, pTTop.y);
            ctx.lineTo(pTBase.x + towerW, pTBase.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            var platW = Math.max(16, 60 * pTTop.scale);
            ctx.fillStyle = "#3a226b";
            ctx.fillRect(pTTop.x - platW / 2, pTTop.y - 12 * pTTop.scale, platW, 14 * pTTop.scale);

            if (!isSniper) {
              var snipAim = sniperState.yaw || 0;
              var diff = Math.abs((snipAim - clientAngle + Math.PI) % FULL_ORBIT - Math.PI);
              if (diff < 0.55) {
                glintWarning.style.display = "flex";
                sniperAlertVignette.classList.add("active");
                var flareR = Math.max(8, (16 + Math.sin(Date.now() * 0.025) * 8) * pTTop.scale);
                var flareGrad = ctx.createRadialGradient(pTTop.x, pTTop.y, 0, pTTop.x, pTTop.y, flareR);
                flareGrad.addColorStop(0, "#ffffff");
                flareGrad.addColorStop(0.35, "#ff2a6d");
                flareGrad.addColorStop(1, "transparent");
                ctx.fillStyle = flareGrad;
                ctx.beginPath();
                ctx.arc(pTTop.x, pTTop.y, flareR, 0, Math.PI * 2);
                ctx.fill();
              } else {
                glintWarning.style.display = "none";
                sniperAlertVignette.classList.remove("active");
              }
            }
          }
        } else if (item.type === "obstacle") {
          var obs = item.obs;
          var wRad = obs.width_ang || 0.055;
          var halfW = wRad / 2;
          var oR = TRACK_RADIUS + obs.lane;
          var dR = (obs.depth_rad || 1.4) / 2;

          var boxVerts = [
            { x: Math.cos(obs.angle - halfW) * (oR - dR), y: Math.sin(obs.angle - halfW) * (oR - dR), z: 0 },
            { x: Math.cos(obs.angle + halfW) * (oR - dR), y: Math.sin(obs.angle + halfW) * (oR - dR), z: 0 },
            { x: Math.cos(obs.angle + halfW) * (oR + dR), y: Math.sin(obs.angle + halfW) * (oR + dR), z: 0 },
            { x: Math.cos(obs.angle - halfW) * (oR + dR), y: Math.sin(obs.angle - halfW) * (oR + dR), z: 0 },
            { x: Math.cos(obs.angle - halfW) * (oR - dR), y: Math.sin(obs.angle - halfW) * (oR - dR), z: obs.height },
            { x: Math.cos(obs.angle + halfW) * (oR - dR), y: Math.sin(obs.angle + halfW) * (oR - dR), z: obs.height },
            { x: Math.cos(obs.angle + halfW) * (oR + dR), y: Math.sin(obs.angle + halfW) * (oR + dR), z: obs.height },
            { x: Math.cos(obs.angle - halfW) * (oR + dR), y: Math.sin(obs.angle - halfW) * (oR + dR), z: obs.height }
          ];

          var camBox = boxVerts.map(function (v) {
            return worldToCam(v.x, v.y, v.z, camX, camY, camZ, camYaw, camPitch);
          });

          // Draw Front Face (0, 1, 5, 4)
          var fClipped = clipPolyNear([camBox[0], camBox[1], camBox[5], camBox[4]], NEAR_PLANE);
          if (fClipped.length >= 3) {
            var fScreen = fClipped.map(function (v) { return projectCamVert(v, focal, w, h); });
            ctx.fillStyle = obs.color || "#888";
            ctx.strokeStyle = "rgba(255,255,255,0.6)";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(fScreen[0].x, fScreen[0].y);
            for (var fi = 1; fi < fScreen.length; fi++) ctx.lineTo(fScreen[fi].x, fScreen[fi].y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }

          // Draw Top Face (4, 5, 6, 7)
          var topClipped = clipPolyNear([camBox[4], camBox[5], camBox[6], camBox[7]], NEAR_PLANE);
          if (topClipped.length >= 3) {
            var topScreen = topClipped.map(function (v) { return projectCamVert(v, focal, w, h); });
            ctx.fillStyle = "rgba(255,255,255,0.22)";
            ctx.strokeStyle = "rgba(255,255,255,0.7)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(topScreen[0].x, topScreen[0].y);
            for (var ti = 1; ti < topScreen.length; ti++) ctx.lineTo(topScreen[ti].x, topScreen[ti].y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            if (topScreen[0].scale > 0.09) {
              ctx.fillStyle = "#fff";
              ctx.font = "bold 9px var(--font-d, sans-serif)";
              ctx.textAlign = "center";
              ctx.fillText(obs.is_high ? "HIGH COVER (2.8m)" : "LOW COVER (1.35m)", topScreen[0].x, topScreen[0].y - 5);
            }
          }
        } else if (item.type === "runner") {
          var runnerObj = item.runner;
          var cFeet = worldToCam(item.x, item.y, 0, camX, camY, camZ, camYaw, camPitch);
          var cHead = worldToCam(item.x, item.y, item.z, camX, camY, camZ, camYaw, camPitch);

          if (cFeet.rz >= NEAR_PLANE && cHead.rz >= NEAR_PLANE) {
            var pFeet = projectCamVert(cFeet, focal, w, h);
            var pHead = projectCamVert(cHead, focal, w, h);

            var pInfo = byId[runnerObj.id];
            var rColor = pInfo ? ui.color(pInfo.color) : "#2de2ff";
            var rName = pInfo ? pInfo.name : "Runner";

            var runnerH = Math.max(14, pFeet.y - pHead.y);
            var runnerW = Math.max(10, runnerH * 0.45);

            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            ctx.beginPath();
            ctx.ellipse(pFeet.x, pFeet.y, runnerW * 0.8, runnerW * 0.35, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = rColor;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(pHead.x - runnerW / 2, pHead.y, runnerW, runnerH, 4);
            } else {
              ctx.rect(pHead.x - runnerW / 2, pHead.y, runnerW, runnerH);
            }
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(pHead.x, pHead.y, runnerW * 0.4, 0, Math.PI * 2);
            ctx.fillStyle = "#fff";
            ctx.fill();

            ctx.fillStyle = "#fff";
            ctx.font = "bold 11px var(--font-d, sans-serif)";
            ctx.textAlign = "center";
            ctx.fillText(rName + " [" + (runnerObj.stance || "walk").toUpperCase() + "]", pHead.x, pHead.y - 8);

            if (isSniper && isScoped) {
              var crossDist = Math.hypot(pHead.x - w / 2, pHead.y - h / 2);
              if (crossDist < 60) {
                ctx.strokeStyle = "#ff4fa3";
                ctx.lineWidth = 2;
                var pad = 12;
                ctx.strokeRect(pHead.x - runnerW / 2 - pad, pHead.y - pad, runnerW + pad * 2, runnerH + pad * 2);
                ctx.fillStyle = "#ff4fa3";
                ctx.font = "bold 10px monospace";
                ctx.fillText("TARGET LOCK: " + Math.round(item.dist * 10) / 10 + "m", pHead.x, pFeet.y + 16);
              }
            }
          }
        } else if (item.type === "tracer") {
          var tr = item.tracer;
          tr.t += 0.14;
          var c1 = worldToCam(tr.from[0], tr.from[1], tr.from[2], camX, camY, camZ, camYaw, camPitch);
          var c2 = worldToCam(tr.to[0], tr.to[1], tr.to[2], camX, camY, camZ, camYaw, camPitch);
          if (c1.rz >= NEAR_PLANE && c2.rz >= NEAR_PLANE) {
            var sc1 = projectCamVert(c1, focal, w, h);
            var sc2 = projectCamVert(c2, focal, w, h);
            ctx.strokeStyle = "#ff4fa3";
            ctx.lineWidth = 3.5;
            ctx.beginPath();
            ctx.moveTo(sc1.x, sc1.y);
            ctx.lineTo(sc2.x, sc2.y);
            ctx.stroke();
          }
        }
      }

      // 4. Sniper Muzzle Flash Blast
      if (muzzleFlash > 0) {
        muzzleFlash -= 0.08;
        ctx.fillStyle = "rgba(255, 255, 255, " + (muzzleFlash * 0.45) + ")";
        ctx.fillRect(0, 0, w, h);
      }

      // Update radar display
      updateRadarDisplay();

      animFrame = requestAnimationFrame(render);
    }

    // Mini Radar Display Update
    function updateRadarDisplay() {
      var rCenter = 36;
      var rRadius = 25;

      for (var pid in runnersState) {
        var r = runnersState[pid];
        var dot = radarDots[pid];
        if (!dot) {
          dot = h("div", { class: "so-radar-dot" + (pid === me.id ? " me" : "") });
          radar.appendChild(dot);
          radarDots[pid] = dot;
        }
        if (!r.alive) {
          dot.style.display = "none";
          continue;
        }
        dot.style.display = "block";
        var ang = r.angle || 0;
        var dx = Math.cos(ang) * rRadius;
        var dy = Math.sin(ang) * rRadius;
        dot.style.left = (rCenter + dx) + "px";
        dot.style.top = (rCenter + dy) + "px";
      }
    }

    // Match Tick countdown
    function tick() {
      if (phase !== "play") return;
      var left = Math.max(0, (tEnd - Date.now()) / 1000);
      timerVal.textContent = String(Math.ceil(left));
    }

    // Server Message Handling
    return {
      message: function (d) {
        if (d.k === "count") {
          statusMsg.textContent = "Match starts in " + d.n + "...";
          audio.play("count");
        } else if (d.k === "go") {
          phase = "play";
          tEnd = Date.now() + d.dur * 1000;
          sniperId = d.sniper;
          sectors = d.sectors || [];
          obstacles = d.obstacles || [];
          botActive = !!d.bot_active;
          setupRoleLayout();
          audio.play("go");
          clearInterval(timer);
          timer = setInterval(tick, 100);
          tick();
          if (!animFrame) animFrame = requestAnimationFrame(render);
        } else if (d.k === "state" || d.k === "sync") {
          phase = d.phase;
          if (d.left != null) tEnd = Date.now() + d.left * 1000;
          if (d.sectors) sectors = d.sectors;
          if (d.obstacles) obstacles = d.obstacles;
          if (d.bot_active != null) {
            botActive = d.bot_active;
            btnToggleBot.textContent = botActive ? "🤖 Bot: Running" : "🤖 Bot: Idle";
            btnToggleBot.classList.toggle("active", botActive);
          }

          var sid = d.sniper_id || (d.sniper && d.sniper.id) || sniperId;
          if (sid !== sniperId) {
            sniperId = sid;
            setupRoleLayout();
          }

          if (d.sniper && typeof d.sniper === "object") {
            sniperState = d.sniper;
            ammoVal.textContent = (sniperState.ammo != null ? sniperState.ammo : 5) + "/5";
            ui.clear(ammoPips);
            for (var a = 0; a < 5; a++) {
              ammoPips.appendChild(h("div", { class: "so-ammo-pip" + (a < sniperState.ammo ? "" : " empty") }));
            }
            btnFire.disabled = sniperState.ammo <= 0 || sniperState.reloading;
          }

          if (d.runners && Array.isArray(d.runners)) {
            d.runners.forEach(function (r) {
              runnersState[r.id] = r;
              if (r.id === me.id) {
                myRunner = r;
                progressFill.style.width = r.pct + "%";
                var secNum = Math.min(4, Math.floor(r.pct / 25) + 1);
                var secName = sectors[secNum - 1] ? sectors[secNum - 1].name : "Sector " + secNum;
                sectorTag.textContent = "Sector " + secNum + ": " + secName;

                var distRemaining = Math.max(0, Math.round((1.0 - (r.angle / FULL_ORBIT)) * (TRACK_RADIUS * FULL_ORBIT)));
                distanceTag.textContent = distRemaining + "m to Bunker";
              }
            });
          }

          if (!isSniper && myRunner && !myRunner.alive) {
            statusMsg.textContent = "You were eliminated by the Sniper!";
          }
        } else if (d.k === "sniper_shot") {
          playGunshot();
          var sRad = TRACK_RADIUS;
          var tx = Math.cos(d.yaw) * sRad;
          var ty = Math.sin(d.yaw) * sRad;
          tracer = { from: [0, 0, TOWER_HEIGHT], to: [tx, ty, 1.2], t: 0 };
          if (d.hit) {
            playHitmarker();
            if (d.hit === me.id) {
              statusMsg.textContent = "Direct hit! You have been eliminated!";
              ui.vibrate(200);
            }
          } else if (d.blocked_by) {
            audio.play("tap");
            if (!isSniper) {
              statusMsg.textContent = "Bullet deflected by " + d.blocked_by + "!";
            }
          }
        } else if (d.k === "runner_down") {
          audio.play("whoosh");
          var fallen = byId[d.pid] ? byId[d.pid].name : "Runner";
          statusMsg.textContent = fallen + " was eliminated by the sniper!";
        } else if (d.k === "sniper_reloading") {
          statusMsg.textContent = "Sniper is reloading... SPRINT NOW!";
          audio.play("click");
        } else if (d.k === "reloaded") {
          btnFire.disabled = false;
        } else if (d.k === "runner_jumped") {
          audio.play("pop");
        } else if (d.k === "end") {
          phase = "done";
          clearInterval(timer);
          statusMsg.textContent = d.msg || "Game over!";
          audio.play("whoosh");
        }
      },
      destroy: function () {
        if (animFrame) cancelAnimationFrame(animFrame);
        clearInterval(timer);
        window.removeEventListener("resize", resize);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
      }
    };
  }
});
