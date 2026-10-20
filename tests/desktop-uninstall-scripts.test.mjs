// The desktop uninstall scripts (scripts/uninstall-desktop.sh and .ps1) must
// track the one-binary model: one product, one identifier, one keychain
// service, matching src-tauri/tauri.conf.json and src-tauri/src/main.rs.
// The shell script is also driven for real against a sandboxed HOME so the
// listing, dry-run, keep-data and removal behaviour are observed, not read.
// The PowerShell script cannot run on the Linux/macOS test runners, so its
// product strings and the install-dir scoping of its process stop are pinned
// as text, with the shell script carrying the runtime proof of the same design.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');
const sh = read('scripts/uninstall-desktop.sh');
const ps1 = read('scripts/uninstall-desktop.ps1');
const docs = read('docs/desktop-app.mdx');
const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
const mainRs = read('src-tauri/src/main.rs');

const rustConst = (name) => {
  const m = mainRs.match(new RegExp(`const ${name}: &str = "([^"]+)"`));
  assert.ok(m, `${name} must be declared in src-tauri/src/main.rs`);
  return m[1];
};

function rustSecretKeys() {
  const m = mainRs.match(/const SUPPORTED_SECRET_KEYS: \[&str; \d+\] = \[([\s\S]*?)\];/);
  assert.ok(m, 'SUPPORTED_SECRET_KEYS must be declared');
  return m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith('"') ? s.slice(1, -1) : rustConst(s)));
}

describe('uninstall scripts track the one-binary desktop model', () => {
  it('name the shipped product, binary, identifier and keychain service', () => {
    for (const [label, text] of [['sh', sh], ['ps1', ps1]]) {
      assert.ok(text.includes(`"${tauri.productName}"`) || text.includes(`'${tauri.productName}'`), `${label}: productName`);
      assert.ok(text.includes(`"${tauri.mainBinaryName}"`) || text.includes(`'${tauri.mainBinaryName}'`), `${label}: mainBinaryName`);
      assert.ok(text.includes(`"${tauri.identifier}"`) || text.includes(`'${tauri.identifier}'`), `${label}: identifier`);
      const service = rustConst('KEYRING_SERVICE');
      assert.ok(text.includes(`"${service}"`) || text.includes(`'${service}'`), `${label}: KEYRING_SERVICE`);
      assert.doesNotMatch(text, /tech\.desktop|finance\.desktop|--variant|-Variant|\$Variant/i, `${label}: no per-variant handling remains`);
    }
  });

  it('clears every keychain account the app can write, including legacy per-key entries', () => {
    const accounts = sh.match(/^KEYRING_ACCOUNTS="([^"]+)"/m)[1].split(/\s+/);
    assert.deepEqual(accounts.sort(), [rustConst('SECRETS_VAULT_KEYRING_ACCOUNT'), rustConst('CLERK_CLIENT_KEYRING_ACCOUNT')].sort());
    const legacy = sh.match(/^LEGACY_SECRET_KEYS="([^"]+)"/m)[1].split(/\s+/);
    assert.deepEqual(legacy, rustSecretKeys());
  });

  it('scopes the Windows process stop to the install directory, like the NSIS hook', () => {
    assert.match(ps1, /InstallLocation/, 'install dir comes from the registry entry');
    assert.match(ps1, /StartsWith\("\$_\\"/, 'processes are matched by executable path prefix under the install dir');
    assert.doesNotMatch(ps1, /-match 'resources\\\\sidecar\\\\node'/, 'the unscoped sidecar path match from the first attempt must not return');
    assert.match(ps1, /if \(\$InstallDirs\.Count -eq 0\) \{ return \}/, 'no install dir means no process stop; the bundled uninstaller handles it');
    assert.match(ps1, /WM_UNINSTALL_SKIP_PROCESS_STOP/);
  });

  it('is documented with manual steps and without piping a script from a URL', () => {
    assert.match(docs, /^## Uninstall$/m);
    assert.match(docs, /scripts\/uninstall-desktop\.sh/);
    assert.match(docs, /uninstall-desktop\.ps1/);
    assert.doesNotMatch(docs, /curl[^\n]*\|\s*(ba)?sh/, 'no curl | bash');
    assert.doesNotMatch(docs, /irm [^\n]*raw\.githubusercontent/, 'no remote PowerShell fetch');
    for (const needle of [tauri.identifier, 'secrets-vault', 'clerk-client', '%APPDATA%', '~/.config/app.worldmonitor.desktop', 'Keychain Access']) {
      assert.ok(docs.includes(needle), `docs name ${needle}`);
    }
  });
});

const platform = process.platform;
const canRun = platform === 'darwin' || platform === 'linux';

function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'wm-uninstall-'));
  const paths = {};
  if (platform === 'darwin') {
    paths.app = join(home, 'Applications', `${tauri.productName}.app`);
    paths.data = join(home, 'Library', 'Application Support', tauri.identifier);
    paths.logs = join(home, 'Library', 'Logs', tauri.identifier);
    paths.unrelated = join(home, 'Library', 'Application Support', 'other.app');
    for (const p of Object.values(paths)) mkdirSync(p, { recursive: true });
    writeFileSync(join(paths.app, 'Info.plist'), '<plist/>');
  } else {
    paths.app = join(home, 'Applications', `${tauri.productName}_2.11.2_amd64.AppImage`);
    paths.data = join(home, '.config', tauri.identifier);
    paths.logs = join(home, '.cache', tauri.identifier);
    paths.unrelated = join(home, '.config', 'other-app');
    paths.launcher = join(home, '.local', 'share', 'applications', 'world-monitor.desktop');
    const otherLauncher = join(home, '.local', 'share', 'applications', 'other.desktop');
    for (const p of [paths.data, paths.logs, paths.unrelated, dirname(paths.app), dirname(paths.launcher)]) mkdirSync(p, { recursive: true });
    writeFileSync(paths.app, 'AppImage');
    writeFileSync(paths.launcher, `[Desktop Entry]\nName=World Monitor\nExec="${paths.app}" %U\n`);
    writeFileSync(otherLauncher, '[Desktop Entry]\nName=Notes about World Monitor\nExec=/usr/bin/gedit\n');
    paths.otherLauncher = otherLauncher;
  }
  return { home, paths };
}

function run(home, args) {
  return spawnSync('bash', [resolve(root, 'scripts/uninstall-desktop.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, WM_UNINSTALL_SKIP_PROCESS_STOP: '1' },
  });
}

describe('uninstall-desktop.sh against a sandboxed home', { skip: !canRun && 'bash script runs on macOS and Linux only' }, () => {
  it('lists the installation and data on a dry run and removes nothing', () => {
    const { home, paths } = fixtureHome();
    try {
      const result = run(home, ['--dry-run', '--keep-secrets']);
      assert.equal(result.status, 0, result.stderr);
      for (const key of ['app', 'data', 'logs', 'launcher']) {
        if (paths[key]) assert.ok(result.stdout.includes(paths[key]), `lists ${key}`);
      }
      assert.ok(!result.stdout.includes(paths.unrelated), 'does not list unrelated data');
      if (paths.otherLauncher) assert.ok(!result.stdout.includes(paths.otherLauncher), 'does not list a launcher that only mentions the product');
      assert.match(result.stdout, /Dry run: nothing was removed/);
      for (const p of Object.values(paths)) assert.ok(existsSync(p), `${p} still exists after dry run`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps data directories with --keep-data and still removes the app', () => {
    const { home, paths } = fixtureHome();
    try {
      const result = run(home, ['--yes', '--keep-data', '--keep-secrets']);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!existsSync(paths.app), 'app removed');
      assert.ok(existsSync(paths.data), 'data kept');
      assert.ok(existsSync(paths.logs), 'logs kept');
      assert.ok(existsSync(paths.unrelated), 'unrelated data untouched');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes the app and its data after confirmation, leaving unrelated paths alone', () => {
    const { home, paths } = fixtureHome();
    try {
      const result = run(home, ['--yes', '--keep-secrets']);
      assert.equal(result.status, 0, result.stderr);
      for (const key of ['app', 'data', 'logs', 'launcher']) {
        if (paths[key]) assert.ok(!existsSync(paths[key]), `${key} removed`);
      }
      assert.ok(existsSync(paths.unrelated), 'unrelated data untouched');
      if (paths.otherLauncher) assert.ok(existsSync(paths.otherLauncher), 'unrelated launcher untouched');
      assert.match(result.stdout, /Done\./);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses without confirmation, reports nothing to do on a clean home, and rejects unknown options', () => {
    const { home, paths } = fixtureHome();
    try {
      const declined = spawnSync('bash', [resolve(root, 'scripts/uninstall-desktop.sh'), '--keep-secrets'], {
        cwd: root, encoding: 'utf8', input: 'n\n', env: { ...process.env, HOME: home, WM_UNINSTALL_SKIP_PROCESS_STOP: '1' },
      });
      assert.equal(declined.status, 1);
      assert.match(declined.stdout, /Aborted/);
      assert.ok(existsSync(paths.app), 'declining keeps the app');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const empty = mkdtempSync(join(tmpdir(), 'wm-uninstall-empty-'));
    try {
      const result = run(empty, ['--keep-secrets']);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /Nothing to uninstall/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const bad = run(tmpdir(), ['--variant', 'tech']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown option: --variant/);
    assert.equal(execFileSync('bash', [resolve(root, 'scripts/uninstall-desktop.sh'), '--help'], { encoding: 'utf8' }).includes('--keep-data'), true);
  });
});
