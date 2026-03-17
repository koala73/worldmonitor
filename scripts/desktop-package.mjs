#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);

const getArg = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasFlag = (name) => args.includes(`--${name}`);

const targetOs = getArg('os');
const variant = getArg('variant') ?? 'full';
const sign = hasFlag('sign');
const skipNodeRuntime = hasFlag('skip-node-runtime');
const showHelp = hasFlag('help') || hasFlag('h');
const variantProductName = {
  full: 'World Monitor',
  tech: 'Tech Monitor',
  finance: 'Finance Monitor',
}[variant];

const validOs = new Set(['macos', 'windows', 'linux']);
const validVariants = new Set(['full', 'tech', 'finance']);

if (showHelp) {
  console.log('Usage: npm run desktop:package -- --os <macos|windows|linux> --variant <full|tech|finance> [--sign] [--skip-node-runtime]');
  process.exit(0);
}

if (!validOs.has(targetOs)) {
  console.error('Usage: npm run desktop:package -- --os <macos|windows|linux> --variant <full|tech|finance> [--sign] [--skip-node-runtime]');
  process.exit(1);
}

if (!validVariants.has(variant)) {
  console.error('Invalid variant. Use --variant full, tech, or finance.');
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

const bundles = targetOs === 'macos' ? sign ? 'app,dmg' : 'app' : targetOs === 'linux' ? 'appimage' : 'nsis,msi';
const env = {
  ...process.env,
  VITE_VARIANT: variant,
  VITE_DESKTOP_RUNTIME: '1',
};
const cliArgs = ['build', '--bundles', bundles];
const tauriBin = path.join('node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');

if (!existsSync(tauriBin)) {
  console.error(
    `Local Tauri CLI not found at ${tauriBin}. Run \"npm ci\" to install dependencies before desktop packaging.`
  );
  process.exit(1);
}

if (variant === 'tech') {
  cliArgs.push('--config', 'src-tauri/tauri.tech.conf.json');
} else if (variant === 'finance') {
  cliArgs.push('--config', 'src-tauri/tauri.finance.conf.json');
}

const resolveNodeTarget = () => {
  if (env.NODE_TARGET) return env.NODE_TARGET;
  if (targetOs === 'windows') return 'x86_64-pc-windows-msvc';
  if (targetOs === 'linux') return 'x86_64-unknown-linux-gnu';
  if (targetOs === 'macos') {
    if (process.arch === 'arm64') return 'aarch64-apple-darwin';
    if (process.arch === 'x64') return 'x86_64-apple-darwin';
  }
  return '';
};

if (sign) {
  if (targetOs === 'macos') {
    const hasIdentity = Boolean(env.TAURI_BUNDLE_MACOS_SIGNING_IDENTITY || env.APPLE_SIGNING_IDENTITY);
    const hasProvider = Boolean(env.TAURI_BUNDLE_MACOS_PROVIDER_SHORT_NAME);
    if (!hasIdentity || !hasProvider) {
      console.error(
        'Signing requested (--sign) but missing macOS signing env vars. Set TAURI_BUNDLE_MACOS_SIGNING_IDENTITY (or APPLE_SIGNING_IDENTITY) and TAURI_BUNDLE_MACOS_PROVIDER_SHORT_NAME.'
      );
      process.exit(1);
    }
  }

  if (targetOs === 'windows') {
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
      `Unable to infer Node runtime target for OS=${targetOs} ARCH=${process.arch}. Set NODE_TARGET explicitly or pass --skip-node-runtime.`
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

console.log(`[desktop-package] OS=${targetOs} VARIANT=${variant} BUNDLES=${bundles} SIGN=${sign ? 'on' : 'off'}`);

const result = spawnSync(tauriBin, cliArgs, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

const run = (command, args, options = {}) => {
  const child = spawnSync(command, args, {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (child.error) {
    throw child.error;
  }
  if ((child.status ?? 1) !== 0) {
    throw new Error(`${command} exited with status ${child.status ?? 1}`);
  }
};

const runCapture = (command, args, options = {}) =>
  spawnSync(command, args, {
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...options,
  });

const verifyMacCodeSignature = (artifactPath, label, args = ['--verify', '--deep', '--strict']) => {
  const result = runCapture('codesign', [...args, artifactPath]);
  if ((result.status ?? 1) !== 0) {
    const error = new Error(
      (result.stderr || result.stdout || '').trim() || `${label} codesign verification failed`
    );
    error.result = result;
    throw error;
  }
};

if (targetOs === 'macos') {
  const bundleRoot = path.join('src-tauri', 'target', 'release', 'bundle');
  const appDir = path.join(bundleRoot, 'macos');
  const dmgDir = path.join(bundleRoot, 'dmg');
  const appName = `${variantProductName}.app`;
  const appPath = path.join(appDir, appName);
  if (!existsSync(appPath)) {
    const discoveredApps = readdirSync(appDir).filter((entry) => entry.endsWith('.app'));
    console.error(
      `[desktop-package] Expected ${appName} in ${appDir}, found: ${discoveredApps.join(', ') || '(none)'}`
    );
    process.exit(1);
  }

  const bundleVersion = env.npm_package_version;
  const archSuffix = process.arch === 'arm64' ? 'aarch64' : process.arch;
  const dmgPath = path.join(dmgDir, `${variantProductName}_${bundleVersion}_${archSuffix}.dmg`);

  try {
    verifyMacCodeSignature(appPath, 'App bundle');
  } catch (error) {
    if (sign) {
      console.error(`[desktop-package] Signed app bundle failed verification: ${error.message}`);
      process.exit(1);
    }

    console.log('[desktop-package] Re-signing macOS app bundle with ad-hoc signature for local packaging');
    run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
    verifyMacCodeSignature(appPath, 'App bundle');
  }

  if (sign) {
    if (!existsSync(dmgPath)) {
      console.error(`[desktop-package] Expected signed DMG output at ${dmgPath}`);
      process.exit(1);
    }
    verifyMacCodeSignature(dmgPath, 'DMG artifact', ['--verify', '--strict']);
  } else {
    mkdirSync(dmgDir, { recursive: true });
    rmSync(dmgPath, { force: true });
    run('hdiutil', ['create', '-volname', variantProductName, '-srcfolder', appPath, '-ov', '-format', 'UDZO', dmgPath]);
  }

  const mountPoint = mkdtempSync(path.join(nodeOs.tmpdir(), 'desktop-package-dmg-'));
  try {
    run('hdiutil', ['attach', dmgPath, '-mountpoint', mountPoint, '-nobrowse', '-readonly', '-quiet']);
    verifyMacCodeSignature(path.join(mountPoint, appName), 'Mounted app bundle');
  } finally {
    const detach = runCapture('hdiutil', ['detach', mountPoint, '-quiet']);
    if ((detach.status ?? 1) !== 0) {
      console.error((detach.stderr || detach.stdout || '').trim());
    }
    rmSync(mountPoint, { recursive: true, force: true });
  }
}

process.exit(0);
