// After `npm install`: build node-pty against Electron's Node, then make its spawn helper
// executable. node-pty's prebuilt copies ship without the exec bit, and every session would
// fail to start with "posix_spawnp failed".
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
execSync('npx --no-install electron-rebuild -f -w node-pty', { cwd: root, stdio: 'inherit' });
for (const dir of ['build/Release', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
  const helper = path.join(root, 'node_modules', 'node-pty', dir, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
