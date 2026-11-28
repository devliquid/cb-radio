// Starts a base station and checks that audio only reaches people on the same channel.
const assert = require('assert');
const WebSocket = require('ws');
const { startServer } = require('../server/server');

const open = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.msgs = [];
  ws.bins = [];
  ws.on('message', (d, bin) => (bin ? ws.bins : ws.msgs).push(bin ? d : JSON.parse(d)));
  ws.once('open', () => res(ws));
  ws.once('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = await startServer(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${srv.port}`;
  const a = await open(url), b = await open(url), c = await open(url);
  a.send(JSON.stringify({ type: 'join', channel: 19, handle: 'Rubber<Duck>' }));
  b.send(JSON.stringify({ type: 'join', channel: 19, handle: 'Bandit' }));
  c.send(JSON.stringify({ type: 'join', channel: 9, handle: 'Smokey' }));
  await wait(100);

  const st = c.msgs.filter((m) => m.type === 'status').pop();
  assert.strictEqual(st.counts[18], 2, 'two on 19');
  assert.strictEqual(st.counts[8], 1, 'one on 9');

  // audio before keying up is dropped
  a.send(Buffer.alloc(320));
  await wait(50);
  assert.strictEqual(b.bins.length, 0, 'unkeyed audio is not relayed');

  a.send(JSON.stringify({ type: 'tx', on: true }));
  const pcm = Buffer.alloc(320); pcm.writeInt16LE(1234, 0);
  a.send(pcm);
  await wait(100);
  const txOn = b.msgs.find((m) => m.type === 'tx' && m.on);
  assert.ok(txOn, 'B sees A key up');
  assert.strictEqual(txOn.handle, 'RubberDuck', 'handle is cleaned');
  assert.strictEqual(b.bins.length, 1, 'B hears A');
  assert.strictEqual(b.bins[0].length, 324);
  assert.strictEqual(txOn.mode, 'am', 'a radio that sends no mode is AM');

  // the sideband mode travels with the key-up; anything unknown counts as AM
  for (const [sent, expect] of [['lsb', 'lsb'], ['usb', 'usb'], ['bogus', 'am']]) {
    a.send(JSON.stringify({ type: 'tx', on: false }));
    await wait(30);
    b.msgs.length = 0;
    a.send(JSON.stringify({ type: 'tx', on: true, mode: sent }));
    await wait(60);
    const on = b.msgs.find((m) => m.type === 'tx' && m.on);
    assert.ok(on && on.mode === expect, `mode ${sent} arrives as ${expect}`);
  }
  assert.strictEqual(b.bins[0].readInt16LE(4), 1234, 'audio intact');
  assert.strictEqual(c.bins.length, 0, 'C on another channel hears nothing');
  assert.strictEqual(a.bins.length, 0, 'no echo back to the talker');
  const active = c.msgs.filter((m) => m.type === 'status').pop().active;
  assert.deepStrictEqual(active, [19], 'channel 19 shows as active for scanners');

  // switching channel unkeys
  a.send(JSON.stringify({ type: 'join', channel: 9, handle: 'RubberDuck' }));
  await wait(100);
  assert.ok(b.msgs.find((m) => m.type === 'tx' && !m.on), 'B sees A unkey on channel change');

  // dropping off unkeys too
  c.send(JSON.stringify({ type: 'tx', on: true }));
  await wait(50);
  c.close();
  await wait(100);
  assert.ok(a.msgs.find((m) => m.type === 'tx' && !m.on && m.handle === 'Smokey'), 'disconnect unkeys');

  a.close(); b.close();
  await srv.close();
  console.log('relay test: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
