import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  RUST_SECURITY_FLOORS,
  checkManifestSecurityFloor,
  checkRustSecurityFloors,
  compareVersions,
  parseCargoLockVersions,
  resolveRootDir,
} from '../scripts/check-rust-security-floors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = resolve(root, 'scripts/check-rust-security-floors.mjs');
const realLock = readFileSync(resolve(root, 'src-tauri/Cargo.lock'), 'utf8');

const lockFixture = (crate, version) =>
  `[[package]]\nname = "${crate}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;

/**
 * A lockfile fixture that satisfies EVERY recorded floor, with optional
 * per-crate version overrides.
 *
 * The absent-crate guard means a fixture naming only the crate under test
 * fails on every OTHER floor, so hand-rolled single-crate lockfiles turned
 * unrelated tests red the moment a second floor was recorded. Building from
 * the real floor list keeps each test isolated to the behaviour it probes and
 * keeps it correct as floors are added or removed.
 */
const satisfyingLock = (overrides = {}) =>
  RUST_SECURITY_FLOORS.map((floor) =>
    lockFixture(floor.crate, overrides[floor.crate] ?? floor.minVersion),
  ).join('');

/** The same fixture with one floored crate omitted, to probe the absent-crate guard. */
const satisfyingLockWithout = (crate) =>
  RUST_SECURITY_FLOORS.filter((floor) => floor.crate !== crate)
    .map((floor) => lockFixture(floor.crate, floor.minVersion))
    .join('');

describe('check-rust-security-floors', () => {
  it('orders versions numerically, not lexically', () => {
    assert.equal(compareVersions('2.9.3', '2.11.1'), -1, '2.9.3 must sort below 2.11.1');
    assert.equal(compareVersions('2.11.5', '2.11.1'), 1);
    assert.equal(compareVersions('2.11.1', '2.11.1'), 0);
    assert.equal(compareVersions('2.10.3', '2.11.1'), -1);
  });

  it('sorts a prerelease below its release (conservative for a security floor)', () => {
    assert.equal(compareVersions('2.11.1-rc.1', '2.11.1'), -1);
  });

  it('parses name/version pairs out of a lockfile', () => {
    const versions = parseCargoLockVersions(lockFixture('tauri', '2.11.5') + lockFixture('wry', '0.55.1'));
    assert.deepEqual(versions.get('tauri'), ['2.11.5']);
    assert.deepEqual(versions.get('wry'), ['0.55.1']);
  });

  it('collects every locked copy when a crate appears at multiple versions', () => {
    const versions = parseCargoLockVersions(lockFixture('getrandom', '0.2.17') + lockFixture('getrandom', '0.4.1'));
    assert.deepEqual(versions.get('getrandom'), ['0.2.17', '0.4.1']);
  });

  it('fails when ANY locked copy is below the floor, even beside a patched one', () => {
    // Multi-version crates are normal in Cargo.lock (this repo has dozens), so
    // a patched copy must not mask a vulnerable duplicate of the same crate.
    const errors = checkRustSecurityFloors(
      satisfyingLock({ tauri: '2.11.5' }) + lockFixture('tauri', '2.10.3'),
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /tauri 2\.10\.3 is below the security floor/);
    assert.match(errors[0], /2 versions locked/);
  });

  it('passes when every floored crate meets its floor', () => {
    assert.deepEqual(checkRustSecurityFloors(satisfyingLock()), []);
  });

  it('fails when a crate sits below its floor (mutation: the CVE-2026-42184 regression)', () => {
    const errors = checkRustSecurityFloors(satisfyingLock({ tauri: '2.10.3' }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /tauri 2\.10\.3 is below the security floor 2\.11\.1/);
    assert.match(errors[0], /cargo update -p tauri --precise/);
  });

  it('fails when a crate sits below its floor (mutation: the openssl memory-safety regression)', () => {
    // reqwest -> native-tls -> openssl is the live TLS stack in the Linux
    // desktop binaries, so a `cargo update` that walks this back must not pass.
    const errors = checkRustSecurityFloors(satisfyingLock({ openssl: '0.10.75' }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /openssl 0\.10\.75 is below the security floor 0\.10\.80/);
  });

  it('fails when a floored crate is absent entirely (vacuous-pass guard)', () => {
    const errors = checkRustSecurityFloors(satisfyingLockWithout('tauri') + lockFixture('wry', '0.55.1'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /absent from Cargo\.lock/);
  });

  it('fails on an unparseable or empty lockfile rather than reporting zero violations', () => {
    const errors = checkRustSecurityFloors('');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /zero crates/);
  });

  it('keeps every floor entry documented with an advisory and issue', () => {
    assert.ok(RUST_SECURITY_FLOORS.length > 0, 'at least one floor must be recorded');
    for (const floor of RUST_SECURITY_FLOORS) {
      assert.match(floor.crate, /^[a-z0-9_-]+$/, 'crate name');
      assert.match(floor.minVersion, /^\d+\.\d+\.\d+$/, `${floor.crate} minVersion`);
      assert.ok(floor.advisory?.length > 5, `${floor.crate} must cite its advisory`);
      assert.ok(floor.reason?.length > 20, `${floor.crate} must record why the floor exists`);
    }
  });

  it('accepts both --root spellings and refuses an empty one', () => {
    // Silently ignoring `--root=<dir>` would audit the wrong tree and report
    // green — the one failure mode a security gate must not have.
    assert.equal(resolveRootDir(['--root', '/tmp/x'], '/cwd'), '/tmp/x');
    assert.equal(resolveRootDir(['--root=/tmp/x'], '/cwd'), '/tmp/x');
    assert.equal(resolveRootDir([], '/cwd'), '/cwd');
    assert.throws(() => resolveRootDir(['--root'], '/cwd'), /no directory/);
    assert.throws(() => resolveRootDir(['--root='], '/cwd'), /no directory/);
    assert.throws(() => resolveRootDir(['--root', '--verbose'], '/cwd'), /no directory/);
  });

  it('keeps the manifest constraint at or above every recorded floor', () => {
    for (const floor of RUST_SECURITY_FLOORS.filter((f) => f.manifestFile)) {
      const manifest = readFileSync(resolve(root, floor.manifestFile), 'utf8');
      assert.deepEqual(checkManifestSecurityFloor(manifest, floor), []);
    }
  });

  it('fails when a manifest lower bound is below its recorded floor', () => {
    const floor = RUST_SECURITY_FLOORS.find((entry) => entry.crate === 'tauri');
    assert.ok(floor);
    const errors = checkManifestSecurityFloor(
      'tauri = { version = ">=2.10.3, <3", features = [] }\n',
      floor,
    );
    assert.match(errors[0], /allows tauri >= 2\.10\.3, below the recorded security floor 2\.11\.1/);
  });

  it('exercises the CLI entrypoint for default cwd and --root invocations', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'rust-security-floor-cli-'));
    try {
      const tauriRoot = join(fixtureRoot, 'src-tauri');
      mkdirSync(tauriRoot);
      writeFileSync(
        join(tauriRoot, 'Cargo.toml'),
        'tauri = { version = ">=2.11.1, <3", features = [] }\n',
      );
      writeFileSync(join(tauriRoot, 'Cargo.lock'), satisfyingLock({ tauri: '2.11.5' }));

      const defaultRun = spawnSync(process.execPath, [checker], {
        cwd: fixtureRoot,
        encoding: 'utf8',
      });
      assert.equal(defaultRun.status, 0, defaultRun.stderr);
      assert.match(defaultRun.stdout, /rust security floors OK: tauri >= 2\.11\.1/);

      writeFileSync(
        join(tauriRoot, 'Cargo.toml'),
        'tauri = { version = ">=2.10.3, <3", features = [] }\n',
      );
      const manifestRun = spawnSync(process.execPath, [checker, `--root=${fixtureRoot}`], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(manifestRun.status, 1);
      assert.match(manifestRun.stderr, /Cargo\.toml allows tauri >= 2\.10\.3, below/);

      writeFileSync(
        join(tauriRoot, 'Cargo.toml'),
        'tauri = { version = ">=2.11.1, <3", features = [] }\n',
      );
      writeFileSync(join(tauriRoot, 'Cargo.lock'), satisfyingLock({ tauri: '2.10.3' }));
      const rootRun = spawnSync(process.execPath, [checker, `--root=${fixtureRoot}`], {
        cwd: root,
        encoding: 'utf8',
      });
      assert.equal(rootRun.status, 1);
      assert.match(rootRun.stderr, /::error::rust security floor: tauri 2\.10\.3 is below/);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('holds against the real committed Cargo.lock', () => {
    assert.deepEqual(checkRustSecurityFloors(realLock), []);
  });

  it('pins the real lockfile above the CVE-2026-42184 floor', () => {
    const locked = parseCargoLockVersions(realLock).get('tauri');
    assert.ok(locked?.length, 'tauri must be present in Cargo.lock');
    for (const version of locked) {
      assert.ok(
        compareVersions(version, '2.11.1') >= 0,
        `committed Cargo.lock pins tauri ${version}, below the 2.11.1 patched release`,
      );
    }
  });
});
