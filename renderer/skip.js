'use strict';
// ============================================================
//  Skip: faint far-away sounds heard under the static with the squelch open.
//  Everything is synthesised at 8 kHz, so there are no recordings in the app.
//    SkipSounds.voices(n)  distant, unintelligible voices (made-up speech), fading in and out
//    SkipSounds.morse(n)   distant Morse code (CQ calls, reports, sign-offs) for the 12 m band
//  Each returns n Float32Array clips, levelled to the same loudness (RMS 0.2).
// ============================================================
(() => {
  const RATE = 8000;
  const TAU = Math.PI * 2;

  // A small seeded random, so each clip is different but every start makes the same set.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const pick = (r, list) => list[Math.floor(r() * list.length)];
  const between = (r, a, b) => a + (b - a) * r();

  // Two-pole band-pass (RBJ, constant peak gain), coefficients settable on the fly.
  function bandpass() {
    let b0 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return {
      set(f, bw) {
        const w = (TAU * f) / RATE, q = f / bw, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
        b0 = alpha / a0; b2 = -alpha / a0; a1 = (-2 * Math.cos(w)) / a0; a2 = (1 - alpha) / a0;
      },
      run(x) { const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; },
    };
  }
  function onePole(fc, high) {
    const a = Math.exp((-TAU * fc) / RATE);
    let y = 0, prev = 0;
    return (x) => { y = (1 - a) * x + a * y; if (!high) return y; const o = x - y; prev = o; return o; };
  }

  // Moves every frequency up or down by hz (used to put some voices a little off frequency,
  // the way a sideband station sounds when it isn't tuned in).
  function freqShift(d, hz) {
    const n = 63, mid = 31, h = new Float32Array(n);
    for (let i = 0; i < n; i++) { const k = i - mid; if (k % 2) h[i] = (2 / (Math.PI * k)) * (0.54 - 0.46 * Math.cos((TAU * i) / (n - 1))); }
    const out = new Float32Array(d.length);
    let phase = 0;
    const w = (TAU * hz) / RATE;
    for (let i = 0; i < d.length; i++) {
      let q = 0;
      for (let k = 0; k < n; k++) { const j = i - k; if (j >= 0) q += h[k] * d[j]; }
      const iv = i - mid >= 0 ? d[i - mid] : 0;
      phase += w;
      out[i] = iv * Math.cos(phase) - q * Math.sin(phase);
    }
    return out;
  }

  // Slow fading (QSB) with the odd deep fade, so it comes and goes like a far-off signal.
  function fade(d, r) {
    const f1 = between(r, 0.15, 0.45), f2 = between(r, 0.6, 1.4), p1 = r() * TAU, p2 = r() * TAU;
    const depth = between(r, 0.45, 0.8);
    for (let i = 0; i < d.length; i++) {
      const t = i / RATE;
      const g = 1 - depth * (0.5 + 0.5 * Math.sin(TAU * f1 * t + p1)) * (0.75 + 0.25 * Math.sin(TAU * f2 * t + p2));
      d[i] *= Math.max(0.05, g);
    }
    // fade in and out at the ends
    const edge = Math.min(d.length >> 2, RATE * 0.4);
    for (let i = 0; i < edge; i++) { const g = i / edge; d[i] *= g; d[d.length - 1 - i] *= g; }
  }
  function level(d, rms = 0.2) {
    let s = 0;
    for (const v of d) s += v * v;
    const k = rms / (Math.sqrt(s / d.length) || 1);
    for (let i = 0; i < d.length; i++) d[i] = Math.max(-1, Math.min(1, d[i] * k));
    return d;
  }

  // ---------- distant voices ----------
  // Vowel formants (Hz): enough to sound like speech without any real words.
  const VOWELS = [[730, 1090, 2440], [530, 1840, 2480], [270, 2290, 3010], [570, 840, 2410], [300, 870, 2240], [490, 1350, 1690], [660, 1720, 2410], [440, 1020, 2240]];

  // One talker: phrases of syllables with a falling pitch, little consonant bursts between them.
  function talker(r, secs, voice) {
    const n = Math.round(secs * RATE);
    const out = new Float32Array(n);
    const f1 = bandpass(), f2 = bandpass(), f3 = bandpass();
    const hiss = onePole(1800, true);
    let t = Math.round(between(r, 0.1, 0.5) * RATE);
    let phase = 0;
    while (t < n - RATE * 0.3) {
      const phraseLen = between(r, 1.0, 2.6) * RATE;
      const phraseEnd = Math.min(n - RATE * 0.2, t + phraseLen);
      let syll = 0;
      while (t < phraseEnd) {
        const dur = Math.round(between(r, 0.1, 0.24) / voice.rate * RATE);
        const [a, b, c] = pick(r, VOWELS);
        const [na, nb, nc] = pick(r, VOWELS);
        const loud = between(r, 0.6, 1);
        const progress = (t - (phraseEnd - phraseLen)) / phraseLen;     // 0..1 through the phrase
        const pitch0 = voice.f0 * (1.12 - 0.22 * progress) * between(r, 0.92, 1.08);
        // a short consonant (noise burst) before some syllables
        if (syll && r() < 0.45) {
          const cn = Math.round(between(r, 0.02, 0.05) * RATE);
          for (let k = 0; k < cn && t < n; k++, t++) out[t] += hiss((Math.random() * 2 - 1)) * 0.25 * loud;
        }
        for (let k = 0; k < dur && t < n; k++, t++) {
          const x = k / dur;
          if ((k & 15) === 0) {                         // glide toward the next vowel
            f1.set(a + (na - a) * x * 0.5, 90);
            f2.set(b + (nb - b) * x * 0.5, 110);
            f3.set(c, 160);
          }
          const pitch = pitch0 * (1 + 0.04 * Math.sin(TAU * 5 * (t / RATE)));
          phase += pitch / RATE;
          if (phase >= 1) phase -= 1;
          const src = (2 * phase - 1) - 0.3 * Math.sin(TAU * phase);     // buzzy glottal-ish source
          const env = Math.sin(Math.PI * Math.min(1, x * 1.2)) ** 0.7 * loud;
          out[t] += (f1.run(src) * 1.0 + f2.run(src) * 0.7 + f3.run(src) * 0.3) * env;
        }
        syll++;
        if (r() < 0.12) t += Math.round(between(r, 0.05, 0.15) * RATE);   // a little hesitation
      }
      t += Math.round(between(r, 0.35, 0.9) * RATE);                     // breath between phrases
    }
    return out;
  }

  function voices(count = 10) {
    const clips = [];
    for (let i = 0; i < count; i++) {
      const r = rng(1000 + i * 7919);
      const secs = between(r, 5, 8);
      const deep = r() < 0.6;
      let d = talker(r, secs, { f0: deep ? between(r, 92, 135) : between(r, 175, 230), rate: between(r, 0.85, 1.2) });
      // some clips are two people trading words
      if (r() < 0.5) {
        const other = talker(r, secs, { f0: deep ? between(r, 170, 225) : between(r, 95, 130), rate: between(r, 0.85, 1.2) });
        const g = between(r, 0.4, 0.75);
        for (let k = 0; k < d.length; k++) d[k] += other[k] * g;
      }
      // far away: narrow band, a bit of distortion, and some a little off frequency
      const hp = onePole(380, true), lp1 = onePole(2300), lp2 = onePole(2300);
      for (let k = 0; k < d.length; k++) d[k] = Math.tanh(lp2(lp1(hp(d[k]))) * 3) / 3;
      if (r() < 0.4) {
        d = freqShift(d, (r() < 0.5 ? -1 : 1) * between(r, 120, 380));
        // keep a shifted-down voice out of the rumble, like the radio's own filters would
        const hp2 = onePole(380, true), hp3 = onePole(380, true), lp3 = onePole(2400);
        for (let k = 0; k < d.length; k++) d[k] = lp3(hp3(hp2(d[k])));
      }
      fade(d, r);
      clips.push(level(d));
    }
    return clips;
  }

  // ---------- distant Morse code (12 m) ----------
  const MORSE = {
    A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
    N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
    '/': '-..-.', '?': '..--..',
  };
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  // A made-up call sign: one or two letters, a digit, two or three letters.
  function call(r) {
    let s = pick(r, ['K', 'W', 'N', 'G', 'F', 'D', 'I', 'V', 'J', 'P', 'E']);
    if (r() < 0.5) s += pick(r, [...LETTERS]);
    s += Math.floor(r() * 10);
    const tail = r() < 0.5 ? 2 : 3;
    for (let i = 0; i < tail; i++) s += pick(r, [...LETTERS]);
    return s;
  }
  function message(r) {
    const a = call(r), b = call(r), rst = `5${pick(r, [5, 7, 8, 9])}9`;
    const name = pick(r, ['BOB', 'JIM', 'ANN', 'TOM', 'SUE', 'ED', 'AL', 'JOE', 'KEN', 'LIZ']);
    return pick(r, [
      `CQ CQ CQ DE ${a} ${a} K`,
      `CQ CQ DE ${a} ${a} ${a} PSE K`,
      `${b} DE ${a} UR RST ${rst} ${rst} BK`,
      `${a} DE ${b} TNX FER QSO 73 SK`,
      `QRZ? DE ${a} K`,
      `${b} ${b} DE ${a} R R NAME ${name} ${name} BK`,
      `CQ TEST ${a} TEST`,
      `${a} DE ${b} GM OM UR ${rst} QTH ${pick(r, ['OHIO', 'TEXAS', 'MAINE', 'IDAHO', 'UTAH', 'IOWA'])} HW? BK`,
      `TU ${a} 73 E E`,
      `${b} DE ${a} QSL TNX 73 GL SK`,
    ]);
  }
  // Keys a message into on/off tone with soft edges at the given speed and pitch.
  function key(text, wpm, hz, secs, r) {
    const n = Math.round(secs * RATE);
    const out = new Float32Array(n);
    const dit = Math.round((1.2 / wpm) * RATE);
    const ramp = Math.round(0.005 * RATE);
    let t = Math.round(between(r, 0.2, 0.8) * RATE), phase = 0;
    const drift = between(r, -8, 8);                  // the tone wanders a few Hz
    const tone = (len) => {
      for (let k = 0; k < len && t < n; k++, t++) {
        const env = Math.min(1, k / ramp, (len - k) / ramp);
        phase += (TAU * (hz + drift * (t / n))) / RATE;
        out[t] = Math.sin(phase) * env;
      }
    };
    for (const word of text.split(' ')) {
      for (const ch of word) {
        const code = MORSE[ch];
        if (!code) continue;
        [...code].forEach((sym, i) => { if (i) t += dit; tone(sym === '.' ? dit : dit * 3); });
        t += dit * 3;
        if (t >= n) return out;
      }
      t += dit * 4;
      if (t >= n) return out;
    }
    return out;
  }
  function morse(count = 10) {
    const clips = [];
    for (let i = 0; i < count; i++) {
      const r = rng(5000 + i * 104729);
      const secs = between(r, 5, 9);
      const d = key(message(r), between(r, 13, 28), between(r, 520, 880), secs, r);
      // now and then a second, fainter station underneath at another pitch
      if (r() < 0.4) {
        const other = key(message(r), between(r, 15, 30), between(r, 450, 950), secs, r);
        const g = between(r, 0.25, 0.5);
        for (let k = 0; k < d.length; k++) d[k] += other[k] * g;
      }
      const lp = onePole(1500);
      for (let k = 0; k < d.length; k++) d[k] = lp(d[k]);
      fade(d, r);
      clips.push(level(d));
    }
    return clips;
  }

  window.SkipSounds = { voices, morse, RATE };
})();
