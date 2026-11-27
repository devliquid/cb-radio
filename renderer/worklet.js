// Turns the microphone into 8 kHz mono Int16 frames of 20 ms (160 samples).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 8000;
    this.pos = 0;
    this.acc = 0;
    this.n = 0;
    this.frame = new Int16Array(160);
    this.fi = 0;
    this.active = false;
    this.sq = 0;
    this.sqn = 0;
    this.port.onmessage = (e) => { this.active = !!e.data.active; };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sq += s * s;
      this.sqn++;
      this.acc += s;
      this.n++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.frame[this.fi++] = v * 32767;
        if (this.fi === 160) {
          this.fi = 0;
          const level = Math.sqrt(this.sq / this.sqn);
          this.sq = 0;
          this.sqn = 0;
          if (this.active) {
            const buf = this.frame.slice().buffer;
            this.port.postMessage({ pcm: buf, level }, [buf]);
          } else {
            this.port.postMessage({ level });
          }
        }
      }
    }
    return true;
  }
}

registerProcessor('cb-capture', CaptureProcessor);
