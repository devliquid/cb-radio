// Builds dist/Breaker40-BaseStation.exe: the relay as one Windows exe that needs no Node install.
//   npm run dist:relay
//
// 1. esbuild bundles server/relay.js and its `ws` dependency into one script.
// 2. Node's single-executable feature (`node --build-sea`) wraps it in a copy of node.exe.
// 3. rcedit (from electron-builder's cache, if present) adds the icon and file details.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'out');
const dist = path.join(root, 'dist');
const exe = path.join(dist, 'Breaker40-BaseStation.exe');
const version = require('../package.json').version;

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. bundle
const bundle = path.join(out, 'relay-bundle.js');
esbuild.buildSync({
  // bundled modules never see `require.main === module`, so start main() explicitly
  stdin: {
    contents: "require('./relay.js').main();",
    resolveDir: path.join(root, 'server'),
    sourcefile: 'basestation-entry.js',
    loader: 'js',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // optional speed-ups that ws tries to load and happily lives without
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'warning',
});
console.log('bundled   ', path.relative(root, bundle));

// 2. single executable
const seaConfig = path.join(out, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundle,
  output: exe,
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
}, null, 2));
try { fs.unlinkSync(exe); } catch {}
execFileSync(process.execPath, ['--build-sea', seaConfig], { stdio: 'inherit' });
console.log('built     ', path.relative(root, exe));

// 3. icon + details
function findRcedit() {
  const cache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'winCodeSign');
  try {
    for (const d of fs.readdirSync(cache)) {
      const p = path.join(cache, d, 'rcedit-x64.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}
function writeIco(png, file) {
  // one 256x256 PNG-compressed image (supported since Windows Vista)
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(0, 6); head.writeUInt8(0, 7);       // 0 = 256 px
  head.writeUInt8(0, 8); head.writeUInt8(0, 9);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
  fs.writeFileSync(file, Buffer.concat([head, png]));
}
const rcedit = findRcedit();
const iconPng = path.join(__dirname, 'icon-256.png');
if (rcedit && fs.existsSync(iconPng)) {
  const ico = path.join(out, 'basestation.ico');
  writeIco(fs.readFileSync(iconPng), ico);
  execFileSync(rcedit, [exe,
    '--set-icon', ico,
    '--set-version-string', 'FileDescription', 'Breaker 40 Base Station',
    '--set-version-string', 'ProductName', 'Breaker 40 CB',
    '--set-version-string', 'OriginalFilename', 'Breaker40-BaseStation.exe',
    '--set-version-string', 'InternalName', 'Breaker40-BaseStation',
    '--set-version-string', 'CompanyName', '',
    '--set-version-string', 'LegalCopyright', '',
    '--set-file-version', version,
    '--set-product-version', version,
  ]);
  console.log('icon      ', 'added');
} else {
  console.log('icon      ', 'skipped (run `npm run dist` once so electron-builder fetches rcedit)');
}
console.log(`size       ${(fs.statSync(exe).size / 1048576).toFixed(1)} MB`);
