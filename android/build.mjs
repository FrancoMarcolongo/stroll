// Builds the Android app: a thin, signed shell (a Trusted Web Activity) that opens Stroll's
// phone app full screen. The app itself is the web client the relay serves, so the shell
// rarely changes: a new phone client reaches every phone without a new APK.
//
//   node android/setup-tools.mjs   once: the JDK and Android SDK, in ~/.stroll-android
//   node android/build.mjs         android/dist/stroll-<version>.apk
//
// The signing key is made on the first build and kept in ~/.stroll-android, outside the repo,
// with its password. Android accepts an update only if it's signed with the same key: back
// both files up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import core from '@bubblewrap/core';

const { Config, JdkHelper, AndroidSdkTools, KeyTool, TwaManifest, TwaGenerator, GradleWrapper, DigitalAssetLinks, ConsoleLog } = core;

// What the app is. `host` is where the phone app is served (the relay).
const APP = {
  packageId: 'io.github.francomarcolongo.stroll',
  host: 'stroll-relay.francomarcolongo98.workers.dev',
  name: 'Stroll',
  version: '0.1.0',
  versionCode: 1,
  color: '#0e1116',
};

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.join(os.homedir(), '.stroll-android');
const project = path.join(here, 'app'); // generated, not kept in git
const dist = path.join(here, 'dist');
const log = new ConsoleLog('android');

if (!fs.existsSync(path.join(tools, 'paths.json'))) throw new Error('Run `node android/setup-tools.mjs` first.');
const { jdk, sdk } = JSON.parse(fs.readFileSync(path.join(tools, 'paths.json'), 'utf8'));
// The generator looks for the SDK's tools where older SDKs kept them.
if (!fs.existsSync(path.join(sdk, 'tools'))) fs.symlinkSync(path.join('cmdline-tools', 'latest'), path.join(sdk, 'tools'));
const config = new Config(jdk, sdk);
const jdkHelper = new JdkHelper(process, config);
const androidSdk = await AndroidSdkTools.create(process, config, jdkHelper, log);
if (!(await androidSdk.checkBuildTools())) await androidSdk.installBuildTools();

// --- the signing key ---
const keystore = path.join(tools, 'stroll-release.keystore');
const passwordFile = path.join(tools, 'stroll-release.password');
const alias = 'stroll';
if (!fs.existsSync(passwordFile)) fs.writeFileSync(passwordFile, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 });
const password = fs.readFileSync(passwordFile, 'utf8').trim();
const key = { path: keystore, alias, keypassword: password, password };
const keyTool = new KeyTool(jdkHelper, log);
if (!fs.existsSync(keystore)) {
  await keyTool.createSigningKey({ ...key, fullName: APP.name, organizationalUnit: APP.name, organization: APP.name, country: 'ZZ' });
  fs.chmodSync(keystore, 0o600);
  console.log(`\nNew signing key: ${keystore}\nIts password:    ${passwordFile}\nBack both up: updates must be signed with this key.\n`);
}

// --- the project ---
const site = `https://${APP.host}`;
const manifest = new TwaManifest({
  packageId: APP.packageId,
  host: APP.host,
  name: APP.name,
  launcherName: APP.name,
  display: 'standalone',
  themeColor: APP.color,
  themeColorDark: APP.color,
  navigationColor: APP.color,
  navigationColorDark: APP.color,
  backgroundColor: APP.color,
  enableNotifications: true,
  startUrl: '/',
  iconUrl: `${site}/icon.png`,
  splashScreenFadeOutDuration: 300,
  signingKey: { path: keystore, alias },
  appVersionCode: APP.versionCode,
  appVersion: APP.version,
  shortcuts: [],
  generatorApp: 'stroll',
  webManifestUrl: `${site}/manifest.webmanifest`,
  fallbackType: 'customtabs',
  enableSiteSettingsShortcut: true,
  orientation: 'default',
  minSdkVersion: 24, // Android 7: the lowest the browser-helper library the shell is built on accepts
});
const problem = manifest.validate();
if (problem) throw new Error(`The app's description isn't valid: ${problem}`);
fs.rmSync(project, { recursive: true, force: true });
fs.mkdirSync(project, { recursive: true });
await new TwaGenerator().createTwaProject(project, manifest, log);

// --- build, align, sign ---
await new GradleWrapper(process, androidSdk, project).assembleRelease();
const unsigned = path.join(project, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const aligned = path.join(project, 'app-release-aligned.apk');
const apk = path.join(dist, `stroll-${APP.version}.apk`);
fs.mkdirSync(dist, { recursive: true });
fs.rmSync(aligned, { force: true });
fs.rmSync(apk, { force: true });
await androidSdk.zipalign(unsigned, aligned);
await androidSdk.apksigner(keystore, password, alias, password, aligned, apk);

// --- the site's word that this app may show it without a browser bar ---
// Android checks https://<host>/.well-known/assetlinks.json for the key the app is signed
// with. The relay serves it from mobile/.well-known; deploy the relay after the first build.
const sha256 = (await keyTool.keyInfo(key)).fingerprints.get('SHA256');
const links = path.join(here, '..', 'mobile', '.well-known', 'assetlinks.json');
fs.mkdirSync(path.dirname(links), { recursive: true });
const wanted = `${DigitalAssetLinks.generateAssetLinks(APP.packageId, sha256)}\n`;
const changed = !fs.existsSync(links) || fs.readFileSync(links, 'utf8') !== wanted;
if (changed) fs.writeFileSync(links, wanted);
console.log(`\n${apk} (${(fs.statSync(apk).size / 1e6).toFixed(1)} MB)\nsigned with ${sha256}`);
if (changed) console.log('mobile/.well-known/assetlinks.json changed: deploy the relay (cd relay && npm run deploy).');
