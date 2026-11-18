// Installs what building the Android app needs into ~/.stroll-android, and nowhere else: a
// JDK 17 and the Android SDK command-line tools (which then fetch the rest of the SDK). No
// admin rights, nothing system-wide. Run once: node android/setup-tools.mjs
//
// It accepts the Android SDK licence, which Google requires of whoever builds with the SDK:
// run it only if you do. https://developer.android.com/studio/terms
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const home = path.join(os.homedir(), '.stroll-android');
const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
const system = { darwin: 'mac', linux: 'linux' }[process.platform];
if (!system) throw new Error('This script knows macOS and Linux.');
fs.mkdirSync(home, { recursive: true });

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
  return fs.statSync(file).size;
}

// --- JDK 17 (Eclipse Temurin) ---
const jdkRoot = path.join(home, 'jdk');
const jdkDir = () => fs.existsSync(jdkRoot) && fs.readdirSync(jdkRoot).find(d => d.startsWith('jdk-'));
if (!jdkDir()) {
  const file = path.join(home, 'jdk.tar.gz');
  console.log('Downloading JDK 17…');
  const size = await download(`https://api.adoptium.net/v3/binary/latest/17/ga/${system}/${arch}/jdk/hotspot/normal/eclipse`, file);
  console.log(`  ${(size / 1e6).toFixed(0)} MB`);
  fs.mkdirSync(jdkRoot, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', jdkRoot]);
  fs.rmSync(file);
}
const jdk = path.join(jdkRoot, jdkDir());
const javaHome = system === 'mac' ? path.join(jdk, 'Contents', 'Home') : jdk;
console.log(`JDK: ${execFileSync(path.join(javaHome, 'bin', 'java'), ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || 'ok'} at ${jdk}`);

// --- Android SDK command-line tools ---
const sdk = path.join(home, 'sdk');
const tools = path.join(sdk, 'cmdline-tools', 'latest');
if (!fs.existsSync(path.join(tools, 'bin', 'sdkmanager'))) {
  // The download's name carries a build number. The SDK's own package index, the one
  // sdkmanager reads, says which is the latest for this system.
  const index = await (await fetch('https://dl.google.com/android/repository/repository2-3.xml')).text();
  const pkg = index.match(/<remotePackage path="cmdline-tools;latest">[\s\S]*?<\/remotePackage>/)?.[0] || '';
  const archive = [...pkg.matchAll(/<archive>[\s\S]*?<\/archive>/g)].map(m => m[0]).find(a => a.includes(`<host-os>${system === 'mac' ? 'macosx' : 'linux'}</host-os>`)) || '';
  const name = archive.match(/<url>\s*([^<\s]+\.zip)\s*<\/url>/)?.[1];
  if (!name) throw new Error('Could not find the command-line tools in the Android SDK package index');
  const file = path.join(home, name);
  console.log(`Downloading ${name}…`);
  const size = await download(`https://dl.google.com/android/repository/${name}`, file);
  console.log(`  ${(size / 1e6).toFixed(0)} MB`);
  const tmp = path.join(home, 'unzip');
  fs.rmSync(tmp, { recursive: true, force: true });
  execFileSync('unzip', ['-q', file, '-d', tmp]);
  fs.mkdirSync(path.dirname(tools), { recursive: true });
  fs.renameSync(path.join(tmp, 'cmdline-tools'), tools);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(file);
}
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
const sdkmanager = path.join(tools, 'bin', 'sdkmanager');
console.log('Accepting the SDK licences and installing platform-tools…');
execFileSync('sh', ['-c', `yes | "${sdkmanager}" --sdk_root="${sdk}" --licenses > /dev/null`], { env, stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync(sdkmanager, [`--sdk_root=${sdk}`, 'platform-tools'], { env, stdio: ['ignore', 'ignore', 'inherit'] });

fs.writeFileSync(path.join(home, 'env.sh'), `# Source this to use the tools: . ~/.stroll-android/env.sh\nexport JAVA_HOME="${javaHome}"\nexport ANDROID_HOME="${sdk}"\nexport ANDROID_SDK_ROOT="${sdk}"\nexport PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"\n`);
fs.writeFileSync(path.join(home, 'paths.json'), JSON.stringify({ jdk, javaHome, sdk }, null, 2));
console.log(`Done. JDK and SDK are in ${home} (${execFileSync('du', ['-sh', home], { encoding: 'utf8' }).split('\t')[0].trim()}).`);
