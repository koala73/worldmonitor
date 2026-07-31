#!/usr/bin/env node
/**
 * Rust dependency security floors (#5518, part of #5902).
 *
 * `src-tauri/Cargo.lock` is what actually decides which crate versions ship —
 * the manifest constraint only bounds resolution. Nothing else in CI inspects
 * it: the security-audit workflow covers npm lockfiles only, so before this
 * check a `cargo update` (or a loosened constraint) could silently drop the
 * desktop app back onto a version with a known advisory and no gate would
 * notice. That is the desktop-drift class #5902 exists to close.
 *
 * Each floor is a recorded decision: crate, minimum patched version, and the
 * advisory that set it. A crate named here but ABSENT from the lockfile fails
 * the check rather than passing vacuously — a rename or removal must be an
 * explicit decision to drop the floor, not a silent green.
 *
 * Run: node scripts/check-rust-security-floors.mjs  (npm run desktop:check-rust-floors)
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule } from './lib/main-module.mjs';

export const RUST_SECURITY_FLOORS = [
  {
    crate: 'tauri',
    minVersion: '2.11.1',
    advisory: 'GHSA-7gmj-67g7-phm9 / CVE-2026-42184 (CVSS 8.8)',
    reason:
      'is_local_url() matched only the first subdomain label, so a hostname like tauri.evil.com could pass as a trusted local origin and invoke IPC commands (Windows/Android webviews). Partially mitigated here by require_trusted_window() label gating, but the bump is the real fix.',
    issue: '#5518',
  },
];

/**
 * Parse `name`/`version` pairs out of a Cargo.lock into a Map of
 * crate -> ALL locked versions.
 *
 * Multiple versions of one crate legitimately coexist in a Cargo.lock (this
 * repo's lockfile carries dozens of such crates, e.g. `getrandom` at three
 * majors). Keeping only one occurrence would let a vulnerable duplicate hide
 * behind a patched sibling, so a floor is checked against every locked copy.
 */
export function parseCargoLockVersions(lockSource) {
  const versions = new Map();
  const pattern = /^name = "([^"]+)"\r?\nversion = "([^"]+)"/gm;
  for (const match of lockSource.matchAll(pattern)) {
    const existing = versions.get(match[1]);
    if (existing) existing.push(match[2]);
    else versions.set(match[1], [match[2]]);
  }
  return versions;
}

/**
 * Compare semver-ish versions. A prerelease (`2.11.1-rc.1`) sorts BELOW the
 * matching release, which is the conservative direction for a security floor.
 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, prerelease] = String(v).split('-', 2);
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0);
    while (parts.length < 3) parts.push(0);
    return { parts, hasPrerelease: prerelease !== undefined };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.hasPrerelease === right.hasPrerelease) return 0;
  return left.hasPrerelease ? -1 : 1;
}

export function checkRustSecurityFloors(lockSource, floors = RUST_SECURITY_FLOORS) {
  const errors = [];
  const versions = parseCargoLockVersions(lockSource);

  if (versions.size === 0) {
    errors.push('Cargo.lock parsed to zero crates — the lockfile is empty or the parser broke (refusing to pass vacuously)');
    return errors;
  }

  for (const floor of floors) {
    const locked = versions.get(floor.crate);
    if (!locked) {
      errors.push(
        `${floor.crate} has a security floor (>= ${floor.minVersion}, ${floor.advisory}) but is absent from Cargo.lock — ` +
          'if the dependency was intentionally removed, delete its floor entry in scripts/check-rust-security-floors.mjs',
      );
      continue;
    }
    // Every locked copy must clear the floor: one patched version does not
    // make a second, vulnerable copy of the same crate safe.
    for (const version of locked.filter((v) => compareVersions(v, floor.minVersion) < 0)) {
      errors.push(
        `${floor.crate} ${version} is below the security floor ${floor.minVersion} (${floor.advisory}, ${floor.issue})` +
          `${locked.length > 1 ? ` [${locked.length} versions locked: ${locked.join(', ')}]` : ''}. ` +
          `Fix: cd src-tauri && cargo update -p ${floor.crate} --precise <patched-version> && commit Cargo.lock`,
      );
    }
  }

  return errors;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const rootFlagIndex = process.argv.indexOf('--root');
  const rootDir = rootFlagIndex !== -1 ? path.resolve(process.argv[rootFlagIndex + 1]) : process.cwd();
  const lockPath = path.join(rootDir, 'src-tauri', 'Cargo.lock');

  const errors = checkRustSecurityFloors(readFileSync(lockPath, 'utf8'));
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::rust security floor: ${e}`);
    process.exit(1);
  }
  const summary = RUST_SECURITY_FLOORS.map((f) => `${f.crate} >= ${f.minVersion}`).join(', ');
  console.log(`rust security floors OK: ${summary}`);
}
