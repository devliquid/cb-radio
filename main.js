const { app, BrowserWindow, ipcMain, session, shell } = require('electron');
const path = require('path');
const os = require('os');
const { startServer } = require('./server/server');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Linux AppImage: --no-sandbox is added by the launcher script from build/after-pack.js.
if (process.env.CB_FAKE_MIC) app.commandLine.appendSwitch('use-fake-device-for-media-stream');

let win = null;
let hosted = null;

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 660,
    minWidth: 820,
    minHeight: 460,
    backgroundColor: '#17110c',
    title: 'Breaker 40 CB',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Used to check the look: CB_SCREENSHOT=out.png electron .
  if (process.env.CB_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const quitTimer = setTimeout(() => { console.log('EVAL: timed out'); app.exit(1); }, 45_000);
        try {
          await win.webContents.executeJavaScript("document.getElementById('setup').hidden = true; initAudio()");
          if (process.env.CB_EVAL) {
            const r = await win.webContents.executeJavaScript(process.env.CB_EVAL);
            if (r !== undefined) console.log('EVAL:', JSON.stringify(r));
            await new Promise((r) => setTimeout(r, 1500));
          }
          await new Promise((r) => setTimeout(r, 300));
          const img = await win.webContents.capturePage();
          require('fs').writeFileSync(process.env.CB_SCREENSHOT, img.toPNG());
        } catch (err) {
          console.log('EVAL error:', err && err.message);
        }
        clearTimeout(quitTimer);
        app.quit();
      }, Number(process.env.CB_SCREENSHOT_DELAY) || 1500);
    });
  }
}

// ---------- updates (from the GitHub releases) ----------
// The installed Windows app and the Linux AppImage update themselves. The portable exe and the .deb
// can't replace themselves, so for those the app opens the release page instead.
const RELEASES = 'https://github.com/devliquid/cb-radio/releases/latest';
let updater = null;
function getUpdater() {
  if (updater) return updater;
  updater = require('electron-updater').autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // Lets the tests point the app at a local update server.
  if (process.env.CB_UPDATE_URL) updater.setFeedURL({ provider: 'generic', url: process.env.CB_UPDATE_URL });
  updater.on('download-progress', (p) => win && win.webContents.send('update:progress', Math.round(p.percent)));
  return updater;
}
function canSelfUpdate() {
  if (!app.isPackaged) return false;
  if (process.platform === 'win32') return !process.env.PORTABLE_EXECUTABLE_DIR;
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return false;
}
const firstLine = (err) => String((err && err.message) || err).split('\n')[0];

app.whenReady().then(() => {
  const allowed = new Set(['media', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.has(perm));

  ipcMain.handle('host:start', async (_e, port) => {
    port = Number(port) || 7140;
    if (hosted) { await hosted.close(); hosted = null; }
    try {
      hosted = await startServer(port);
      return { ok: true, port: hosted.port, ips: lanAddresses() };
    } catch (err) {
      hosted = null;
      return { ok: false, error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use` : err.message };
    }
  });
  ipcMain.handle('host:stop', async () => {
    if (hosted) { await hosted.close(); hosted = null; }
    return { ok: true };
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('update:check', async () => {
    const current = app.getVersion();
    if (!app.isPackaged && !process.env.CB_UPDATE_URL) {
      return { ok: false, current, error: 'Updates only work in the installed app, not in a dev build.' };
    }
    try {
      const r = await getUpdater().checkForUpdates();
      const latest = r && r.updateInfo ? r.updateInfo.version : current;
      return { ok: true, current, latest, available: !!(r && r.isUpdateAvailable), auto: canSelfUpdate() };
    } catch (err) {
      return { ok: false, current, error: firstLine(err) };
    }
  });
  // Downloads the update while the app keeps running, then closes the app,
  // installs it silently and starts the new version.
  ipcMain.handle('update:install', async () => {
    if (!canSelfUpdate()) { shell.openExternal(RELEASES); return { ok: true, opened: true }; }
    try {
      await getUpdater().downloadUpdate();
      if (hosted) { await hosted.close(); hosted = null; }
      setTimeout(() => getUpdater().quitAndInstall(true, true), 800);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: firstLine(err) };
    }
  });

  createWindow();
});

app.on('window-all-closed', () => app.quit());
