#!/bin/bash
# Runs after the .deb is installed (replaces electron-builder's default script).
#
# electron-builder's default only makes chrome-sandbox setuid when `unshare --user` fails. During
# install that test runs as root and passes, but Ubuntu 24.04+ blocks user namespaces for normal
# users, so the app then finds no usable sandbox and aborts. Like Google Chrome's .deb, always make
# the helper setuid root.

# No spaces: with the sandbox on, Chromium splits its own path at spaces when it starts its helpers.
# `npm run dist:linux` builds with productName Breaker40CB for that reason.
APP_DIR='/opt/Breaker40CB'
EXE='breaker40-cb'

# /usr/bin/breaker40-cb
if type update-alternatives >/dev/null 2>&1; then
  if [ -L "/usr/bin/$EXE" ] && [ -e "/usr/bin/$EXE" ] && [ "$(readlink "/usr/bin/$EXE")" != "/etc/alternatives/$EXE" ]; then
    rm -f "/usr/bin/$EXE"
  fi
  update-alternatives --install "/usr/bin/$EXE" "$EXE" "$APP_DIR/$EXE" 100 || ln -sf "$APP_DIR/$EXE" "/usr/bin/$EXE"
else
  ln -sf "$APP_DIR/$EXE" "/usr/bin/$EXE"
fi

chown root:root "$APP_DIR/chrome-sandbox" || true
chmod 4755 "$APP_DIR/chrome-sandbox" || true

if hash update-mime-database 2>/dev/null; then update-mime-database /usr/share/mime || true; fi
if hash update-desktop-database 2>/dev/null; then update-desktop-database /usr/share/applications || true; fi
