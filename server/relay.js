// Breaker 40 Base Station: the stand-alone relay.
//
// Built into Breaker40-BaseStation.exe, or run with `node relay.js`.
// Settings come from relay-settings.json next to the exe (created on first run),
// then the PORT / HOST environment variables, then command-line flags:
//
//   Breaker40-BaseStation.exe --port 7140 --ip 0.0.0.0 [--save]
//
// While it runs in a console window, type  s  and Enter to change the port or IP.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const readline = require('readline');
const { parseArgs } = require('util');
const { startServer } = require('./server');

const APP = 'Breaker 40 Base Station';
const DEFAULTS = { port: 7140, ip: '0.0.0.0' };

const isExe = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const homeDir = isExe ? path.dirname(process.execPath) : __dirname;
const fallbackDir = path.join(process.env.APPDATA || os.homedir(), 'Breaker40BaseStation');
let settingsFile = path.join(homeDir, 'relay-settings.json');

// ---------- settings ----------
function checkPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
function checkIp(v) {
  v = String(v || '').trim();
  if (v === 'localhost') return '127.0.0.1';
  return net.isIP(v) ? v : null;
}
function loadSettings() {
  for (const file of [settingsFile, path.join(fallbackDir, 'relay-settings.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      settingsFile = file;
      return {
        port: checkPort(raw.port) || DEFAULTS.port,
        ip: checkIp(raw.ip) || DEFAULTS.ip,
      };
    } catch (err) {
      if (err.code !== 'ENOENT') console.log(`  ! Couldn't read ${file} (${err.message}). Using defaults.`);
    }
  }
  const s = { ...DEFAULTS };
  saveSettings(s, true);
  return s;
}
function saveSettings(s, quiet = false) {
  const body = JSON.stringify({ port: s.port, ip: s.ip }, null, 2) + '\n';
  try {
    fs.writeFileSync(settingsFile, body);
  } catch {
    // e.g. the exe sits in a read-only folder: keep settings in %APPDATA% instead
    try {
      fs.mkdirSync(fallbackDir, { recursive: true });
      settingsFile = path.join(fallbackDir, 'relay-settings.json');
      fs.writeFileSync(settingsFile, body);
    } catch (err) {
      console.log(`  ! Couldn't save settings: ${err.message}`);
      return;
    }
  }
  if (!quiet) console.log(`  Saved to ${settingsFile}`);
}

function usage() {
  const exe = isExe ? path.basename(process.execPath) : 'node relay.js';
  console.log(`
${APP}

  ${exe} [--port N] [--ip ADDRESS] [--save]

  --port N        port to listen on (1-65535). Default ${DEFAULTS.port}.
  --ip ADDRESS    address to listen on. 0.0.0.0 = every network on this machine
                  (the usual choice), 127.0.0.1 = this machine only, or one of
                  this machine's own addresses. --host works too.
  --save          also write these values to relay-settings.json
  --help          show this

  Settings file:  ${settingsFile}
  Environment:    PORT and HOST are used when set (flags still win).
`);
}

// ---------- network info ----------
function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
  }
  return out;
}
function connectAddresses(s) {
  if (s.ip === '0.0.0.0' || s.ip === '::') {
    return [...localAddresses().map((a) => `ws://${a.address}:${s.port}`), `ws://localhost:${s.port}`];
  }
  const host = s.ip.includes(':') ? `[${s.ip}]` : s.ip;
  return [`ws://${host}:${s.port}`];
}
function explain(err, s) {
  switch (err.code) {
    case 'EADDRINUSE': return `Port ${s.port} is already in use by another program (or another copy of the base station).`;
    case 'EADDRNOTAVAIL': return `${s.ip} is not an address of this machine. Use 0.0.0.0 or one of: ${localAddresses().map((a) => a.address).join(', ') || 'none found'}.`;
    case 'EACCES': return `Windows refused port ${s.port}. Try a port above 1024.`;
    default: return err.message;
  }
}

// ---------- console helpers ----------
const stamp = () => new Date().toLocaleTimeString();
const line = () => console.log('  ' + '─'.repeat(58));

let relay = null;
let statusTimer = null;
let lastStatus = '';
let rl = null;

function describe(stats) {
  const busy = stats.counts.map((n, i) => (n ? `CH${i + 1}: ${n}` : '')).filter(Boolean).join(', ');
  return `${stats.people} connected${busy ? ` · ${busy}` : ''}`;
}

async function goLive(s) {
  if (relay) { clearInterval(statusTimer); await relay.close(); relay = null; }
  try {
    relay = await startServer(s.port, s.ip);
  } catch (err) {
    console.log(`\n  ✖ Could not go on the air: ${explain(err, s)}`);
    return false;
  }
  console.log('');
  line();
  console.log(`  ON THE AIR  ·  listening on ${s.ip}, port ${relay.port}`);
  line();
  console.log('  In the radio\'s SETUP, people enter one of these:');
  for (const a of connectAddresses(s)) console.log(`     ${a}`);
  console.log('  From the internet, use your public IP or domain with the same port');
  console.log('  (forward that port on your router if this machine is behind one).');
  line();
  startStatus();
  return true;
}
// Prints a line whenever the number of people (or where they are) changes.
function startStatus() {
  clearInterval(statusTimer);
  lastStatus = '';
  statusTimer = setInterval(() => {
    if (!relay) return;
    const now = describe(relay.stats());
    if (now !== lastStatus) { console.log(`  [${stamp()}] ${now}`); lastStatus = now; }
  }, 1000);
}

function ask(q) { return new Promise((res) => rl.question(q, (a) => res(a.trim()))); }

async function changeSettings(s) {
  console.log('\n  CHANGE SETTINGS  (press Enter to keep the current value)');
  for (;;) {
    const a = await ask(`  Port [${s.port}]: `);
    if (!a) break;
    const p = checkPort(a);
    if (p) { s.port = p; break; }
    console.log('  That isn\'t a port. Use a whole number from 1 to 65535.');
  }
  const choices = [
    { address: '0.0.0.0', label: 'every network on this machine (usual choice)' },
    { address: '127.0.0.1', label: 'this machine only (for testing)' },
    ...localAddresses().map((a) => ({ address: a.address, label: `only via "${a.name}"` })),
  ];
  console.log('  IP address to listen on:');
  choices.forEach((c, i) => console.log(`     ${i + 1}) ${c.address.padEnd(16)} ${c.label}${c.address === s.ip ? '   ← current' : ''}`));
  for (;;) {
    const a = await ask(`  Pick 1-${choices.length}, or type an address [${s.ip}]: `);
    if (!a) break;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) { s.ip = choices[n - 1].address; break; }
    const ip = checkIp(a);
    if (ip) { s.ip = ip; break; }
    console.log('  That isn\'t an IP address.');
  }
  saveSettings(s);
  return s;
}

function showHelp() {
  console.log('\n  Type a letter and press Enter:  s = change port/IP   r = restart   i = show addresses   q = quit');
}

async function main() {
  process.title = APP;
  let args;
  try {
    args = parseArgs({
      options: {
        port: { type: 'string', short: 'p' },
        ip: { type: 'string' },
        host: { type: 'string' },
        save: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    }).values;
  } catch (err) {
    console.log(`  ${err.message}`);
    usage();
    process.exit(2);
  }
  if (args.help) { usage(); return; }

  console.log(`\n  ${APP}`);
  const s = loadSettings();
  console.log(`  Settings: ${settingsFile}`);

  const fromEnvPort = process.env.PORT && checkPort(process.env.PORT);
  const fromEnvIp = process.env.HOST && checkIp(process.env.HOST);
  if (fromEnvPort) s.port = fromEnvPort;
  if (fromEnvIp) s.ip = fromEnvIp;
  const flagIp = args.ip ?? args.host;
  if (args.port !== undefined) {
    const p = checkPort(args.port);
    if (!p) { console.log(`  ✖ --port ${args.port} isn't a port (1-65535).`); process.exit(2); }
    s.port = p;
  }
  if (flagIp !== undefined) {
    const ip = checkIp(flagIp);
    if (!ip) { console.log(`  ✖ --ip ${flagIp} isn't an IP address.`); process.exit(2); }
    s.ip = ip;
  }
  if (args.save) saveSettings(s);

  // BREAKER_CONSOLE=1 forces the typed menu even when input is piped (used by the tests)
  const interactive = process.env.BREAKER_CONSOLE === '1' || !!(process.stdin.isTTY && process.stdout.isTTY);
  let ok = await goLive(s);

  if (!interactive) {
    if (!ok) process.exit(1);
    const quit = async () => { if (relay) await relay.close(); process.exit(0); };
    process.on('SIGINT', quit);
    process.on('SIGTERM', quit);
    return;
  }

  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const quit = async () => {
    console.log('\n  Off the air. 73!');
    clearInterval(statusTimer);
    if (relay) await relay.close();
    process.exit(0);
  };
  rl.on('SIGINT', quit);

  while (!ok) {
    console.log('  Let\'s fix the settings.');
    await changeSettings(s);
    ok = await goLive(s);
  }
  showHelp();

  let busy = false;
  rl.on('line', async (input) => {
    if (busy) return;
    const cmd = input.trim().toLowerCase();
    busy = true;
    try {
      if (cmd === 's') {
        clearInterval(statusTimer);
        const before = { ...s };
        await changeSettings(s);
        if (before.port !== s.port || before.ip !== s.ip || !relay) {
          let live = await goLive(s);
          while (!live) { await changeSettings(s); live = await goLive(s); }
        } else {
          console.log('  No change. Still on the air.');
          startStatus();
        }
        showHelp();
      } else if (cmd === 'r') {
        await goLive(s);
        showHelp();
      } else if (cmd === 'i') {
        for (const a of connectAddresses(s)) console.log(`     ${a}`);
        if (relay) console.log(`  ${describe(relay.stats())}`);
      } else if (cmd === 'q') {
        await quit();
      } else if (cmd) {
        showHelp();
      }
    } finally {
      busy = false;
    }
  });
}

module.exports = { main };
if (require.main === module) main();
