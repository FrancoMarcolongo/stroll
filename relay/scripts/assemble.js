// Gathers what the relay serves as the phone app into relay/public: the client (mobile/), the
// encrypted channel it shares with the desktop app, and the icon. Run before dev and deploy.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = path.join(root, 'relay', 'public');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'mobile'), out, { recursive: true }); // with .well-known, which tells Android the app is ours
fs.copyFileSync(path.join(root, 'src', 'shared', 'channel.js'), path.join(out, 'channel.js'));
fs.copyFileSync(path.join(root, 'assets', 'icon.png'), path.join(out, 'icon.png'));
// The terminal a session is shown in, the same library the desktop window uses.
fs.mkdirSync(path.join(out, 'vendor'));
for (const file of ['@xterm/xterm/lib/xterm.js', '@xterm/xterm/css/xterm.css', '@xterm/addon-fit/lib/addon-fit.js', '@xterm/addon-unicode11/lib/addon-unicode11.js']) {
  fs.copyFileSync(path.join(root, 'node_modules', file), path.join(out, 'vendor', path.basename(file)));
}
// The Android app, when one has been built (android/build.mjs): the newest, at one address.
const apks = fs.existsSync(path.join(root, 'android', 'dist')) ? fs.readdirSync(path.join(root, 'android', 'dist')).filter(f => f.endsWith('.apk')).sort() : [];
if (apks.length) fs.copyFileSync(path.join(root, 'android', 'dist', apks[apks.length - 1]), path.join(out, 'stroll.apk'));
console.log(`phone app assembled in relay/public: ${fs.readdirSync(out).join(', ')}${apks.length ? ` (stroll.apk is ${apks[apks.length - 1]})` : ''}`);
