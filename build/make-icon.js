// Renders build/icon.png (512x512) with Electron.  Run:  npx electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const html = `<html><body style="margin:0;background:transparent">
<div style="width:512px;height:512px;border-radius:96px;background:linear-gradient(#2c2f35,#101114);
 box-shadow:inset 0 6px 0 rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">
 <div style="position:absolute;top:0;left:0;right:0;height:96px;background:linear-gradient(#f4f5f7,#a9adb3 55%,#5b5f66)"></div>
 <div style="position:absolute;top:18px;width:100%;text-align:center;font:italic 900 52px 'Arial Black';color:#23252a">CB</div>
 <div style="margin-top:80px;width:380px;height:250px;border-radius:30px;background:#120403;box-shadow:inset 0 4px 12px #000;
  display:flex;align-items:center;justify-content:center;font:900 210px Consolas,monospace;color:#ff3b22;
  text-shadow:0 0 24px rgba(255,59,34,.9);letter-spacing:-6px;font-style:italic">40</div>
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true });
  await win.loadURL('data:text/html,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  // 256 px copy: Windows .ico files top out at 256 (used for the base station exe)
  fs.writeFileSync(path.join(__dirname, 'icon-256.png'), img.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  app.quit();
});
