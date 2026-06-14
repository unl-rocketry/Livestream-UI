/* ═══════════════════════════════════════════════════════════════════
   VORTEX LAUNCH OVERLAY — telemetry.js
   ───────────────────────────────────────────────────────────────────
   This file owns everything related to DATA:
     • connecting to the live telemetry stream (WebSocket)
     • parsing raw flight-computer JSON packets
     • computing derived values (velocity, timeline position, phase)
     • pushing those values into the overlay's DOM elements

   overlay.html owns everything related to LAYOUT (markup + CSS) and
   does not need to be touched when the data source changes — only
   the CONNECTION CONFIG section below should need edits.
═══════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════
   1. CONNECTION CONFIG  ← edit this section for your setup
═══════════════════════════════════════════════════════════════════ */
const TELEMETRY_CONFIG = {
  /*
    WebSocket URL of the telemetry server (see server.py from earlier).
    Leave null to disable auto-connect — useful if you're feeding
    the overlay manually via window.ingestPacket() / updateTelemetry()
    from the browser console or another script.
  */
  wsUrl: 'ws://localhost:8765/ws',

  /* Milliseconds to wait before retrying a dropped connection */
  reconnectMs: 3000,
};


/* ═══════════════════════════════════════════════════════════════════
   2. OVERLAY CONSTANTS
═══════════════════════════════════════════════════════════════════ */
const ALT_MAX  = 15000;   // ft — full-scale gauge arc
const ALT_GOAL = 10000;   // ft — competition target (gold tick position)
const VEL_MAX  = 1000;    // mph — full-scale gauge arc (sim peak ≈ 816 mph)
const CIRC     = 213.63;  // SVG arc circumference  (2π × r=34)

/*
  Timeline events — OpenRocket simulation data:
    Liftoff        T+0 s
    Motor burnout  T+3 s   (1 476 ft / 450 m)
    Apogee+drogue  T+23 s  (10 171 ft / 3 100 m)
    Main deploy    T+120 s (  656 ft /  200 m)
    Ground hit     T+140 s
*/
const EVENTS = [
  { label: 'LIFTOFF',  norm_t: 0.00 },
  { label: 'BURNOUT',  norm_t: 0.15 },
  { label: 'APOGEE',   norm_t: 0.55 },
  { label: 'MAIN',     norm_t: 0.90 },
  { label: 'LANDING',  norm_t: 1.00 },
];


/* ═══════════════════════════════════════════════════════════════════
   3. CENTISECOND TIMER  (requestAnimationFrame)
   ───────────────────────────────────────────────────────────────────
   The server sends integer mission_time once per second.  Between
   updates the rAF loop interpolates forward from the wall clock,
   keeping the .cs display smooth at ≈60 fps with no drift.
═══════════════════════════════════════════════════════════════════ */
let _timerBaseMs = 0;   // last mission_time converted to ms
let _timerBaseTs = 0;   // Date.now() when that value arrived

function _timerLoop() {
  const nowMs = _timerBaseTs > 0
    ? Math.max(0, _timerBaseMs + (Date.now() - _timerBaseTs))
    : 0;

  const h  = Math.floor(nowMs / 3_600_000);
  const m  = Math.floor((nowMs % 3_600_000) / 60_000);
  const s  = Math.floor((nowMs % 60_000)    / 1_000);
  const cs = Math.floor((nowMs % 1_000)     / 10);     // centiseconds 0–99

  document.getElementById('timer-digits').textContent =
    `${_p(h)}:${_p(m)}:${_p(s)}`;
  document.getElementById('timer-cs').textContent =
    `.${String(cs).padStart(2, '0')}`;

  requestAnimationFrame(_timerLoop);
}


/* ═══════════════════════════════════════════════════════════════════
   4. GOAL COUNTER — APOGEE FREEZE
   ───────────────────────────────────────────────────────────────────
   The goal counter counts down normally during ascent.  At apogee
   (the moment peak altitude is detected), it freezes and displays
   the final delta vs ALT_GOAL.  Everything else — timer, gauges,
   phase, timeline — continues updating.

   Freeze is triggered by:
     1. ingestPacket: rolling velocity window turns negative
     2. updateTelemetry: altitude drops >50 ft from tracked peak

   Call window.resetGoal() between flights to unfreeze.
═══════════════════════════════════════════════════════════════════ */
let _goalFrozen   = false;   // true once apogee is detected
let _peakAltSeen  = 0;       // highest altitude seen (ft) — for updateTelemetry path

function _freezeGoalCounter(peakAltFt) {
  if (_goalFrozen) return;
  _goalFrozen = true;

  const gc    = document.getElementById('goal-counter');
  const delta = Math.round(peakAltFt) - ALT_GOAL;

  if (delta >= 0) {
    gc.className   = 'reached';
    gc.textContent = `✓  +${delta.toLocaleString()} FT ABOVE GOAL`;
  } else {
    gc.className   = 'short';
    gc.textContent = `↓  ${Math.abs(delta).toLocaleString()} FT SHORT OF GOAL`;
  }
}

window.resetGoal = function () {
  _goalFrozen  = false;
  _peakAltSeen = 0;
  const gc = document.getElementById('goal-counter');
  gc.className   = '';
  gc.textContent = '↓ 10,000 FT TO GOAL';
};


/* ═══════════════════════════════════════════════════════════════════
   5. PUBLIC API — window.updateTelemetry(data)
   ───────────────────────────────────────────────────────────────────
   Fields:
     altitude      {number}  ft       0 – 15 000
     velocity      {number}  mph      0 – 1 000
     mission_time  {number}  seconds  T+ elapsed
     timeline_norm {number}  0–1      timeline cursor
     phase         {string}           e.g. "ASCENT"
     mission_name  {string}           optional branding
     vehicle       {string}           optional org name

   This is the single entry point the overlay's DOM is driven from.
   Both the WebSocket handler and ingestPacket() ultimately call this.
═══════════════════════════════════════════════════════════════════ */
window.updateTelemetry = function (d) {
  const alt  = Math.max(0, Math.min(ALT_MAX, d.altitude      ?? 0));
  const vel  = Math.max(0, Math.min(VEL_MAX, d.velocity      ?? 0));
  const time = Math.max(0,                   d.mission_time  ?? 0);
  const norm = Math.max(0, Math.min(1,       d.timeline_norm ?? 0));

  /* ── Timer base (rAF loop reads this) ───────────────────────── */
  const newBaseMs = time * 1000;
  if (newBaseMs >= _timerBaseMs) {
    _timerBaseMs = newBaseMs;
    _timerBaseTs = Date.now();
  }

  /* ── Phase ───────────────────────────────────────────────────── */
  if (d.phase != null)
    document.getElementById('phase-label').textContent = String(d.phase).toUpperCase();

  /* ── Velocity gauge ──────────────────────────────────────────── */
  document.getElementById('arc-vel')
    .setAttribute('stroke-dashoffset', CIRC * (1 - vel / VEL_MAX));
  document.getElementById('g-vel').textContent = Math.round(vel).toLocaleString();

  /* ── Altitude gauge ──────────────────────────────────────────── */
  document.getElementById('arc-alt')
    .setAttribute('stroke-dashoffset', CIRC * (1 - alt / ALT_MAX));
  document.getElementById('g-alt').textContent = Math.round(alt).toLocaleString();
  /* Arc turns green once goal is first crossed */
  document.getElementById('ring-alt')
    .classList.toggle('goal-reached', alt >= ALT_GOAL);

  /* ── Goal counter (live while ascending) ─────────────────────── */
  if (!_goalFrozen) {
    /* Track peak for apogee detection on direct-data path */
    if (alt > _peakAltSeen) _peakAltSeen = alt;

    /*
      Apogee detection on updateTelemetry path:
      If the rocket has gained meaningful altitude and the current
      reading is more than 50 ft below the tracked peak, apogee
      has been passed — freeze the counter.
    */
    if (_peakAltSeen > 200 && alt < _peakAltSeen - 50) {
      _freezeGoalCounter(_peakAltSeen);
    } else {
      /* Still ascending — show live countdown */
      const gc     = document.getElementById('goal-counter');
      const toGoal = ALT_GOAL - alt;
      if (alt >= ALT_GOAL) {
        gc.className   = 'reached';
        gc.textContent = '✓  GOAL ALTITUDE';
      } else {
        gc.className   = toGoal <= 2000 ? 'near' : '';
        gc.textContent = '↓ ' + Math.round(toGoal).toLocaleString() + ' FT TO GOAL';
      }
    }
  }

  /* ── Branding overrides ──────────────────────────────────────── */
  if (d.mission_name)
    document.querySelector('#brand-left .bl-mission').textContent = d.mission_name;
  if (d.vehicle)
    document.querySelector('#brand-left .bl-org').textContent = d.vehicle;

  /* ── Timeline ────────────────────────────────────────────────── */
  _updateTimeline(norm);
};


/* ═══════════════════════════════════════════════════════════════════
   6. window.ingestPacket(line)
   ───────────────────────────────────────────────────────────────────
   Parses one raw line from the flight computer:

     Format A — "2026-04-30T23:04:52.865062,{...JSON...}"
     Format B — plain JSON object string

   Fields used:
     p_alt          barometric altitude, meters
                    (ground ≈ −349 m; first reading sets baseline)
     gps.altitude   GPS altitude MSL, meters (fallback)

   Streaming guard:
     window.streamingActive = false   pauses processing
     window.streamingActive = true    resumes
═══════════════════════════════════════════════════════════════════ */
window.streamingActive = true;

/* Packet parser state */
let _baselineAlt = null, _launchTime   = null,
    _prevAltM    = null, _prevPktMs    = null,
    _velSamples  = [],   _pktPeakFt    = 0,
    _pktPhase    = 'PRELAUNCH', _pktApogeeDetected = false;

window.ingestPacket = function (rawLine) {
  if (!window.streamingActive) return;

  const raw = String(rawLine).trim();
  if (!raw) return;

  let pkt, pktDate;
  if (raw.charAt(0) === '{') {
    try { pkt = JSON.parse(raw); } catch (e) { return; }
    pktDate = new Date();
  } else {
    const split = raw.indexOf(',{');
    if (split === -1) return;
    const tsStr = raw.slice(0, split);
    try { pkt = JSON.parse(raw.slice(split + 1)); } catch (e) { return; }
    pktDate = new Date(tsStr.includes('Z') ? tsStr : tsStr + 'Z');
    if (isNaN(pktDate)) pktDate = new Date();
  }

  const altM = pkt.p_alt ?? pkt.gps?.altitude ?? null;
  if (altM == null) return;

  const pktMs = pktDate.getTime();

  if (_baselineAlt === null) _baselineAlt = altM;

  const relAltM  = altM - _baselineAlt;
  const relAltFt = Math.max(0, relAltM * 3.28084);

  if (_launchTime === null && relAltM > 1.0) _launchTime = pktDate;

  const missionSec = _launchTime
    ? Math.max(0, Math.floor((pktDate - _launchTime) / 1000))
    : 0;

  /* Velocity from derivative of p_alt */
  let velMph = 0;
  if (_prevAltM !== null && _prevPktMs !== null) {
    const dtMs = pktMs - _prevPktMs;
    if (dtMs > 0 && dtMs < 5000) {
      const velMps = (altM - _prevAltM) / (dtMs / 1000);
      _velSamples.push(velMps);
      if (_velSamples.length > 8) _velSamples.shift();
      const avg = _velSamples.reduce((a, b) => a + b, 0) / _velSamples.length;
      velMph = Math.abs(avg) * 2.23694;
    }
  }
  _prevAltM  = altM;
  _prevPktMs = pktMs;

  const ascending = _velSamples.length === 0 ||
    (_velSamples.reduce((a, b) => a + b, 0) / _velSamples.length) > -0.3;

  if (relAltFt > _pktPeakFt) _pktPeakFt = relAltFt;

  /*
    Apogee detection on ingestPacket path:
    Velocity rolling average has gone clearly negative AND we have
    dropped meaningfully from the tracked peak.
  */
  if (!_pktApogeeDetected && !ascending && relAltFt < _pktPeakFt - 20 && _pktPeakFt > 200) {
    _pktApogeeDetected = true;
    _freezeGoalCounter(_pktPeakFt);
  }

  /* Timeline norm (altitude-based) */
  let tlNorm;
  if (ascending) {
    tlNorm = Math.min(0.55, (relAltFt / ALT_GOAL) * 0.55);
  } else {
    const peak        = _pktPeakFt || ALT_GOAL;
    const descentFrac = 1 - Math.min(1, relAltFt / peak);
    tlNorm            = 0.55 + descentFrac * 0.45;
  }

  /* Phase state machine */
  switch (_pktPhase) {
    case 'PRELAUNCH': if (missionSec > 0)                              _pktPhase = 'LIFTOFF';  break;
    case 'LIFTOFF':   if (relAltFt > 200 || velMph > 60)              _pktPhase = 'ASCENT';   break;
    case 'ASCENT':    if (!ascending && relAltFt > 500)                _pktPhase = 'APOGEE';   break;
    case 'APOGEE':    if (relAltFt < _pktPeakFt - 50 && velMph > 10) _pktPhase = 'DESCENT';  break;
    case 'DESCENT':   if (relAltFt < 50 && missionSec > 20)           _pktPhase = 'LANDING';  break;
  }

  window.updateTelemetry({
    altitude:      relAltFt,
    velocity:      velMph,
    mission_time:  missionSec,
    timeline_norm: tlNorm,
    phase:         _pktPhase,
  });
};

/* Reset all packet-parser + goal + timer state between flights */
window.resetPacketState = function () {
  _baselineAlt = null; _launchTime = null;
  _prevAltM    = null; _prevPktMs  = null;
  _velSamples  = [];   _pktPeakFt  = 0;
  _pktPhase    = 'PRELAUNCH'; _pktApogeeDetected = false;
  _timerBaseMs = 0;    _timerBaseTs = 0;
  window.resetGoal();
};


/* ═══════════════════════════════════════════════════════════════════
   7. WEBSOCKET CONNECTION
   ───────────────────────────────────────────────────────────────────
   Connects to TELEMETRY_CONFIG.wsUrl and feeds every incoming message
   into window.ingestPacket().  Auto-reconnects on disconnect.

   If your server already sends pre-processed telemetry (the shape
   expected by updateTelemetry — altitude, velocity, mission_time,
   timeline_norm, phase), change the line marked below to call
   window.updateTelemetry(JSON.parse(event.data)) instead.
═══════════════════════════════════════════════════════════════════ */
let _ws = null;
let _wsReconnectTimer = null;

function _connectWebSocket() {
  if (!TELEMETRY_CONFIG.wsUrl) return;  // disabled — manual feed only

  _ws = new WebSocket(TELEMETRY_CONFIG.wsUrl);

  _ws.onopen = () => {
    console.log('[telemetry] Connected:', TELEMETRY_CONFIG.wsUrl);
    clearTimeout(_wsReconnectTimer);
  };

  _ws.onmessage = (event) => {
    /*
      Raw flight-computer packets (timestamp + JSON, or bare JSON
      with p_alt / gps.altitude) go through ingestPacket(), which
      derives velocity, timeline position, and phase before calling
      updateTelemetry() itself.

      ── To use pre-processed telemetry instead ──
      If your server already computes altitude/velocity/phase and
      sends that shape directly, replace the line below with:
          window.updateTelemetry(JSON.parse(event.data));
    */
    window.ingestPacket(event.data);
  };

  _ws.onclose = () => {
    console.warn('[telemetry] Disconnected — retrying in',
      TELEMETRY_CONFIG.reconnectMs, 'ms');
    _wsReconnectTimer = setTimeout(_connectWebSocket, TELEMETRY_CONFIG.reconnectMs);
  };

  _ws.onerror = () => _ws.close();
}


/* ═══════════════════════════════════════════════════════════════════
   8. TIMELINE
═══════════════════════════════════════════════════════════════════ */
function buildTimeline() {
  const tl = document.getElementById('timeline');
  tl.querySelectorAll('.tl-event').forEach(n => n.remove());
  const L = 5, R = 95;
  for (const ev of EVENTS) {
    const el      = document.createElement('div');
    el.className  = 'tl-event';
    el.dataset.nt = ev.norm_t;
    el.style.left = (L + ev.norm_t * (R - L)) + '%';
    el.innerHTML  = `<div class="tl-dot"></div><span class="tl-label">${ev.label}</span>`;
    tl.appendChild(el);
  }
}

function _updateTimeline(norm) {
  const L = 5, R = 95;
  document.getElementById('tl-fill').style.width  = (norm * 100) + '%';
  document.getElementById('tl-cursor').style.left = (L + norm * (R - L)) + '%';
  document.querySelectorAll('.tl-event').forEach((el, i) => {
    const nt   = parseFloat(el.dataset.nt);
    const next = EVENTS[i + 1];
    el.classList.remove('done', 'active');
    if (norm >= nt) {
      if (next && norm < next.norm_t) el.classList.add('active');
      else                            el.classList.add('done');
    }
  });
}


/* ═══════════════════════════════════════════════════════════════════
   9. UTILITIES + CLOCK
═══════════════════════════════════════════════════════════════════ */
function _p(n) { return String(Math.floor(n)).padStart(2, '0'); }

function _clockTick() {
  const now = new Date();
  document.getElementById('timestamp').textContent =
    now.toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  document.getElementById('gmt-time').textContent =
    now.toISOString().slice(11, 19);
  document.getElementById('local-time').textContent =
    now.toLocaleTimeString('en-US', { hour12: false });
  setTimeout(_clockTick, 1000);
}


/* ═══════════════════════════════════════════════════════════════════
   10. INIT
═══════════════════════════════════════════════════════════════════ */
buildTimeline();
_clockTick();
requestAnimationFrame(_timerLoop);
_connectWebSocket();
