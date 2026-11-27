// electron-builder afterPack hook (Linux only).
//
// An AppImage can't set up Chromium's sandbox helper (it must be owned by root with the setuid bit, and
// an AppImage is mounted read-only as the user). Ubuntu 24.04+ also blocks the fallback sandbox, so the
// app would abort on start. The switch has to be on the command line, because Chromium checks the
// sandbox before main.js runs, so the real binary becomes breaker40-cb.bin and breaker40-cb becomes a
// small launcher that adds --no-sandbox only when running from an AppImage. The .deb installs the
// helper correctly, so it keeps the sandbox.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;
  const name = context.packager.executableName;
  const exe = path.join(context.appOutDir, name);
  const bin = `${exe}.bin`;
  fs.renameSync(exe, bin);
  fs.writeFileSync(exe, `#!/bin/sh
# Launcher for Breaker 40 CB. See build/after-pack.js for why this exists.
HERE="$(dirname "$(readlink -f "$0")")"
if [ -n "$APPIMAGE" ]; then
  exec "$HERE/${name}.bin" --no-sandbox "$@"
fi
exec "$HERE/${name}.bin" "$@"
`, { mode: 0o755 });
  console.log(`  • launcher       ${name} -> ${name}.bin (--no-sandbox inside an AppImage)`);
};
