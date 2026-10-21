#!/usr/bin/env node
/**
 * Generate THIRD-PARTY-NOTICES.md for the shipped desktop bundle (#6977).
 *
 * The desktop app ships as .dmg / .msi / NSIS / AppImage — a binary
 * distribution — and it carries a compiled Rust binary, a bundled Node runtime,
 * and the whole production npm tree compiled into `dist/`. MIT, BSD and
 * Apache-2.0 all require their notice to travel with a binary distribution, and
 * before this script nothing did: no NOTICE file, no installer licence page, no
 * licence in the About dialog.
 *
 * Sources, in order of trustworthiness:
 *   npm    — package-lock.json for the production tree, then each package's own
 *            LICENSE file from node_modules (verbatim text, not just the SPDX id)
 *   cargo  — `cargo metadata` for the crate graph, then each crate's LICENSE
 *            from the local registry checkout when it is present
 *
 * Usage:
 *   node scripts/generate-third-party-notices.mjs           # write the file
 *   node scripts/generate-third-party-notices.mjs --check   # fail if stale/missing
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Written into src-tauri/notices/, which is a committed directory with
// gitignored contents (like src-tauri/sidecar/node). tauri-build resolves
// bundle.resources at compile time, so a path that only exists after a build
// fails `cargo test` in a fresh checkout.
const OUTPUT = join(ROOT, 'src-tauri', 'notices', 'THIRD-PARTY-NOTICES.md');
const CHECK = process.argv.includes('--check');

const LICENSE_FILE_RE = /^(LICENSE|LICENCE|COPYING|NOTICE)(\..*)?$/i;
// A licence text longer than this is almost certainly a bundled corpus, not a
// licence; truncating keeps one pathological package from dominating the file.
const MAX_LICENSE_CHARS = 20_000;

function readLicenseText(packageDir) {
  if (!existsSync(packageDir)) return null;
  let entries;
  try {
    entries = readdirSync(packageDir);
  } catch {
    return null;
  }
  const files = entries.filter((entry) => LICENSE_FILE_RE.test(entry)).sort();
  const texts = [];
  for (const file of files) {
    const path = join(packageDir, file);
    try {
      if (!statSync(path).isFile()) continue;
      texts.push(readFileSync(path, 'utf8').trim());
    } catch {
      /* unreadable licence file — recorded as missing below */
    }
  }
  if (texts.length === 0) return null;
  const joined = texts.join('\n\n');
  return joined.length > MAX_LICENSE_CHARS
    ? `${joined.slice(0, MAX_LICENSE_CHARS)}\n\n[truncated — full text ships with the package]`
    : joined;
}

/** Production npm dependencies, from the lockfile rather than a resolver run. */
function npmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const packages = lock.packages ?? {};
  const seen = new Map();

  for (const [path, meta] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/')) continue; // "" is this package
    if (meta.dev || meta.devOptional) continue; // build-only, never shipped
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const key = `${name}@${meta.version}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      name,
      version: meta.version ?? 'unknown',
      license: meta.license ?? 'UNKNOWN',
      text: readLicenseText(join(ROOT, path)),
    });
  }

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Rust crates compiled into the desktop binary. */
function cargoCrates() {
  let metadata;
  try {
    const raw = execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml')],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    metadata = JSON.parse(raw);
  } catch {
    return null; // cargo unavailable — reported in the output, never silently dropped
  }

  return (metadata.packages ?? [])
    .filter((pkg) => pkg.name !== 'world-monitor')
    .map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? pkg.license_file ?? 'UNKNOWN',
      // manifest_path is .../<crate>-<version>/Cargo.toml in the registry checkout
      text: readLicenseText(dirname(pkg.manifest_path ?? '')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderSection(title, entries, emptyNote) {
  if (!entries) return `## ${title}\n\n${emptyNote}\n`;
  const lines = [`## ${title}`, '', `${entries.length} packages.`, ''];
  for (const entry of entries) {
    lines.push(`### ${entry.name} ${entry.version}`, '', `License: ${entry.license}`, '');
    if (entry.text) {
      lines.push('```', entry.text, '```', '');
    } else {
      lines.push(
        `_No license file shipped with this package; the ${entry.license} terms apply as declared in its manifest._`,
        '',
      );
    }
  }
  return lines.join('\n');
}

function render() {
  const npm = npmPackages();
  const crates = cargoCrates();

  return [
    '# Third-party notices',
    '',
    'World Monitor is licensed under AGPL-3.0-only (see `LICENSE`). It is built on the',
    'open-source packages below, each under its own license, and the notices here travel',
    'with every binary we distribute as those licenses require.',
    '',
    'This file is generated by `scripts/generate-third-party-notices.mjs`. Do not edit it by hand.',
    '',
    'The desktop bundle also ships an unmodified **Node.js** runtime under `resources/sidecar/node`.',
    'Node.js is MIT-licensed and carries its own `LICENSE` file, including the notices for the',
    'components it embeds (OpenSSL, ICU, libuv, V8, zlib and others), inside that directory.',
    '',
    renderSection('npm packages', npm, ''),
    renderSection(
      'Rust crates',
      crates,
      '_`cargo metadata` was unavailable when this file was generated, so the crate graph is not listed here._\n' +
        '_Regenerate with cargo on PATH before shipping a desktop build._',
    ),
  ].join('\n');
}

const content = render();

if (CHECK) {
  if (!existsSync(OUTPUT)) {
    console.error('src-tauri/notices/THIRD-PARTY-NOTICES.md is missing. Run: node scripts/generate-third-party-notices.mjs');
    process.exit(1);
  }
  const existing = readFileSync(OUTPUT, 'utf8');
  if (existing.trim().length === 0) {
    console.error('THIRD-PARTY-NOTICES.md is empty.');
    process.exit(1);
  }
  // Compare the package inventory, not the whole file: licence texts are read
  // from node_modules, which a --omit=optional install can legitimately thin out.
  const inventory = (text) => [...text.matchAll(/^### (.+)$/gm)].map((match) => match[1]).sort();
  const before = inventory(existing);
  const after = inventory(content);
  const missing = after.filter((entry) => !before.includes(entry));
  if (missing.length > 0) {
    console.error(
      `THIRD-PARTY-NOTICES.md is stale — ${missing.length} package(s) not listed, e.g. ${missing.slice(0, 3).join(', ')}.\n` +
        'Run: node scripts/generate-third-party-notices.mjs',
    );
    process.exit(1);
  }
  console.log(`THIRD-PARTY-NOTICES.md OK — ${before.length} packages listed.`);
  process.exit(0);
}

writeFileSync(OUTPUT, `${content.trimEnd()}\n`, 'utf8');
console.log(`Wrote ${OUTPUT}`);
