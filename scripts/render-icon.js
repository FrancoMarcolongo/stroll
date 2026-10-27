// Renders assets/icon.svg to assets/icon.png (1024x1024, transparent) with Electron's own
// renderer, so no image tooling is needed. Run: node_modules/.bin/electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'icon.svg');
const OUT = path.join(__dirname, '..', 'assets', 'icon.png');

app.dock?.hide();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(SRC, 'utf8');
  const win = new BrowserWindow({
    width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(OUT, img.resize({ width: 1024, height: 1024 }).toPNG());
  console.log(`wrote ${OUT}`);
  app.quit();
});
