'use strict';

// ============================================================
//  Breaker 40 CB — renderer
// ============================================================

const $ = (s) => document.querySelector(s);

// Three bands of 40 channels. 11 m is CB. 10 m and 12 m are the neighbouring (amateur) bands.
// On the base station they're channels 1-40 (11 m), 41-80 (10 m) and 81-120 (12 m), so older
// radios, which only know 1-40, keep working on 11 m.
const BANDS = {
  10: { base: 40, freqs: Array.from({ length: 40 }, (_, i) => 28.305 + i * 0.010) },
  11: { base: 0, freqs: [
    26.965, 26.975, 26.985, 27.005, 27.015, 27.025, 27.035, 27.055, 27.065, 27.075,
    27.085, 27.105, 27.115, 27.125, 27.135, 27.155, 27.165, 27.175, 27.185, 27.205,
    27.215, 27.225, 27.255, 27.235, 27.245, 27.265, 27.275, 27.285, 27.295, 27.305,
    27.315, 27.325, 27.335, 27.345, 27.355, 27.365, 27.375, 27.385, 27.395, 27.405,
  ] },
  12: { base: 80, freqs: Array.from({ length: 40 }, (_, i) => 24.890 + i * 0.0025) },
};
// 27.185 stays 27.185; 24.8925 keeps its fourth decimal.
const fmtFreq = (f) => f.toFixed(4).replace(/0$/, '');
const freqOf = (ch, b = settings.band) => BANDS[b].freqs[ch - 1];
const netCh = (ch = settings.channel, b = settings.band) => BANDS[b].base + ch;   // channel number on the base station
const inBand = (n, b = settings.band) => n > BANDS[b].base && n <= BANDS[b].base + 40;
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
  rogerSound: 'classic',   // a built-in id from ROGER_SOUNDS, or 'my:<id>' for the user's own
  echo: false,
  echoAmount: 0.5,     // 0..1
  mode: 'am',          // sideband switch: 'usb', 'am' (OFF) or 'lsb'
  clarifier: 0,        // Hz, -800..+800
  band: '11',          // '10', '11' or '12' meters
  theme: 'classic',    // 'classic' (mobile rig) or 'base' (silver base station)
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
const talkerModes = new Map();  // sender id -> 'am' | 'usb' | 'lsb' (older radios don't say, so AM)
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
// Colours come from the theme's CSS variables, so the meter is rebuilt when the theme changes.
function buildMeter() {
  const css = getComputedStyle(document.body);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const ink = v('--meter-ink', '#1d1a14'), hot = v('--meter-hot', '#b3200f'), sub = v('--meter-sub', '#5b4d33');
  const inner = v('--meter-inner', ink), nd = v('--meter-needle', '#111');
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
  s += `<path d="${arc(r - 18, a0, 18)}" stroke="${ink}" stroke-width="2" fill="none"/>`;
  s += `<path d="${arc(r - 18, 18, a1)}" stroke="${hot}" stroke-width="4" fill="none"/>`;
  s += `<path d="${arc(r - 38, a0, a1)}" stroke="${inner}" stroke-width="1" fill="none"/>`;
  const sLabels = ['1', '3', '5', '7', '9', '+20', '+40'];
  sLabels.forEach((lab, i) => {
    const deg = a0 + (i / (sLabels.length - 1)) * (a1 - a0);
    const [x0, y0] = pt(deg, r - 18), [x1, y1] = pt(deg, r - 26);
    const [tx, ty] = pt(deg, r - 8);
    const col = i >= 5 ? hot : ink;
    s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${col}" stroke-width="2"/>`;
    s += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" fill="${col}" font-size="10" font-weight="700" text-anchor="middle" font-family="Arial">${lab}</text>`;
  });
  for (let i = 0; i <= 10; i++) {
    const deg = a0 + (i / 10) * (a1 - a0);
    const [x0, y0] = pt(deg, r - 38), [x1, y1] = pt(deg, r - 33);
    s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${inner}" stroke-width="1"/>`;
    if (i % 5 === 0) {
      const [tx, ty] = pt(deg, r - 46);
      s += `<text x="${tx.toFixed(1)}" y="${(ty + 3).toFixed(1)}" fill="${inner}" font-size="7" text-anchor="middle" font-family="Arial">${i}</text>`;
    }
  }
  s += `<text x="16" y="24" font-size="10" font-weight="900" fill="${ink}" font-family="Arial">S</text>`;
  s += `<text x="14" y="70" font-size="7" font-weight="700" fill="${inner}" font-family="Arial">RF</text>`;
  s += `<text x="100" y="${cy - 17}" font-size="8" font-weight="700" fill="${sub}" text-anchor="middle" font-family="Arial" letter-spacing="2">SIGNAL · POWER</text>`;
  // The needle's tip stops just past the scale arc. The hub is drawn on top, centred on the pivot.
  s += `<g id="needle"><line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - r + 12}" stroke="${nd}" stroke-width="2" stroke-linecap="round"/></g>`;
  s += `<circle cx="${cx}" cy="${cy}" r="11" fill="#1b1b1b"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="3" fill="#3a3a3a"/>`;
  meterSvg.innerHTML = s;
  needle = meterSvg.querySelector('#needle');
}
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
if (!BANDS[settings.band]) settings.band = '11';
if (!(settings.channel >= 1 && settings.channel <= 40)) settings.channel = 19;

// ---------- channel up / down: click, or hold to keep going ----------
function holdRepeat(btn, fn) {
  let t1 = 0, t2 = 0;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture(e.pointerId);
    fn();
    t1 = setTimeout(() => { t2 = setInterval(fn, 110); }, 420);
  });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } });
}
holdRepeat($('#btnChUp'), () => { stopScan(); tune(settings.channel + 1); });
holdRepeat($('#btnChDn'), () => { stopScan(); tune(settings.channel - 1); });
for (const el of [$('#bandScreen'), $('#btnChUp'), $('#btnChDn')]) {
  el.addEventListener('wheel', (e) => { e.preventDefault(); stopScan(); tune(settings.channel + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
}

// ---------- 10 / 11 / 12 meter band switch ----------
const bandSwitch = $('#bandSwitch');
const BAND_ORDER = ['10', '11', '12'];
function showBand() {
  bandSwitch.dataset.band = settings.band;
  bandSwitch.querySelectorAll('.band-labels span').forEach((s) => s.classList.toggle('on', s.dataset.band === settings.band));
  $('#bandNum').textContent = settings.band;
  const f = BANDS[settings.band].freqs;
  $('#bandRange').textContent = `${fmtFreq(f[0])}–${fmtFreq(f[39])}`;
}
function setBand(b, quiet = false) {
  if (!BANDS[b] || b === settings.band) return;
  if (transmitting) stopTx(true);
  cancelRogerTail(true);
  stopFar();
  stopScan();
  settings.band = b; save();
  talkers.clear(); players.clear(); lastHeard = '';
  showBand(); showChannel();
  if (!quiet) { clickSound(); toast(`${b} meter band · CH ${settings.channel} · ${fmtFreq(freqOf(settings.channel))} MHz`); }
  sendJSON({ type: 'join', channel: netCh(), handle: handle(), wide: true });
  refreshTicker();
}
bandSwitch.addEventListener('click', (e) => {
  const lab = e.target.closest('[data-band]');
  if (lab) { setBand(lab.dataset.band); return; }
  const r = bandSwitch.querySelector('.band-slot').getBoundingClientRect();
  if (e.clientY < r.top - 4 || e.clientY > r.bottom + 4) return;
  setBand(BAND_ORDER[Math.max(0, Math.min(2, Math.floor(((e.clientX - r.left) / r.width) * 3)))]);
});
bandSwitch.addEventListener('wheel', (e) => {
  e.preventDefault();
  const i = BAND_ORDER.indexOf(settings.band) + (e.deltaY > 0 ? 1 : -1);
  setBand(BAND_ORDER[Math.max(0, Math.min(2, i))]);
}, { passive: false });
bandSwitch.addEventListener('keydown', (e) => {
  const i = BAND_ORDER.indexOf(settings.band);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { setBand(BAND_ORDER[Math.max(0, i - 1)]); e.preventDefault(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { setBand(BAND_ORDER[Math.min(2, i + 1)]); e.preventDefault(); }
});

// ============================================================
//  Band activity strip
// ============================================================
const band = $('#band');
for (let ch = 1; ch <= 40; ch++) {
  const i = document.createElement('i');
  i.addEventListener('click', () => { stopScan(); tune(ch); });
  band.appendChild(i);
}
function renderBand() {
  [...band.children].forEach((el, idx) => {
    const ch = idx + 1;
    const n = counts[netCh(ch) - 1] || 0;
    el.className = (active.has(netCh(ch)) ? 'act' : n > 0 ? 'occ' : '') + (ch === settings.channel ? ' cur' : '');
    el.title = `${settings.band} m · Channel ${ch} · ${fmtFreq(freqOf(ch))} MHz · ${n} on frequency`;
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
  const chName = `CH ${settings.channel}${settings.band === '11' ? '' : ` · ${settings.band}M`}`;
  if (transmitting) { setTicker(`TX ▶ ${handle().toUpperCase()} ON ${chName}`); return; }
  if (talkers.size) { setTicker(`◀ ${[...talkers.values()].join(' + ').toUpperCase()}`); return; }
  if (scanning) { setTicker('SCANNING THE BAND…'); return; }
  const n = counts[netCh() - 1] || 0;
  const others = Math.max(0, n - 1);
  const tail = lastHeard ? ` · LAST: ${lastHeard.toUpperCase()}` : '';
  setTicker(`${others} OTHER${others === 1 ? '' : 'S'} ON ${chName}${tail}`);
}
function showChannel() {
  showDigits(settings.channel);
  $('#freq').textContent = `${fmtFreq(freqOf(settings.channel))} MHz  ${MODE_NAMES[settings.mode] || 'AM'}`;
  renderBand();
}
$('#handlePlate').textContent = handle().toUpperCase();

// ============================================================
//  Audio
// ============================================================
let ctx = null;
let rxIn, rxGate, master, noiseGain, rxAnalyser, capNode, micSrc, micStream, micGainNode;
let farBus;                  // the faint far-away sounds under the static
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
  farBus = ctx.createGain(); farBus.gain.value = 0;
  farBus.connect(rxGate);
  setTimeout(prepareFar, 1200);

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
  // the far-away sounds sit under the static, follow it, and go quiet when anyone is on the channel
  if (farBus) farBus.gain.setTargetAtTime(transmitting || rxBusy() ? 0 : idleNoiseLevel() * FAR_LEVEL, ctx.currentTime, 0.08);
}

// ---------- skip: faint voices (any band) and Morse code (12 m) far away ----------
// With the squelch open you hear static, and now and then something faint and far off under it.
// The 10 voice clips can turn up on any channel; on 12 m there are also 10 Morse clips.
const FAR_LEVEL = 0.45;            // the far sounds' loudness, relative to the static
let farClips = null, farSrc = null, farTimer = 0, farLast = -1;
function prepareFar() {
  if (farClips || !ctx || !window.SkipSounds) return;
  const toBuf = (d) => { const b = ctx.createBuffer(1, d.length, RATE); b.getChannelData(0).set(d); return b; };
  farClips = { voices: SkipSounds.voices(10).map(toBuf), morse: SkipSounds.morse(10).map(toBuf) };
  scheduleFar(2, 6);
}
function scheduleFar(min = 4, max = 14) {
  clearTimeout(farTimer);
  farTimer = setTimeout(playFar, (min + Math.random() * (max - min)) * 1000);
}
function playFar() {
  if (!ctx || !farClips) return;
  if (farSrc || !squelchOpen() || transmitting || rxBusy()) { scheduleFar(2, 6); return; }
  // on 12 m it's mostly Morse; everywhere else it's voices
  const morse = settings.band === '12' && Math.random() < 0.7;
  const pool = morse ? farClips.morse : farClips.voices;
  let i = Math.floor(Math.random() * pool.length);
  const key = (morse ? 100 : 0) + i;
  if (key === farLast) { i = (i + 1) % pool.length; }
  farLast = (morse ? 100 : 0) + i;
  const src = ctx.createBufferSource();
  src.buffer = pool[i];
  src.playbackRate.value = 0.97 + Math.random() * 0.06;      // never quite the same twice
  const g = ctx.createGain();
  g.gain.value = 0.5 + Math.random() * 0.5;                  // some are fainter than others
  src.connect(g).connect(farBus);
  src.onended = () => { if (farSrc === src) { farSrc = null; scheduleFar(); } };
  farSrc = src;
  src.start();
}
// Changing channel or band leaves whatever was faintly there behind.
function stopFar() {
  if (!farSrc) return;
  const src = farSrc;
  farSrc = null;
  try { src.stop(); } catch {}
  if (farClips) scheduleFar(3, 9);
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
  sideband(id, d);
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
// Each built-in sound is a list of parts, made into 8 kHz samples:
//   [Hz, seconds]                 a steady tone
//   ['sweep', fromHz, toHz, s]    a glide
//   ['trill', aHz, bHz, s, step]  two tones swapping every step seconds
//   [0, s]                        silence
//   ['decay', ...part]            the part, fading out
const ROGER_SOUNDS = {
  classic: { name: 'Classic two-tone', parts: [[1050, 0.09], [1400, 0.09]] },
  single: { name: 'Single beep', parts: [[1000, 0.16]] },
  falling: { name: 'Two-tone, falling', parts: [[1400, 0.09], [1050, 0.09]] },
  triple: { name: 'Triple chirp', parts: [[1800, 0.04], [0, 0.03], [1800, 0.04], [0, 0.03], [1800, 0.04]] },
  trill: { name: 'Bumblebee trill', parts: [['trill', 1200, 1600, 0.32, 0.025]] },
  sweepUp: { name: 'Sweep up', parts: [['sweep', 600, 2200, 0.25]] },
  sweepDown: { name: 'Sweep down', parts: [['sweep', 2200, 600, 0.25]] },
  morseK: { name: 'Morse K (go ahead)', parts: [[800, 0.18], [0, 0.06], [800, 0.06], [0, 0.06], [800, 0.18]] },
  morseR: { name: 'Morse R (roger)', parts: [[800, 0.06], [0, 0.06], [800, 0.18], [0, 0.06], [800, 0.06]] },
  space: { name: 'Space sweep', parts: [['decay', 'sweep', 3000, 400, 0.4]] },
};
function synthRoger(parts) {
  const out = [];
  for (let part of parts) {
    let decay = false;
    if (part[0] === 'decay') { decay = true; part = part.slice(1); }
    const kind = typeof part[0] === 'string' ? part[0] : 'tone';
    const dur = kind === 'tone' ? part[1] : part[3];
    const n = Math.round(dur * RATE);
    let phase = 0;
    for (let k = 0; k < n; k++) {
      let f;
      if (kind === 'tone') f = part[0];
      else if (kind === 'sweep') f = part[1] + (part[2] - part[1]) * (k / n);
      else f = Math.floor(k / (part[4] * RATE)) % 2 ? part[2] : part[1];
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.min(1, k / 40, (n - k) / 40) * (decay ? Math.exp((-3 * k) / n) : 1);
      out.push(f ? Math.sin(phase) * 9000 * env : 0);
    }
  }
  return Int16Array.from(out);
}

// ---------- the user's own sounds, kept apart from the settings ----------
const MY_ROGERS_KEY = 'breaker40-rogers';
const myRogers = (() => { try { return JSON.parse(localStorage.getItem(MY_ROGERS_KEY) || '[]'); } catch { return []; } })();
function saveMyRogers() {
  try { localStorage.setItem(MY_ROGERS_KEY, JSON.stringify(myRogers)); return true; }
  catch { return false; }
}
const toB64 = (i16) => { let s = ''; const b = new Uint8Array(i16.buffer); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); };
const fromB64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Int16Array(u.buffer); };

// The chosen roger beep as 8 kHz samples (falls back to Classic if a sound was removed).
function rogerPcm(id = settings.rogerSound) {
  if (id.startsWith('my:')) {
    const mine = myRogers.find((r) => `my:${r.id}` === id);
    if (mine) return fromB64(mine.pcm);
  }
  return synthRoger((ROGER_SOUNDS[id] || ROGER_SOUNDS.classic).parts);
}
function rogerFrames(id) {
  const pcm = rogerPcm(id);
  const out = new Int16Array(Math.ceil(pcm.length / 160) * 160);
  out.set(pcm);
  const frames = [];
  for (let o = 0; o < out.length; o += 160) frames.push(out.slice(o, o + 160).buffer);
  return frames;
}

// Sends the roger beep, then unkeys. The first 0.2 s goes at once and the rest at real-time
// pace, so a long beep doesn't pile up at the other end (they skip ahead past 0.6 s of backlog).
let rogerTail = null;
function sendRogerThenUnkey() {
  const frames = rogerFrames();
  let i = 0;
  const unkey = () => { rogerTail = null; if (connected) sendJSON({ type: 'tx', on: false }); refreshTicker(); };
  const step = () => {
    if (!connected) { unkey(); return; }
    const burst = i === 0 ? 10 : 1;
    for (let k = 0; k < burst && i < frames.length; k++) ws.send(frames[i++]);
    if (i >= frames.length) { rogerTail = setTimeout(unkey, 40); return; }
    rogerTail = setTimeout(step, 20);
  };
  step();
}
// Keying up again during the beep just carries on (the base station still has us keyed).
function cancelRogerTail(unkey) {
  if (!rogerTail) return;
  clearTimeout(rogerTail);
  rogerTail = null;
  if (unkey && connected) sendJSON({ type: 'tx', on: false });
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
    sendJSON({ type: 'join', channel: netCh(), handle: handle(), wide: true });
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
        talkerModes.set(m.id, MODE_NAMES[m.mode] ? m.mode : 'am');
        ssbState.delete(m.id);
        lastHeard = m.handle;
        burst(0.16, 0.05);           // kerchunk as the carrier comes up
      } else {
        talkers.delete(m.id);
        players.delete(m.id);
        ssbState.delete(m.id);
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
  if (transmitting) stopTx(true);
  cancelRogerTail(true);
  stopFar();
  settings.channel = ch;
  save();
  talkers.clear();
  players.clear();
  lastHeard = '';
  showChannel();
  if (!quiet) clickSound();
  sendJSON({ type: 'join', channel: netCh(ch), handle: handle(), wide: true });
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
  if (active.has(netCh()) || talkers.size || rxBusy()) { scanHold = now + 3000; return; }
  if (now < scanHold) return;
  const here = [...active].filter((n) => inBand(n)).map((n) => n - BANDS[settings.band].base);
  if (here.length) {
    const list = here.sort((a, b) => a - b);
    const next = list.find((c) => c > settings.channel) || list[0];
    tune(next, true);
    scanHold = now + 3000;
    return;
  }
  if (!fromStatus) tune(settings.channel + 1, true);
}

function startTx() {
  if (transmitting) return;
  cancelRogerTail(false);
  if (!ctx) { initAudio(); }
  if (!connected) { toast('No base station — open SETUP'); return; }
  if (!micStream) { toast('No microphone'); return; }
  stopScan();
  transmitting = true;
  $('#ptt').classList.add('down');
  lamp('#lampTx', true);
  rxGate.gain.setTargetAtTime(0, ctx.currentTime, 0.01);   // half duplex: can't hear while keyed
  updateNoise();
  sendJSON({ type: 'tx', on: true, mode: settings.mode });
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
    if (settings.roger) sendRogerThenUnkey();
    else sendJSON({ type: 'tx', on: false });
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
$('#btn9').addEventListener('click', () => { stopScan(); setBand('11', true); tune(9); toast('CH 9 · Emergency'); });
$('#btn19').addEventListener('click', () => { stopScan(); setBand('11', true); tune(19); toast('CH 19 · Highway'); });
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
//  Sideband (SSB) and clarifier
// ============================================================
// OFF is plain AM. On USB or LSB, a voice from another single sideband radio comes in shifted
// by how far that radio is off frequency, so it sounds high-pitched or low-pitched. Each
// radio gets its own small offset (from its id), and the CLARIFIER tunes it back to natural.
// The wrong sideband (USB hearing LSB) comes out back to front, and AM and SSB don't mix:
// an AM radio turns sideband into garble, and a sideband radio hears AM with a carrier whistle.
const MODE_NAMES = { am: 'AM', usb: 'USB', lsb: 'LSB' };
const DRIFTS = [-450, -300, -150, 150, 300, 450];
const driftOf = (id) => DRIFTS[(Math.imul(id, 2654435761) >>> 0) % DRIFTS.length];
const HILBERT = (() => {             // 63-tap windowed Hilbert transformer for the 8 kHz voice
  const n = 63, mid = 31, h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i - mid;
    if (k % 2 !== 0) h[i] = (2 / (Math.PI * k)) * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  return h;
})();
const ssbState = new Map();          // sender id -> filter history and oscillator phase
// Moves every frequency in d by hz (negative = down). invert mirrors the spectrum instead.
function freqShift(st, d, hz, invert) {
  const w = (2 * Math.PI * hz) / RATE, hist = st.hist, n = HILBERT.length;
  for (let i = 0; i < d.length; i++) {
    hist[st.pos] = d[i];
    let q = 0;
    for (let k = 0; k < n; k++) q += HILBERT[k] * hist[(st.pos - k + n) % n];
    const iv = hist[(st.pos - 31 + n) % n];          // the input, delayed to line up with q
    st.pos = (st.pos + 1) % n;
    st.phase += w;
    if (st.phase > Math.PI) st.phase -= 2 * Math.PI; else if (st.phase < -Math.PI) st.phase += 2 * Math.PI;
    const c = Math.cos(st.phase), s = Math.sin(st.phase);
    d[i] = invert ? iv * c + q * s : iv * c - q * s;
  }
}
function sideband(id, d) {
  const tx = talkerModes.get(id) || 'am', rx = settings.mode;
  if (tx === 'am' && rx === 'am') return;
  let st = ssbState.get(id);
  if (!st) { st = { hist: new Float32Array(HILBERT.length), pos: 0, phase: 0, tone: 0 }; ssbState.set(id, st); }
  const clar = settings.clarifier;
  if (tx !== 'am' && rx !== 'am') {
    const off = driftOf(id) - clar;                  // 0 = tuned in: natural voice
    if (tx === rx) { if (Math.abs(off) >= 15) freqShift(st, d, off, false); }
    else freqShift(st, d, 3000 + off, true);         // wrong sideband: back to front
  } else if (rx === 'am') {
    // an AM radio can't resolve sideband: shifted, rectified garble ("Donald Duck")
    freqShift(st, d, 550 + driftOf(id), false);
    for (let i = 0; i < d.length; i++) d[i] = 0.55 * d[i] + 0.9 * (Math.abs(d[i]) - 0.08);
  } else {
    // a sideband radio on an AM signal: the voice moves with the clarifier and the carrier whistles
    if (Math.abs(clar) >= 15) freqShift(st, d, -clar, false);
    const f = 120 + Math.abs(clar), w = (2 * Math.PI * f) / RATE;
    for (let i = 0; i < d.length; i++) { st.tone += w; d[i] = 0.8 * d[i] + 0.12 * Math.sin(st.tone); }
    st.tone %= 2 * Math.PI;
  }
}

const ssbSwitch = $('#ssbSwitch');
function showMode() {
  ssbSwitch.dataset.mode = settings.mode;
  ssbSwitch.querySelectorAll('.ssb-labels span').forEach((s) => s.classList.toggle('on', s.dataset.mode === settings.mode));
  showChannel();
}
function setMode(mode) {
  if (!MODE_NAMES[mode] || mode === settings.mode) return;
  settings.mode = mode; save();
  ssbState.clear();
  showMode();
  toast(mode === 'am' ? 'Sideband off · AM' : mode === 'usb' ? 'USB · upper sideband' : 'LSB · lower sideband');
}
const MODES = ['usb', 'am', 'lsb'];
ssbSwitch.addEventListener('click', (e) => {
  const lab = e.target.closest('[data-mode]');
  if (lab) { setMode(lab.dataset.mode); return; }
  const r = ssbSwitch.querySelector('.ssb-slot').getBoundingClientRect();     // click on the slot: nearest position
  const pos = Math.max(0, Math.min(2, Math.floor(((e.clientY - r.top) / r.height) * 3)));
  setMode(MODES[pos]);
});
ssbSwitch.addEventListener('wheel', (e) => {
  e.preventDefault();
  const i = MODES.indexOf(settings.mode) + (e.deltaY > 0 ? 1 : -1);
  setMode(MODES[Math.max(0, Math.min(2, i))]);
}, { passive: false });
ssbSwitch.addEventListener('keydown', (e) => {
  const i = MODES.indexOf(settings.mode);
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { setMode(MODES[Math.max(0, i - 1)]); e.preventDefault(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { setMode(MODES[Math.min(2, i + 1)]); e.preventDefault(); }
});
showMode();

let clarToast = 0;
const clarKnob = makeKnob($('#knobClar'), {
  min: -800, max: 800, value: settings.clarifier,
  onChange: (v) => {
    v = Math.round(v / 10) * 10;
    if (Math.abs(v) < 20) v = 0;                     // a little detent at centre
    settings.clarifier = v; save();
    clearTimeout(clarToast);
    clarToast = setTimeout(() => toast(`Clarifier ${v > 0 ? '+' : ''}${v} Hz${settings.mode === 'am' ? ' · works on USB and LSB' : ''}`), 60);
  },
});
$('#knobClar').addEventListener('dblclick', () => clarKnob.set(0));

// ---------- roger beep choice (SETUP) ----------
const rogerSel = $('#inRoger');
function fillRogers() {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let html = '<optgroup label="Built in">' +
    Object.entries(ROGER_SOUNDS).map(([id, s]) => `<option value="${id}">${s.name}</option>`).join('') + '</optgroup>';
  if (myRogers.length) {
    html += '<optgroup label="Your sounds">' +
      myRogers.map((r) => `<option value="my:${r.id}">${esc(r.name)} (${r.secs.toFixed(1)} s)</option>`).join('') + '</optgroup>';
  }
  rogerSel.innerHTML = html;
  if (![...rogerSel.options].some((o) => o.value === settings.rogerSound)) settings.rogerSound = 'classic';
  rogerSel.value = settings.rogerSound;
  $('#btnRogerDel').disabled = !settings.rogerSound.startsWith('my:');
}
async function playRoger(id = settings.rogerSound) {
  if (!ctx) await initAudio();
  const pcm = rogerPcm(id);
  const ab = ctx.createBuffer(1, pcm.length, RATE);
  const d = ab.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) d[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = ab;
  src.connect(rxIn);          // through the receiver, so it sounds like it will on the air
  src.start();
}
rogerSel.addEventListener('change', () => {
  settings.rogerSound = rogerSel.value;
  if (!settings.roger) { settings.roger = true; rogerBtn.classList.add('on'); }   // picking a beep turns ROGER on
  save();
  $('#btnRogerDel').disabled = !settings.rogerSound.startsWith('my:');
  playRoger();
});
$('#btnRogerPlay').addEventListener('click', () => playRoger());
$('#btnRogerAdd').addEventListener('click', () => $('#inRogerFile').click());
$('#btnRogerDel').addEventListener('click', () => {
  const id = settings.rogerSound.slice(3);
  const i = myRogers.findIndex((r) => r.id === id);
  if (i < 0) return;
  const [gone] = myRogers.splice(i, 1);
  saveMyRogers();
  settings.rogerSound = 'classic'; save();
  fillRogers();
  toast(`Removed ${gone.name}`);
  $('#rogerNote').textContent = `Removed "${gone.name}". Your roger beep is back to ${ROGER_SOUNDS.classic.name}.`;
});
// A WAV file becomes 8 kHz mono, trimmed of silence at both ends, at most 3 s, at a steady level.
$('#inRogerFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const note = $('#rogerNote');
  try {
    if (myRogers.length >= 20) throw new Error('You already have 20 of your own sounds. Remove one first.');
    if (!ctx) await initAudio();
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    let f = (await off.startRendering()).getChannelData(0);
    let a = 0, b = f.length;
    while (a < b && Math.abs(f[a]) < 0.01) a++;
    while (b > a && Math.abs(f[b - 1]) < 0.01) b--;
    if (b - a < RATE * 0.02) throw new Error('That file is silent.');
    const cut = b - a > RATE * 3;
    f = f.subarray(a, Math.min(b, a + RATE * 3));
    let peak = 0;
    for (const v of f) peak = Math.max(peak, Math.abs(v));
    const gain = 12000 / (peak * 32768 || 1);
    const pcm = Int16Array.from(f, (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32768 * gain))));
    const n = Math.min(pcm.length, 400);   // short fades so it doesn't click
    for (let i = 0; i < n; i++) { const g = i / n; pcm[i] *= g; pcm[pcm.length - 1 - i] *= g; }
    const entry = {
      id: Date.now().toString(36),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 30) || 'My sound',
      secs: pcm.length / RATE,
      pcm: toB64(pcm),
    };
    myRogers.push(entry);
    if (!saveMyRogers()) { myRogers.pop(); throw new Error('There is no room left to store it. Remove one of your sounds first.'); }
    settings.rogerSound = `my:${entry.id}`;
    settings.roger = true; rogerBtn.classList.add('on');
    save();
    fillRogers();
    note.textContent = `Added "${entry.name}" (${entry.secs.toFixed(1)} s)${cut ? ', cut to 3 seconds' : ''}. It's now your roger beep.`;
    playRoger();
  } catch (err) {
    note.textContent = `Couldn't add that file: ${err && err.message ? err.message : err}`;
  }
});
fillRogers();

// ============================================================
//  Setup sheet
// ============================================================
const sheet = $('#setup');
function openSetup() {
  $('#inHandle').value = settings.handle;
  $('#inServer').value = settings.server;
  $('#inHost').checked = settings.host;
  $('#inTheme').value = settings.theme;
  $('#inPort').value = settings.port;
  $('#inGain').value = settings.micGain;
  $('#gainVal').textContent = `${Math.round(settings.micGain * 100)}%`;
  renderStations();
  showPttKey();
  showLatestVersion();
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
function drawCord() {
  const svg = $('#cord');
  if (settings.theme === 'base' || settings.theme === 'tube') {
    // desk mic: a plain cable from the back of the radio, sagging to the back of the mic's base
    // (cloth-covered and brown on the tube radio)
    const d = 'M880,440 C905,560 960,560 985,470';
    const [outer, inner] = settings.theme === 'tube' ? ['#1f130a', '#6b4a2b'] : ['#050506', '#2c2e33'];
    svg.innerHTML =
      `<path d="${d}" fill="none" stroke="${outer}" stroke-width="7" stroke-linecap="round"/>` +
      `<path d="${d}" fill="none" stroke="${inner}" stroke-width="3" stroke-linecap="round" ${settings.theme === 'tube' ? 'stroke-dasharray="2 2"' : ''}/>`;
    return;
  }
  // radio side jack -> into the mic's strain relief (centre x 1055, spans y 422-462; the mic is drawn on top)
  const p0 = [895, 410], p3 = [1055, 448];
  const c1 = [960, 600], c2 = [1055, 640];   // c2 straight below p3, so the cord rises straight into the mic
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
    const amp = Math.min(1, t * 14, (1 - t) * 9);   // coils fade out at both ends, so the cord plugs in straight
    const px = x + Math.cos(ang) * 9 * amp, py = y + Math.sin(ang) * 6 * amp;
    d += (i ? 'L' : 'M') + px.toFixed(1) + ',' + py.toFixed(1);
  }
  svg.innerHTML =
    `<path d="${d}" fill="none" stroke="#050506" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="${d}" fill="none" stroke="#2c2e33" stroke-width="2.5" stroke-linecap="round"/>`;
}

// ---------- themes ----------
const THEMES = {
  classic: { tagline: '10 · 11 · 12 METER TRANSCEIVER · 120 CHANNELS · AM / SSB' },
  base: { tagline: 'AM / SSB BASE STATION · 10 · 11 · 12 METER · 120 CHANNELS' },
  army: { tagline: 'ARMY FIELD RADIO · 10 · 11 · 12 METER · 120 CH · AM / SSB' },
  camo: { tagline: 'FIELD RADIO SET · 10 · 11 · 12 METER · 120 CH · AM / SSB' },
  tube: { tagline: 'Tube Type Receiver-Transmitter · 10 · 11 · 12 Meter · AM / SSB' },
  scanner: { tagline: 'SCANNER · 10 · 11 · 12 METER · 120 CH · AM / SSB' },
};
function applyTheme() {
  if (!THEMES[settings.theme]) settings.theme = 'classic';
  document.body.classList.toggle('theme-base', settings.theme === 'base');
  document.body.classList.toggle('theme-camo', settings.theme === 'camo');
  document.body.classList.toggle('theme-army', settings.theme === 'army');
  document.body.classList.toggle('theme-tube', settings.theme === 'tube');
  document.body.classList.toggle('theme-scanner', settings.theme === 'scanner');
  document.querySelector('.tagline').textContent = THEMES[settings.theme].tagline;
  buildMeter();
  drawCord();
}
applyTheme();
$('#inTheme').addEventListener('change', (e) => {
  settings.theme = e.target.value; save();
  applyTheme();
});

// ---------- updates ----------
// Check for updates: if a newer release exists, download it, close, install, and start again.
const updBtn = $('#btnUpdate'), updStatus = $('#updateStatus');
window.cb.version().then((v) => { $('#verCurrent').textContent = v; });
window.cb.onUpdateProgress((pct) => { updStatus.textContent = `Downloading the update… ${pct}%`; });
// Opening SETUP looks up the latest version (once per run) so it shows without clicking. It installs nothing.
let latestLooked = false;
async function showLatestVersion() {
  if (latestLooked) return;
  latestLooked = true;
  const r = await window.cb.checkUpdate();
  if (!r.ok) { $('#verLatest').textContent = 'unknown'; latestLooked = false; return; }
  $('#verLatest').textContent = r.latest;
  if (r.available && !updBtn.disabled) updStatus.textContent = `Version ${r.latest} is out. Click Check for updates to install it.`;
}
updBtn.addEventListener('click', async () => {
  updBtn.disabled = true;
  updStatus.textContent = 'Checking for updates…';
  const r = await window.cb.checkUpdate();
  if (!r.ok) {
    updStatus.textContent = `Couldn't check for updates: ${r.error}`;
    updBtn.disabled = false;
    return;
  }
  $('#verLatest').textContent = r.latest;
  if (!r.available) {
    updStatus.textContent = `You have the latest version (${r.current}).`;
    updBtn.disabled = false;
    return;
  }
  if (!r.auto) {
    updStatus.textContent = `Version ${r.latest} is out. This copy can't update itself, so the download page is opening.`;
    await window.cb.installUpdate();
    updBtn.disabled = false;
    return;
  }
  if (transmitting) stopTx();
  updStatus.textContent = `Version ${r.latest} found. Downloading…`;
  const res = await window.cb.installUpdate();
  if (!res.ok) {
    updStatus.textContent = `The update failed: ${res.error}`;
    updBtn.disabled = false;
    return;
  }
  updStatus.textContent = `Installing ${r.latest}. The radio closes now and opens again when it's done.`;
});

// ---------- manual ----------
window.cb.manualHtml().then((html) => { $('#manualHtml').innerHTML = html; });
async function openManual(kind) {
  $('#manualStatus').textContent = kind === 'pdf' ? 'Making the PDF…' : 'Opening…';
  const r = await window.cb.openManual(kind);
  $('#manualStatus').textContent = r.ok ? `Opened ${r.file}` : `Couldn't open it: ${r.error}`;
}
$('#btnManualTxt').addEventListener('click', () => openManual('txt'));
$('#btnManualPdf').addEventListener('click', () => openManual('pdf'));

// Up / Down arrow keys change channel (when you're not typing).
window.addEventListener('keydown', (e) => {
  if (!$('#setup').hidden || typing() || capturingKey) return;
  if (document.activeElement && document.activeElement.closest('.knob, .ssb, .band-switch')) return;
  if (e.key === 'ArrowUp') { e.preventDefault(); stopScan(); tune(settings.channel + 1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); stopScan(); tune(settings.channel - 1); }
});

// ============================================================
//  Boot
// ============================================================
showBand();
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
