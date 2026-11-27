// Checks the base station built for this platform (dist/Breaker40-BaseStation.exe on Windows,
// dist/Breaker40-BaseStation-linux-<arch> on Linux): settings file, flags, typed menu, errors, relaying audio.
//   npm run dist:relay && node test/basestation-exe-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const exeName = process.platform === 'win32' ? 'Breaker40-BaseStation.exe' : `Breaker40-BaseStation-${process.platform}-${process.arch}`;
const src = path.join(__dirname, '..', 'dist', exeName);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b40-'));
const exe = path.join(dir, exeName);
fs.copyFileSync(src, exe);
fs.chmodSync(exe, 0o755);
const settingsFile = path.join(dir, 'relay-settings.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function run(args = [], env = {}) {
  const p = spawn(exe, args, { cwd: os.tmpdir(), env: { ...process.env, PORT: '', HOST: '', ...env } });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.stderr.on('data', (d) => { p.out += d; });
  p.done = new Promise((r) => p.on('exit', (code) => r(code)));
  return p;
}
async function until(p, text, ms = 8000) {
  const end = Date.now() + ms;
  while (!p.out.includes(text)) {
    if (Date.now() > end) throw new Error(`timed out waiting for "${text}". Output so far:\n${p.out}`);
    await wait(50);
  }
}
function client(url, channel, handle) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    ws.msgs = []; ws.bins = [];
    ws.on('message', (d, bin) => (bin ? ws.bins : ws.msgs).push(bin ? d : JSON.parse(d)));
    ws.once('open', () => { ws.send(JSON.stringify({ type: 'join', channel, handle })); res(ws); });
    ws.once('error', rej);
  });
}

(async () => {
  // --help
  const help = spawnSync(exe, ['--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /--port N/);
  assert.match(help.stdout, /--ip ADDRESS/);
  console.log('ok  --help');

  // first run: creates the settings file with defaults next to the exe
  let p = run(['--port', '7171']);
  await until(p, 'ON THE AIR');
  const first = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.deepStrictEqual(first, { port: 7140, ip: '0.0.0.0' }, 'defaults written, flag not saved without --save');
  assert.match(p.out, /port 7171/, 'flag overrides file');

  // relays audio between two people on the same channel
  const a = await client('ws://127.0.0.1:7171', 19, 'Alpha');
  const b = await client('ws://127.0.0.1:7171', 19, 'Bravo');
  await wait(100);
  a.send(JSON.stringify({ type: 'tx', on: true }));
  const pcm = Buffer.alloc(320); pcm.writeInt16LE(4321, 0);
  a.send(pcm);
  await wait(200);
  assert.strictEqual(b.bins.length, 1, 'Bravo hears Alpha');
  assert.strictEqual(b.bins[0].readInt16LE(4), 4321);
  await wait(1200);
  assert.match(p.out, /2 connected · CH19: 2/, 'console shows who is on');
  a.close(); b.close();
  p.kill(); await p.done;
  console.log('ok  settings file created, flags, audio relayed, live status');

  // --save writes flags into the file
  p = run(['--port', '7172', '--ip', '127.0.0.1', '--save']);
  await until(p, 'ON THE AIR');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { port: 7172, ip: '127.0.0.1' });
  assert.match(p.out, /ws:\/\/127\.0\.0\.1:7172/);
  p.kill(); await p.done;
  console.log('ok  --save');

  // the settings file is used on the next start
  p = run();
  await until(p, 'ON THE AIR');
  assert.match(p.out, /listening on 127\.0\.0\.1, port 7172/);
  p.kill(); await p.done;
  console.log('ok  settings file read on start');

  // typed menu: s -> new port and "every network", then the old port is closed and the new one works
  p = run([], { BREAKER_CONSOLE: '1' });
  await until(p, 'Type a letter');
  p.stdin.write('s\n');
  await until(p, 'Port [7172]');
  p.stdin.write('7173\n');
  await until(p, 'Pick 1-');
  p.stdin.write('1\n');
  await until(p, 'listening on 0.0.0.0, port 7173');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), { port: 7173, ip: '0.0.0.0' });
  const c = await client('ws://127.0.0.1:7173', 9, 'Charlie');
  c.close();
  await assert.rejects(client('ws://127.0.0.1:7172', 9, 'Old'), 'old port closed');
  // bad input is refused and asked again
  p.stdin.write('s\n');
  await until(p, 'Port [7173]');
  p.stdin.write('99999\n');
  await until(p, "isn't a port");
  p.stdin.write('\n');
  await until(p, 'Pick 1-');
  p.stdin.write('not-an-ip\n');
  await until(p, "isn't an IP address");
  p.stdin.write('\n');
  await until(p, 'No change');
  p.stdin.write('q\n');
  assert.strictEqual(await p.done, 0);
  assert.match(p.out, /Off the air/);
  console.log('ok  typed menu: change port/IP, validation, quit');

  // errors are explained
  p = run(['--ip', '10.254.254.254']);
  assert.strictEqual(await p.done, 1);
  assert.match(p.out, /not an address of this machine/);
  const blocker = net.createServer().listen(7174, '0.0.0.0');
  await wait(100);
  p = run(['--port', '7174']);
  assert.strictEqual(await p.done, 1);
  assert.match(p.out, /already in use/);
  blocker.close();
  p = run(['--port', 'abc']);
  assert.strictEqual(await p.done, 2);
  assert.match(p.out, /isn't a port/);
  console.log('ok  bad IP, port in use, bad flag');

  // a broken settings file falls back to defaults instead of crashing
  fs.writeFileSync(settingsFile, '{ this is not json');
  p = run(['--port', '7175']);
  await until(p, 'ON THE AIR');
  assert.match(p.out, /Couldn't read/);
  p.kill(); await p.done;
  console.log('ok  broken settings file');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('base station exe test: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
