// Breaker 40 relay ("base station").
// Every app connects here over a WebSocket. People on the same channel hear each other.
//
// Protocol
//   client -> server (text JSON):
//     {type:'join', channel:1..40, handle}   tune to a channel
//     {type:'handle', handle}                 change your handle
//     {type:'tx', on:true|false, mode}        key / unkey the mic; mode is 'am', 'usb' or 'lsb'
//   client -> server (binary): 8 kHz mono Int16 PCM, only while keyed
//   server -> client (text JSON):
//     {type:'hello', id}
//     {type:'status', counts:[40], active:[channel numbers with someone talking]}
//     {type:'tx', id, handle, on, mode}
//   server -> client (binary): uint32 LE sender id + the sender's PCM

const http = require('http');
const { WebSocketServer } = require('ws');

const MAX_FRAME = 4096;        // bytes of audio per message
const MAX_TX_MS = 3 * 60_000;  // a stuck mic is unkeyed after 3 minutes
const MODES = new Set(['am', 'usb', 'lsb']);

function sanitize(h) {
  const s = String(h || '').replace(/[^\w .\-'!?#&]/g, '').trim().slice(0, 16);
  return s || 'Unknown';
}

function startServer(port = 7155, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Breaker 40 CB base station is on the air.\n');
  });
  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
  const clients = new Set();
  let nextId = 1;
  let statusTimer = null;

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(msg); };

  function status() {
    const counts = new Array(40).fill(0);
    const active = new Set();
    for (const c of clients) {
      if (!c.channel) continue;
      counts[c.channel - 1]++;
      if (c.tx) active.add(c.channel);
    }
    return JSON.stringify({ type: 'status', counts, active: [...active] });
  }
  // Coalesce bursts of changes into one status message.
  function broadcastStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      const msg = status();
      for (const c of clients) send(c.ws, msg);
    }, 30);
  }
  function toChannel(from, obj) {
    const msg = JSON.stringify(obj);
    for (const c of clients) if (c !== from && c.channel === from.channel) send(c.ws, msg);
  }
  function endTx(c) {
    if (!c.tx) return;
    c.tx = false;
    clearTimeout(c.txTimer);
    toChannel(c, { type: 'tx', id: c.id, handle: c.handle, on: false });
    broadcastStatus();
  }

  wss.on('connection', (ws) => {
    const c = { ws, id: nextId++ >>> 0, channel: 0, handle: 'Unknown', tx: false, mode: 'am', alive: true, txTimer: null };
    clients.add(c);
    send(ws, JSON.stringify({ type: 'hello', id: c.id }));
    send(ws, status());

    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!c.channel || !c.tx || data.length > MAX_FRAME) return;
        const out = Buffer.allocUnsafe(4 + data.length);
        out.writeUInt32LE(c.id, 0);
        data.copy(out, 4);
        for (const o of clients) {
          if (o !== c && o.channel === c.channel && o.ws.readyState === 1) o.ws.send(out, { binary: true });
        }
        return;
      }
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'join') {
        const ch = m.channel | 0;
        if (ch < 1 || ch > 40) return;
        endTx(c);
        c.channel = ch;
        c.handle = sanitize(m.handle);
        // tell the newcomer who is already talking here
        for (const o of clients) {
          if (o !== c && o.tx && o.channel === ch) send(ws, JSON.stringify({ type: 'tx', id: o.id, handle: o.handle, on: true, mode: o.mode }));
        }
        broadcastStatus();
      } else if (m.type === 'handle') {
        c.handle = sanitize(m.handle);
      } else if (m.type === 'tx' && c.channel) {
        if (m.on && !c.tx) {
          c.tx = true;
          c.mode = MODES.has(m.mode) ? m.mode : 'am';
          c.txTimer = setTimeout(() => endTx(c), MAX_TX_MS);
          toChannel(c, { type: 'tx', id: c.id, handle: c.handle, on: true, mode: c.mode });
          broadcastStatus();
        } else if (!m.on) {
          endTx(c);
        }
      }
    });
    ws.on('close', () => { endTx(c); clients.delete(c); broadcastStatus(); });
    ws.on('error', () => {});
  });

  // Drop connections that went away without saying goodbye.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch {}
    }
  }, 20_000);

  // ws re-emits the http server's errors; listen failures are reported through the promise below
  wss.on('error', () => {});

  return new Promise((resolve, reject) => {
    const fail = (err) => {
      clearInterval(heartbeat);
      wss.close();
      reject(err);
    };
    server.once('error', fail);
    server.listen(port, host, () => {
      server.off('error', fail);
      resolve({
        port: server.address().port,
        stats: () => {
          const counts = new Array(40).fill(0);
          for (const c of clients) if (c.channel) counts[c.channel - 1]++;
          return { people: clients.size, counts };
        },
        close: () => new Promise((done) => {
          clearInterval(heartbeat);
          for (const c of clients) c.ws.terminate();
          wss.close();
          server.close(() => done());
        }),
      });
    });
  });
}

module.exports = { startServer };

// `node server.js` runs the stand-alone base station with its settings file and console.
if (require.main === module) require('./relay').main();
