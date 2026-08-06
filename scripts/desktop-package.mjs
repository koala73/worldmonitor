#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

const getArg = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasFlag = (name) => args.includes(`--${name}`);

const os = getArg('os');
const sign = hasFlag('sign');
const skipNodeRuntime = hasFlag('skip-node-runtime');
const showHelp = hasFlag('help') || hasFlag('h');

const validOs = new Set(['macos', 'windows', 'linux']);
const USAGE = 'Usage: npm run desktop:package -- --os <macos|windows|linux> [--sign] [--skip-node-runtime]';

if (showHelp) {
  console.log(USAGE);
  console.log('');
  console.log('Packages the single World Monitor desktop binary. Variants (tech,');
  console.log('finance, commodity, energy, happy) are selected in-app after install —');
  console.log('there is no per-variant package (#5908).');
  process.exit(0);
}

if (!validOs.has(os)) {
  console.error(USAGE);
  process.exit(1);
}

// #5908: a stale `--variant tech` invocation must fail loudly rather than
// silently produce an unbranded full build the caller did not ask for.
// `hasFlag`, not `getArg`: a trailing bare `--variant` must not slip through.
if (hasFlag('variant')) {
  console.error(
    'The --variant flag was removed: one desktop binary ships and variants are selected in-app (#5908).'
  );
  process.exit(1);
}

const syncVersionsResult = spawnSync(process.execPath, ['scripts/sync-desktop-version.mjs'], {
  stdio: 'inherit'
});
if (syncVersionsResult.error) {
  console.error(syncVersionsResult.error.message);
  process.exit(1);
}
if ((syncVersionsResult.status ?? 1) !== 0) {
  process.exit(syncVersionsResult.status ?? 1);
}

const bundles = os === 'macos' ? 'app,dmg' : os === 'linux' ? 'appimage' : 'nsis,msi';
const env = {
  ...process.env,
  VITE_VARIANT: 'full',
  VITE_DESKTOP_RUNTIME: '1',
};
const cliArgs = ['build', '--bundles', bundles];
const tauriBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');

if (!existsSync(tauriBin)) {
  console.error(
    `Local Tauri CLI not found at ${tauriBin}. Run "npm ci" to install dependencies before desktop packaging.`
  );
  process.exit(1);
}

const resolveNodeTarget = () => {
  if (env.NODE_TARGET) return env.NODE_TARGET;
  if (os === 'windows') return 'x86_64-pc-windows-msvc';
  if (os === 'linux') {
    if (process.arch === 'arm64') return 'aarch64-unknown-linux-gnu';
    if (process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
    return '';
  }
  if (os === 'macos') {
    if (process.arch === 'arm64') return 'aarch64-apple-darwin';
    if (process.arch === 'x64') return 'x86_64-apple-darwin';
  }
  return '';
};

if (sign) {
  if (os === 'macos') {
    const hasIdentity = Boolean(env.TAURI_BUNDLE_MACOS_SIGNING_IDENTITY || env.APPLE_SIGNING_IDENTITY);
    const hasProvider = Boolean(env.TAURI_BUNDLE_MACOS_PROVIDER_SHORT_NAME);
    if (!hasIdentity || !hasProvider) {
      console.error(
        'Signing requested (--sign) but missing macOS signing env vars. Set TAURI_BUNDLE_MACOS_SIGNING_IDENTITY (or APPLE_SIGNING_IDENTITY) and TAURI_BUNDLE_MACOS_PROVIDER_SHORT_NAME.'
      );
      process.exit(1);
    }
  }

  if (os === 'windows') {
    const hasThumbprint = Boolean(env.TAURI_BUNDLE_WINDOWS_CERTIFICATE_THUMBPRINT);
    const hasPfx = Boolean(env.TAURI_BUNDLE_WINDOWS_CERTIFICATE && env.TAURI_BUNDLE_WINDOWS_CERTIFICATE_PASSWORD);
    if (!hasThumbprint && !hasPfx) {
      console.error(
        'Signing requested (--sign) but missing Windows signing env vars. Set TAURI_BUNDLE_WINDOWS_CERTIFICATE_THUMBPRINT or TAURI_BUNDLE_WINDOWS_CERTIFICATE + TAURI_BUNDLE_WINDOWS_CERTIFICATE_PASSWORD.'
      );
      process.exit(1);
    }
  }
}

if (!skipNodeRuntime) {
  const nodeTarget = resolveNodeTarget();
  if (!nodeTarget) {
    console.error(
      `Unable to infer Node runtime target for OS=${os} ARCH=${process.arch}. Set NODE_TARGET explicitly or pass --skip-node-runtime.`
    );
    process.exit(1);
  }
  console.log(
    `[desktop-package] Bundling Node runtime TARGET=${nodeTarget} VERSION=${env.NODE_VERSION ?? '22.14.0'}`
  );
  const downloadResult = spawnSync('bash', ['scripts/download-node.sh', '--target', nodeTarget], {
    env: {
      ...env,
      NODE_TARGET: nodeTarget
    },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (downloadResult.error) {
    console.error(downloadResult.error.message);
    process.exit(1);
  }
  if ((downloadResult.status ?? 1) !== 0) {
    process.exit(downloadResult.status ?? 1);
  }
}

console.log(`[desktop-package] OS=${os} BUNDLES=${bundles} SIGN=${sign ? 'on' : 'off'}`);

const result = spawnSync(tauriBin, cliArgs, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
