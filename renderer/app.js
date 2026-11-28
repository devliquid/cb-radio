'use strict';

// ============================================================
//  Breaker 40 CB — renderer
// ============================================================

const $ = (s) => document.querySelector(s);

const FREQS = [
  26.965, 26.975, 26.985, 27.005, 27.015, 27.025, 27.035, 27.055, 27.065, 27.075,
  27.085, 27.105, 27.115, 27.125, 27.135, 27.155, 27.165, 27.175, 27.185, 27.205,
  27.215, 27.225, 27.255, 27.235, 27.245, 27.265, 27.275, 27.285, 27.295, 27.305,
  27.315, 27.325, 27.335, 27.345, 27.355, 27.365, 27.375, 27.385, 27.395, 27.405,
];
const RATE = 8000;            // network audio sample rate
const MAX_TX_MS = 3 * 60_000; // time-out timer, like a real rig

// ---------- settings ----------
const DEFAULTS = {
  handle: '',
  server: 'wss://breaker40-base-station.onrender.com', // the hosted base station on Render
  volume: 0.65,
  squelch: 0.35,
  channel: 19,
  roger: true,
  echo: false,
  echoAmount: 0.5,     // 0..1
  host: false,
  port: 7140,
  micId: '',
  speakerId: '',
  micGain: 1,
  pttCode: 'Space',
  stations: [],          // [{name, url}]
};
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('breaker40') || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();
// Installs from 1.0.2 and earlier saved the old default, localhost. Unless this PC hosts, move them to the new default.
if (settings.server === 'ws://localhost:7140' && !settings.host) settings.server = DEFAULTS.server;
function save() { try { localStorage.setItem('breaker40', JSON.stringify(settings)); } catch {} }
// Put the hosted base station in the saved list once. If someone deletes it, it stays deleted.
if (!settings.hostedStationAdded) {
  if (!settings.stations.some((s) => s.url === DEFAULTS.server)) {
    settings.stations = [{ name: 'Render (hosted)', url: DEFAULTS.server }, ...settings.stations];
  }
  settings.hostedStationAdded = true;
  save();
}
const handle = () => settings.handle || 'Unknown';

// ---------- state ----------
let ws = null;
let connected = false;
let retryTimer = null;
let retryDelay = 1000;
let transmitting = false;
let txTimer = null;
let micLevel = 0;
let scanning = false;
let scanHold = 0;
const talkers = new Map();      // sender id -> handle, on our channel
let counts = new Array(40).fill(0);
let active = new Set();
let lastHeard = '';

// ============================================================
//  Fit the 1200x600 stage to the window
// ============================================================
const stage = $('#stage');
function fit() {
  const s = Math.min(window.innerWidth / 1200, window.innerHeight / 600);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}
window.addEventListener('resize', fit);
fit();

// ============================================================
//  7-segment channel display
// ============================================================
const SEGS = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
  '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '',
};
function segPolys(ox) {
  const w = 58, h = 100, t = 11, g = 2.2;
  const L = t / 2, R = w - t / 2, T = t / 2, M = h / 2, B = h - t / 2;
  const hz = (x, y, len) => [[x, y], [x + t / 2, y - t / 2], [x + len - t / 2, y - t / 2], [x + len, y], [x + len - t / 2, y + t / 2], [x + t / 2, y + t / 2]];
  const vt = (x, y, len) => [[x, y], [x + t / 2, y + t / 2], [x + t / 2, y + len - t / 2], [x, y + len], [x - t / 2, y + len - t / 2], [x - t / 2, y + t / 2]];
  const segs = {
    a: hz(L + g, T, R - L - 2 * g), g: hz(L + g, M, R - L - 2 * g), d: hz(L + g, B, R - L - 2 * g),
    f: vt(L, T + g, M - T - 2 * g), b: vt(R, T + g, M - T - 2 * g),
    e: vt(L, M + g, B - M - 2 * g), c: vt(R, M + g, B - M - 2 * g),
  };
  const out = {};
  for (const k in segs) out[k] = segs[k].map(([x, y]) => `${(x + ox).toFixed(1)},${(y + 5).toFixed(1)}`).join(' ');
  return out;
}
const digitSvg = $('#digits');
const digitEls = [];
(function buildDigits() {
  let html = '<g transform="skewX(-7) translate(10 0)">';
  [0, 70].forEach((ox, i) => {
    const p = segPolys(ox);
    for (const k of 'abcdefg') html += `<polygon data-d="${i}" data-s="${k}" class="off" points="${p[k]}"/>`;
  });
  html += '</g>';
  digitSvg.innerHTML = html;
  digitSvg.querySelectorAll('polygon').forEach((el) => digitEls.push(el));
})();
function showDigits(str) {
  str = String(str).padStart(2, ' ').slice(-2);
  for (const el of digitEls) {
    const ch = str[+el.dataset.d];
    el.setAttribute('class', (SEGS[ch] || '').includes(el.dataset.s) ? 'on' : 'off');
  }
}

// ============================================================
//  Analog S / RF meter
// ============================================================
const meterSvg = $('#meter');
let needle;
// Needle pivot. It sits inside the 200x120 viewBox so the needle visibly comes out of the hub.
const METER_CX = 100, METER_CY = 116;
(function buildMeter() {
  const cx = METER_CX, cy = METER_CY, r = 100;
  const a0 = -50, a1 = 50;
  const pt = (deg, rad) => {
    const a = (deg - 90) * Math.PI / 180;
    return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  };
  const arc = (rad, from, to) => {
    const [x0, y0] = pt(from, rad), [x1, y1] = pt(to, rad);
    return `M${x0.toFixed(1)},${y0.toFixed(1)} A${rad},${rad} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
  };
  let s = '';
  s += `<path d="${arc(r - 18, a0, 18)}" stroke="#1d1a14" stroke-width="2" fill="none"/>`;
  s += `<path d="${arc(r - 18, 18, a1)}" stroke="#b3200f" stroke-width="4" fill="none"/>`;
  s += `<path d="${arc(r - 38, a0, a1)}" stroke="#1d1a14" stroke-width="1" fill="none"/>`;
  const sLabels = ['1', '3', '5', '7', '9', '+20', '+40'];
  sLabels.forEach((lab, i) => {
    const deg = a0 + (i / (sLabels.length - 1)) * (a1 - a0);
    const [x0, y0] = pt(deg, r - 18), [x1, y1] = pt(deg, r - 26);
    const [tx, ty] = pt(deg, r - 8);
    const col = i >= 5 ? '#b3200f' : '#1d1a14';
    s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${col}" stroke-width="2"/>`;
    s += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="${col}" font-size="10" font-weight="700" text-anchor="middle" font-family="Arial">${lab}</text>`;
  });
  for (let i = 0; i <= 10; i++) {
    const deg = a0 + (i / 10) * (a1 - a0);
    const [x0, y0] = pt(deg, r - 38), [x1, y1] = pt(deg, r - 33);
    s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#1d1a14" stroke-width="1"/>`;
    if (i % 5 === 0) {
      const [tx, ty] = pt(deg, r - 46);
      s += `<text x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" fill="#1d1a14" font-size="7" text-anchor="middle" font-family="Arial">${i}</text>`;
    }
  }
  s += `<text x="16" y="24" font-size="10" font-weight="900" fill="#1d1a14" font-family="Arial">S</text>`;
  s += `<text x="14" y="70" font-size="7" font-weight="700" fill="#1d1a14" font-family="Arial">RF</text>`;
  s += `<text x="100" y="${cy - 17}" font-size="8" font-weight="700" fill="#5b4d33" text-anchor="middle" font-family="Arial" letter-spacing="2">SIGNAL · POWER</text>`;
  // The needle's tip stops just past the scale arc. The hub is drawn on top, centred on the pivot.
  s += `<g id="needle"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 12}" stroke="#111" stroke-width="2" stroke-linecap="round"/></g>`;
  s += `<circle cx="${cx}" cy="${cy}" r="11" fill="#1b1b1b"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="3" fill="#3a3a3a"/>`;
  meterSvg.innerHTML = s;
  needle = meterSvg.querySelector('#needle');
})();
let meterVal = 0;
// v is 0..1 across the scale. rotate() carries its own centre, so nothing else may set a
// transform-origin on the needle: Chromium would apply both and swing it off the dial.
function setNeedle(v) {
  v = Math.max(0, Math.min(1, v));
  needle.setAttribute('transform', `rotate(${(-50 + 100 * v).toFixed(2)} ${METER_CX} ${METER_CY})`);
}

// ============================================================
//  Knobs
// ============================================================
function makeKnob(el, { min = 0, max = 1, value, step = 0, sweep = 270, onChange }) {
  let v = value;
  const render = () => {
    const f = (v - min) / (max - min);
    el.querySelector('.cap').style.transform = `rotate(${-sweep / 2 + f * sweep}deg)`;
  };
  const set = (nv, fire = true) => {
    if (step) nv = Math.round(nv / step) * step;
    nv = Math.min(max, Math.max(min, nv));
    if (nv === v) return;
    v = nv;
    render();
    if (fire) onChange(v);
  };
  let dragging = false, startY = 0, startV = 0;
  el.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startV = v;
    el.setPointerCapture(e.pointerId);
    el.style.cursor = 'grabbing';
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const range = max - min;
    const px = step ? 6 : 160;      // pixels per step / per full range
    const dv = step ? Math.round((startY - e.clientY) / px) * step : ((startY - e.clientY) / px) * range;
    set(startV + dv);
  });
  const end = () => { dragging = false; el.style.cursor = ''; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    set(v + dir * (step || (max - min) / 25));
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const inc = step || (max - min) / 25;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(v + inc); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(v - inc); e.preventDefault(); }
  });
  render();
  return { set, get: () => v };
}

const volKnob = makeKnob($('#knobVol'), {
  value: settings.volume,
  onChange: (v) => { settings.volume = v; save(); applyVolume(); },
});
const sqKnob = makeKnob($('#knobSq'), {
  value: settings.squelch,
  onChange: (v) => { settings.squelch = v; save(); updateNoise(); toast(v < 0.12 ? 'Squelch open' : `Squelch ${Math.round(v * 10)}`); },
});
const chKnob = makeKnob($('#knobCh'), {
  min: 1, max: 40, step: 1, sweep: 300, value: settings.channel,
  onChange: (v) => { stopScan(); tune(v); },
});

(function buildDetents() {
  const d = $('#detents');
  let html = '';
  for (let ch = 1; ch <= 40; ch++) {
    const deg = -150 + ((ch - 1) / 39) * 300;
    const major = ch === 1 || ch % 5 === 0 || ch === 9 || ch === 19;
    html += `<i class="${major ? 'major' : ''}" style="transform: rotate(${deg + 180}deg) translateY(${major ? 74 : 76}px)"></i>`;
    if (ch === 1 || ch % 10 === 0 || ch === 19) {
      const a = (deg - 90) * Math.PI / 180;
      const x = Math.cos(a) * 92, y = Math.sin(a) * 92;
      html += `<b style="transform: translate(${x.toFixed(1)}px, ${(y - 6).toFixed(1)}px)">${ch}</b>`;
    }
  }
  d.innerHTML = html;
})();

// ============================================================
//  Band activity strip
// ============================================================
const band = $('#band');
for (let ch = 1; ch <= 40; ch++) {
  const i = document.createElement('i');
  i.title = `Channel ${ch} · ${FREQS[ch - 1].toFixed(3)} MHz`;
  i.addEventListener('click', () => { stopScan(); tune(ch); });
  band.appendChild(i);
}
function renderBand() {
  [...band.children].forEach((el, idx) => {
    const ch = idx + 1;
    el.className = (active.has(ch) ? 'act' : counts[idx] > 0 ? 'occ' : '') + (ch === settings.channel ? ' cur' : '');
    el.title = `Channel ${ch} · ${FREQS[idx].toFixed(3)} MHz · ${counts[idx]} on frequency`;
  });
}

// ============================================================
//  Little UI helpers
// ============================================================
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}
function lamp(id, on) { $(id).classList.toggle('on', !!on); }
function setTicker(msg) { const t = $('#ticker'); if (t.textContent !== msg) t.textContent = msg; }
function refreshTicker() {
  if (!connected) { setTicker(ws ? 'SEARCHING FOR BASE…' : 'NO BASE STATION'); return; }
  if (transmitting) { setTicker(`TX ▶ ${handle().toUpperCase()} ON CH ${settings.channel}`); return; }
  if (talkers.size) { setTicker(`◀ ${[...talkers.values()].join(' + ').toUpperCase()}`); return; }
  if (scanning) { setTicker('SCANNING THE BAND…'); return; }
  const n = counts[settings.channel - 1] || 0;
  const others = Math.max(0, n - 1);
  const tail = lastHeard ? ` · LAST: ${lastHeard.toUpperCase()}` : '';
  setTicker(`${others} OTHER${others === 1 ? '' : 'S'} ON CH ${settings.channel}${tail}`);
}
function showChannel() {
  showDigits(settings.channel);
  $('#freq').textContent = `${FREQS[settings.channel - 1].toFixed(3)} MHz`;
  renderBand();
}
$('#handlePlate').textContent = handle().toUpperCase();

// ============================================================
//  Audio
// ============================================================
let ctx = null;
let rxIn, rxGate, master, noiseGain, rxAnalyser, capNode, micSrc, micStream, micGainNode;
let echoIn, echoWet, echoFb;
const players = new Map();   // sender id -> next play time
let rxPlayingUntil = 0;

function bq(type, f, q) {
  const n = ctx.createBiquadFilter();
  n.type = type; n.frequency.value = f; n.Q.value = q;
  return n;
}
function driveCurve(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}

async function initAudio() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: 'interactive' });
  applySpeaker();

  // receive chain: narrow AM-ish voice, a little grit
  rxIn = ctx.createGain();
  const hp = bq('highpass', 330, 0.8);
  const lp = bq('lowpass', 2700, 1.1);
  const pk = bq('peaking', 1500, 1.2); pk.gain.value = 5;
  const shaper = ctx.createWaveShaper(); shaper.curve = driveCurve(2.2); shaper.oversample = '2x';
  rxGate = ctx.createGain();
  master = ctx.createGain();
  rxIn.connect(hp).connect(lp).connect(pk).connect(shaper).connect(rxGate).connect(master).connect(ctx.destination);
  rxAnalyser = ctx.createAnalyser(); rxAnalyser.fftSize = 512;
  rxIn.connect(rxAnalyser);

  // static
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * (0.7 + 0.3 * Math.random());
  const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
  const nbp = bq('bandpass', 1800, 0.5);
  noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
  noise.connect(nbp).connect(noiseGain).connect(rxGate);
  noise.start();

  applyVolume();
  updateNoise();

  await ctx.audioWorklet.addModule('worklet.js');
  await openMic();
}

async function openMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micSrc) micSrc.disconnect();
  micStream = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.micId ? { exact: settings.micId } : undefined,
        echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
      },
    });
  } catch (err) {
    if (settings.micId) { settings.micId = ''; save(); return openMic(); }
    toast('No microphone found — you can listen but not talk');
    return;
  }
  micSrc = ctx.createMediaStreamSource(micStream);
  if (!capNode) {
    capNode = new AudioWorkletNode(ctx, 'cb-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    capNode.port.onmessage = (e) => {
      const { pcm, level } = e.data;
      micLevel = level;
      if (pcm && transmitting && connected) ws.send(pcm);
    };
    const sink = ctx.createGain(); sink.gain.value = 0;
    capNode.connect(sink).connect(ctx.destination);
  }
  const hp = bq('highpass', 250, 0.7);
  const lp = bq('lowpass', 3400, 0.7);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -28; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.15;
  micGainNode = ctx.createGain();
  applyMicGain();
  micSrc.connect(hp).connect(lp).connect(comp).connect(micGainNode).connect(capNode);
  buildEcho();
  micGainNode.connect(echoIn);
  fillDevices();
}

// Echo mic: a delay line with feedback, mixed into what you transmit.
// Only fed while keyed, so it never repeats what you said before keying.
function buildEcho() {
  if (echoIn) return;
  echoIn = ctx.createGain(); echoIn.gain.value = 0;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.22;
  echoFb = ctx.createGain();
  echoWet = ctx.createGain();
  const tone = bq("lowpass", 2400, 0.7);   // each repeat a little duller, like a tape echo
  echoIn.connect(delay).connect(tone).connect(echoFb).connect(delay);
  tone.connect(echoWet).connect(capNode);
  applyEcho();
}
function applyEcho() {
  if (!echoWet) return;
  const a = settings.echo ? settings.echoAmount : 0;
  const t = ctx.currentTime;
  echoWet.gain.setTargetAtTime(0.85 * a, t, 0.03);
  // after unkeying, drop the feedback so the tail dies out instead of starting the next over
  echoFb.gain.setTargetAtTime(transmitting ? 0.7 * a : 0, t, 0.03);
  echoIn.gain.setTargetAtTime(transmitting && a > 0 ? 1 : 0, t, 0.01);
}

function applyMicGain() {
  if (micGainNode) micGainNode.gain.setTargetAtTime(2.2 * settings.micGain, ctx.currentTime, 0.02);
}
async function applySpeaker() {
  if (!ctx || typeof ctx.setSinkId !== 'function') return;
  try {
    await ctx.setSinkId(settings.speakerId || '');
  } catch {
    // the chosen speaker was unplugged: fall back to the Windows default
    settings.speakerId = ''; save();
    try { await ctx.setSinkId(''); } catch {}
    toast('Speaker not found — using the Windows default');
  }
}

function applyVolume() {
  if (!master) return;
  const v = settings.volume;
  master.gain.setTargetAtTime(v * v * 1.8, ctx.currentTime, 0.02);
  document.body.classList.toggle('off', v < 0.02);
}
const squelchOpen = () => settings.squelch < 0.12;
const rxBusy = () => talkers.size > 0 || (ctx && ctx.currentTime < rxPlayingUntil);
function idleNoiseLevel() {
  if (!squelchOpen()) return 0;
  return 0.05 + (0.12 - settings.squelch) * 0.8;
}
function updateNoise() {
  if (!ctx) return;
  const target = transmitting ? 0 : rxBusy() ? 0.02 : idleNoiseLevel();
  noiseGain.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
}
function burst(level, dur) {
  if (!ctx || transmitting) return;
  const t = ctx.currentTime;
  const g = noiseGain.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(level, t);
  g.setTargetAtTime(rxBusy() ? 0.02 : idleNoiseLevel(), t + dur, 0.04);
}

function onAudio(buf) {
  if (!ctx || transmitting || buf.byteLength < 6) return;
  const id = new DataView(buf).getUint32(0, true);
  const pcm = new Int16Array(buf, 4, (buf.byteLength - 4) >> 1);
  const ab = ctx.createBuffer(1, pcm.length, RATE);
  const d = ab.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) d[i] = pcm[i] / 32768;
  const now = ctx.currentTime;
  let t = players.get(id) || 0;
  if (t < now + 0.03) t = now + 0.12;           // (re)start with a small jitter buffer
  else if (t > now + 0.6) t = now + 0.12;       // fell too far behind: catch up
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(rxIn);
  src.start(t);
  t += ab.duration;
  players.set(id, t);
  rxPlayingUntil = Math.max(rxPlayingUntil, t);
}

// roger beep: two short tones sent as the last thing before unkeying
function rogerFrames() {
  const tones = [[1050, 0.09], [1400, 0.09]];
  const total = tones.reduce((n, [, d]) => n + Math.round(d * RATE), 0);
  const out = new Int16Array(Math.ceil(total / 160) * 160);
  let i = 0;
  for (const [f, d] of tones) {
    const n = Math.round(d * RATE);
    for (let k = 0; k < n; k++, i++) out[i] = Math.sin((2 * Math.PI * f * k) / RATE) * 9000 * Math.min(1, k / 40, (n - k) / 40);
  }
  const frames = [];
  for (let o = 0; o < out.length; o += 160) frames.push(out.slice(o, o + 160).buffer);
  return frames;
}

// ============================================================
//  Network
// ============================================================
function normalizeServer(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) s = s.replace(/^http/i, 'ws');
  const bare = !/^wss?:\/\//i.test(s);
  if (bare) s = `ws://${s}`;
  try {
    const u = new URL(s);
    const local = u.hostname === 'localhost' || /^[\d.]+$/.test(u.hostname) || !u.hostname.includes('.');
    // bare IP or LAN name without a port: assume the default relay port
    if (u.protocol === 'ws:' && !u.port && local) u.port = '7140';
    // bare domain name without a port (e.g. my-cb.onrender.com): a hosted base station, so secure
    if (bare && !u.port && !local) u.protocol = 'wss:';
    return u.toString().replace(/\/$/, '');
  } catch { return s; }
}
function sendJSON(obj) { if (connected) ws.send(JSON.stringify(obj)); }

function connect() {
  clearTimeout(retryTimer);
  if (ws) { ws.onclose = null; ws.onerror = null; try { ws.close(); } catch {} }
  ws = null;
  connected = false;
  talkers.clear();
  const url = normalizeServer(settings.server);
  setNet('searching');
  if (!url) { setNet('off'); return; }
  let sock;
  try { sock = new WebSocket(url); } catch { scheduleRetry(); return; }
  ws = sock;
  sock.binaryType = 'arraybuffer';
  sock.onopen = () => {
    connected = true;
    retryDelay = 1000;
    setNet('on');
    sendJSON({ type: 'join', channel: settings.channel, handle: handle() });
    $('#connState').textContent = `Connected to ${url}`;
  };
  sock.onmessage = (e) => {
    if (typeof e.data !== 'string') { onAudio(e.data); return; }
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'status') {
      counts = m.counts;
      active = new Set(m.active);
      renderBand();
      scanStep(true);
    } else if (m.type === 'tx') {
      if (m.on) {
        talkers.set(m.id, m.handle);
        lastHeard = m.handle;
        burst(0.16, 0.05);           // kerchunk as the carrier comes up
      } else {
        talkers.delete(m.id);
        players.delete(m.id);
        if (!talkers.size) {
          const left = ctx ? Math.max(0, rxPlayingUntil - ctx.currentTime) : 0;
          setTimeout(() => burst(0.32, 0.22), left * 1000);   // squelch tail
        }
      }
    }
    refreshTicker();
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    connected = false;
    talkers.clear();
    if (transmitting) stopTx(true);
    setNet('searching');
    $('#connState').textContent = `Can't reach ${url} — retrying…`;
    scheduleRetry();
  };
  sock.onerror = () => {};
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryDelay);
  retryDelay = Math.min(retryDelay * 1.7, 10_000);
}
function setNet(state) {
  const el = $('#lampNet');
  el.classList.toggle('on', state === 'on');
  el.classList.toggle('blink', state === 'searching');
  refreshTicker();
}

// ============================================================
//  Tuning, scan, transmit
// ============================================================
function clickSound() {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = 2400;
  g.gain.setValueAtTime(0.04, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.025);
  o.connect(g).connect(master);
  o.start(); o.stop(ctx.currentTime + 0.03);
}
function tune(ch, quiet = false) {
  ch = ((ch - 1 + 40) % 40) + 1;
  if (ch === settings.channel && connected && !quiet) { showChannel(); return; }
  if (transmitting) stopTx();
  settings.channel = ch;
  save();
  chKnob.set(ch, false);
  talkers.clear();
  players.clear();
  lastHeard = '';
  showChannel();
  if (!quiet) clickSound();
  sendJSON({ type: 'join', channel: ch, handle: handle() });
  refreshTicker();
}

let scanTimer = null;
function startScan() {
  scanning = true;
  $('#btnScan').classList.add('on');
  lamp('#lampScan', true);
  scanTimer = setInterval(() => scanStep(false), 280);
  refreshTicker();
}
function stopScan() {
  if (!scanning) return;
  scanning = false;
  clearInterval(scanTimer);
  $('#btnScan').classList.remove('on');
  lamp('#lampScan', false);
  refreshTicker();
}
// Stop on any channel where someone is talking; hold there 3 s after they stop.
function scanStep(fromStatus) {
  if (!scanning || transmitting) return;
  const now = Date.now();
  if (active.has(settings.channel) || talkers.size || rxBusy()) { scanHold = now + 3000; return; }
  if (now < scanHold) return;
  if (active.size) {
    const list = [...active].sort((a, b) => a - b);
    const next = list.find((c) => c > settings.channel) || list[0];
    tune(next, true);
    scanHold = now + 3000;
    return;
  }
  if (!fromStatus) tune(settings.channel + 1, true);
}

function startTx() {
  if (transmitting) return;
  if (!ctx) { initAudio(); }
  if (!connected) { toast('No base station — open SETUP'); return; }
  if (!micStream) { toast('No microphone'); return; }
  stopScan();
  transmitting = true;
  $('#ptt').classList.add('down');
  lamp('#lampTx', true);
  rxGate.gain.setTargetAtTime(0, ctx.currentTime, 0.01);   // half duplex: can't hear while keyed
  updateNoise();
  sendJSON({ type: 'tx', on: true });
  capNode.port.postMessage({ active: true });
  applyEcho();
  txTimer = setTimeout(() => { stopTx(); toast('Time-out: mic unkeyed after 3 minutes'); }, MAX_TX_MS);
  refreshTicker();
}
function stopTx(silent = false) {
  if (!transmitting) return;
  transmitting = false;
  clearTimeout(txTimer);
  capNode.port.postMessage({ active: false });
  applyEcho();
  if (connected && !silent) {
    if (settings.roger) for (const f of rogerFrames()) ws.send(f);
    sendJSON({ type: 'tx', on: false });
  }
  $('#ptt').classList.remove('down');
  lamp('#lampTx', false);
  rxGate.gain.setTargetAtTime(1, ctx.currentTime, 0.02);
  updateNoise();
  refreshTicker();
}

// PTT: mouse/touch on the mic button, or hold Space anywhere
const ptt = $('#ptt');
ptt.addEventListener('pointerdown', (e) => { ptt.setPointerCapture(e.pointerId); startTx(); });
ptt.addEventListener('pointerup', () => stopTx());
ptt.addEventListener('pointercancel', () => stopTx());
ptt.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
// Sliders do not count as typing, so push-to-talk still works after moving one.
const typing = () => { const el = document.activeElement; return !!el && /INPUT|SELECT|TEXTAREA/.test(el.tagName) && el.type !== 'range'; };
let capturingKey = false;
window.addEventListener('keydown', (e) => {
  if (capturingKey) return;
  if (e.code !== settings.pttCode || typing() || !$('#setup').hidden) return;
  e.preventDefault();
  if (!e.repeat) startTx();
});
window.addEventListener('keyup', (e) => {
  if (e.code !== settings.pttCode || capturingKey) return;
  if (transmitting) e.preventDefault();
  stopTx();
});

function keyLabel(code) {
  if (!code) return '—';
  if (code === 'Space') return 'Space';
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^Numpad(.+)$/))) return `Num ${m[1]}`;
  const names = {
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    AltLeft: 'Left Alt', AltRight: 'Right Alt', CapsLock: 'Caps Lock', Backquote: '`', Insert: 'Insert',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ScrollLock: 'Scroll Lock', Pause: 'Pause',
  };
  return names[code] || code;
}
function showPttKey() {
  const label = keyLabel(settings.pttCode);
  $('#pttKeyLabel').textContent = label;
  $('#pttHint').textContent = label;
}
window.addEventListener('blur', () => stopTx());

// ---------- buttons ----------
$('#btn9').addEventListener('click', () => { stopScan(); tune(9); toast('CH 9 · Emergency'); });
$('#btn19').addEventListener('click', () => { stopScan(); tune(19); toast('CH 19 · Highway'); });
$('#btnScan').addEventListener('click', () => (scanning ? stopScan() : startScan()));
const rogerBtn = $('#btnRoger');
rogerBtn.classList.toggle('on', settings.roger);
rogerBtn.addEventListener('click', () => {
  settings.roger = !settings.roger; save();
  rogerBtn.classList.toggle('on', settings.roger);
  toast(settings.roger ? 'Roger beep on' : 'Roger beep off');
});
const echoBtn = $('#btnEcho'), echoSlider = $('#echoAmount');
function showEcho() {
  echoBtn.classList.toggle('on', settings.echo);
  $('#echoBox').classList.toggle('off', !settings.echo);
  echoSlider.value = Math.round(settings.echoAmount * 100);
  echoSlider.title = `Echo amount: ${echoSlider.value}%`;
}
showEcho();
echoBtn.addEventListener('click', () => {
  settings.echo = !settings.echo; save();
  showEcho(); applyEcho();
  toast(settings.echo ? `Echo on · ${Math.round(settings.echoAmount * 100)}%` : 'Echo off');
});
echoSlider.addEventListener('input', () => {
  settings.echoAmount = Number(echoSlider.value) / 100;
  if (!settings.echo && settings.echoAmount > 0) settings.echo = true;   // moving the slider turns echo on
  save(); showEcho(); applyEcho();
  toast(`Echo ${echoSlider.value}%`);
});

// ============================================================
//  Setup sheet
// ============================================================
const sheet = $('#setup');
function openSetup() {
  $('#inHandle').value = settings.handle;
  $('#inServer').value = settings.server;
  $('#inHost').checked = settings.host;
  $('#inPort').value = settings.port;
  $('#inGain').value = settings.micGain;
  $('#gainVal').textContent = `${Math.round(settings.micGain * 100)}%`;
  renderStations();
  showPttKey();
  sheet.hidden = false;
  if (!ctx) initAudio(); else fillDevices();
  (settings.handle ? $('#inServer') : $('#inHandle')).focus();
}
function closeSetup() {
  cancelKeyCapture();
  applyHandle();
  sheet.hidden = true;
}

// ---------- saved base stations ----------
function renderStations(selectUrl = normalizeServer(settings.server)) {
  const sel = $('#inStations');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  sel.innerHTML = `<option value="">${settings.stations.length ? '— pick a saved station —' : '(none saved yet)'}</option>` +
    settings.stations.map((s, i) => `<option value="${i}">${esc(s.name)}  ·  ${esc(s.url)}</option>`).join('');
  const idx = settings.stations.findIndex((s) => s.url === selectUrl);
  sel.value = idx >= 0 ? String(idx) : '';
  $('#inStationName').value = idx >= 0 ? settings.stations[idx].name : '';
  $('#btnDelStation').disabled = idx < 0;
}
$('#inStations').addEventListener('change', (e) => {
  const st = settings.stations[+e.target.value];
  $('#btnDelStation').disabled = !st;
  if (!st) return;
  $('#inServer').value = st.url;
  $('#inStationName').value = st.name;
  $('#btnConnect').click();
});
$('#btnSaveStation').addEventListener('click', () => {
  const url = normalizeServer($('#inServer').value);
  if (!url) { $('#connState').textContent = 'Enter an address first.'; return; }
  const name = $('#inStationName').value.trim().slice(0, 24) || url.replace(/^wss?:\/\//, '');
  const existing = settings.stations.findIndex((s) => s.name.toLowerCase() === name.toLowerCase() || s.url === url);
  if (existing >= 0) settings.stations[existing] = { name, url };
  else settings.stations.push({ name, url });
  save();
  renderStations(url);
  $('#connState').textContent = `Saved “${name}”.`;
});
$('#btnDelStation').addEventListener('click', () => {
  const i = +$('#inStations').value;
  const st = settings.stations[i];
  if (!st) return;
  settings.stations.splice(i, 1);
  save();
  renderStations('');
  $('#connState').textContent = `Removed “${st.name}”.`;
});

// ---------- mic gain ----------
$('#inGain').addEventListener('input', (e) => {
  settings.micGain = Number(e.target.value);
  $('#gainVal').textContent = `${Math.round(settings.micGain * 100)}%`;
  applyMicGain();
  save();
});

// ---------- push-to-talk key ----------
function cancelKeyCapture() {
  if (!capturingKey) return;
  capturingKey = false;
  window.removeEventListener('keydown', captureKey, true);
  $('#btnSetKey').classList.remove('listening');
  $('#btnSetKey').textContent = 'Change…';
  $('#keyHint').textContent = '';
}
function captureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.code === 'Escape') { cancelKeyCapture(); return; }
  if (e.code === 'Tab' || e.code === 'Enter' || !e.code) {
    $('#keyHint').textContent = 'That key is used for moving around the window. Pick another.';
    return;
  }
  settings.pttCode = e.code;
  save();
  showPttKey();
  cancelKeyCapture();
  $('#keyHint').textContent = `Hold ${keyLabel(e.code)} to talk.`;
}
$('#btnSetKey').addEventListener('click', () => {
  if (capturingKey) { cancelKeyCapture(); return; }
  capturingKey = true;
  $('#btnSetKey').classList.add('listening');
  $('#btnSetKey').textContent = 'Cancel';
  $('#keyHint').textContent = 'Press the key you want to use… (Esc to cancel)';
  $('#btnSetKey').blur();
  window.addEventListener('keydown', captureKey, true);
});
function applyHandle() {
  const h = $('#inHandle').value.replace(/[^\w .\-'!?#&]/g, '').trim().slice(0, 16);
  if (h !== settings.handle) {
    settings.handle = h; save();
    sendJSON({ type: 'handle', handle: handle() });
  }
  $('#handlePlate').textContent = handle().toUpperCase();
}
$('#btnSetup').addEventListener('click', openSetup);
$('#btnClose').addEventListener('click', closeSetup);
sheet.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !capturingKey) closeSetup(); });
$('#inHandle').addEventListener('change', applyHandle);
$('#btnConnect').addEventListener('click', () => {
  applyHandle();
  settings.server = normalizeServer($('#inServer').value);
  $('#inServer').value = settings.server;
  save();
  $('#connState').textContent = 'Connecting…';
  renderStations(settings.server);
  connect();
});
$('#inServer').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnConnect').click(); });

async function startHosting() {
  const port = Number($('#inPort').value) || 7140;
  const info = $('#hostInfo');
  info.textContent = 'Starting base station…';
  const res = await window.cb.host(port);
  if (!res.ok) {
    info.textContent = `Couldn't start: ${res.error}`;
    $('#inHost').checked = false;
    settings.host = false; save();
    return;
  }
  settings.host = true; settings.port = res.port;
  const addrs = res.ips.length ? res.ips.map((ip) => `<code>ws://${ip}:${res.port}</code>`).join('<br>') : '(no network found)';
  info.innerHTML = `On the air on port ${res.port}. Friends on your network enter:<br>${addrs}<br>If Windows asks about the firewall, allow it.`;
  // this computer talks to its own base station
  settings.server = `ws://localhost:${res.port}`;
  $('#inServer').value = settings.server;
  save();
  connect();
}
$('#inHost').addEventListener('change', async (e) => {
  if (e.target.checked) await startHosting();
  else {
    await window.cb.unhost();
    settings.host = false; save();
    $('#hostInfo').textContent = 'Base station off.';
  }
});

async function fillDevices() {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const fill = (sel, kind, fallback, current) => {
    const list = devs.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications');
    sel.innerHTML = '<option value="">Windows default</option>' +
      list.map((d) => `<option value="${d.deviceId.replace(/"/g, '&quot;')}">${(d.label || fallback).replace(/</g, '&lt;')}</option>`).join('');
    sel.value = list.some((d) => d.deviceId === current) ? current : '';
  };
  fill($('#inMic'), 'audioinput', 'Microphone', settings.micId);
  fill($('#inSpeaker'), 'audiooutput', 'Speaker', settings.speakerId);
}
$('#inMic').addEventListener('change', (e) => { settings.micId = e.target.value; save(); if (ctx) openMic(); });
$('#inSpeaker').addEventListener('change', (e) => {
  settings.speakerId = e.target.value; save();
  applySpeaker().then(() => clickSound());
});
navigator.mediaDevices.addEventListener('devicechange', () => { if (!sheet.hidden) fillDevices(); });

// ============================================================
//  Animation loop: meter, RX lamp, cord
// ============================================================
const timeBuf = new Float32Array(512);
function frame() {
  let target = 0;
  if (transmitting) {
    target = Math.min(1, 0.55 + micLevel * 2.5) + (Math.random() - 0.5) * 0.03;
  } else if (rxBusy() && rxAnalyser) {
    rxAnalyser.getFloatTimeDomainData(timeBuf);
    let sq = 0; for (let i = 0; i < timeBuf.length; i++) sq += timeBuf[i] * timeBuf[i];
    const rms = Math.sqrt(sq / timeBuf.length);
    target = Math.min(0.97, 0.4 + rms * 2.2) + (Math.random() - 0.5) * 0.05;
  } else if (squelchOpen() && settings.volume > 0.02) {
    target = 0.04 + Math.random() * 0.05;
  }
  meterVal += (target - meterVal) * (target > meterVal ? 0.35 : 0.12);
  setNeedle(Math.max(0, Math.min(1, meterVal)));

  const busy = rxBusy();
  lamp('#lampRx', busy && !transmitting);
  if (frame.wasBusy && !busy) updateNoise();
  if (!frame.wasBusy && busy) updateNoise();
  frame.wasBusy = busy;

  if (!sheet.hidden) {
    // -50 dBFS .. 0 dBFS across the bar; the dashed line sits at about -11 dBFS
    const db = 20 * Math.log10(Math.max(micLevel, 1e-5));
    const pct = Math.max(0, Math.min(1, (db + 50) / 50));
    $('#micBar').style.clipPath = `inset(0 ${(100 - pct * 100).toFixed(1)}% 0 0)`;
  }

  requestAnimationFrame(frame);
}

// coiled cord from the radio to the mic
(function drawCord() {
  const svg = $('#cord');
  const p0 = [895, 410], p3 = [1063, 512];      // radio side jack -> mic strain relief
  const c1 = [960, 600], c2 = [1060, 640];
  const bez = (t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * p0[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t * t * t * p3[k]);
  };
  let d = '';
  const loops = 30;
  for (let i = 0; i <= loops * 12; i++) {
    const t = i / (loops * 12);
    const [x, y] = bez(t);
    const ang = (i / 12) * Math.PI * 2;
    const px = x + Math.cos(ang) * 9, py = y + Math.sin(ang) * 6;
    d += (i ? 'L' : 'M') + px.toFixed(1) + ',' + py.toFixed(1);
  }
  svg.innerHTML =
    `<path d="${d}" fill="none" stroke="#050506" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="#2c2e33" stroke-width="2.5" stroke-linecap="round"/>`;
})();

// ============================================================
//  Boot
// ============================================================
showChannel();
showPttKey();
connect();
requestAnimationFrame(frame);
if (settings.host) {
  $('#inPort').value = settings.port;
  $('#inHost').checked = true;
  startHosting();
}
if (!settings.handle) {
  settings.handle = `Breaker${Math.floor(100 + Math.random() * 900)}`;
  save();
  $('#handlePlate').textContent = handle().toUpperCase();
  setTimeout(openSetup, 400);
} else {
  initAudio();
}
