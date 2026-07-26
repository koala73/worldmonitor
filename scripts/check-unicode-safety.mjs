#!/usr/bin/env node
/**
 * Detect suspicious invisible Unicode in executable repository files.
 *
 * Threat model:
 * - Trojan Source (bidi controls)
 * - Zero-width/invisible control chars
 * - Variation selector steganography / Unicode tags
 * - Private Use Area payload hiding
 *
 * Usage:
 *   node scripts/check-unicode-safety.mjs
 *   node scripts/check-unicode-safety.mjs --staged
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const stagedOnly = args.has('--staged');

const ROOT = process.cwd();

// `--staged` matches purely on EXCLUDED_PREFIXES and extension, so it scans
// anything a commit touches; the full-repo walk only descends these roots. That
// asymmetry means a directory absent here is still gated on commit but never
// swept in CI. pro-test/ is a full React app and was in exactly that position.
export const SCAN_ROOTS = [
  'src',
  'server',
  'api',
  'scripts',
  'tests',
  'e2e',
  'pro-test',
  '.github',
  '.husky',
];

const INCLUDED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yml', '.yaml', '.sh',
  '',  // extensionless scripts (e.g. .husky/pre-commit, .husky/pre-push)
]);

export const EXCLUDED_PREFIXES = [
  '.git/',
  'node_modules/',
  'src/generated/',
  'docs/',
  'blog-site/',
  'public/blog/',
  // Built bundle, not source: pro-test/ compiles into here and each locale
  // becomes its own hashed chunk, so the joiners allowed in locale data below
  // reappear verbatim in public/pro/assets/fa-*.js. Its inputs are scanned, and
  // .github/workflows rebuilds and byte-diffs it, so excluding the output adds
  // no unscanned surface.
  'public/pro/',
  'scripts/data/',
  'scripts/node_modules/',
];

// Locale data needs ZWNJ (U+200C) and ZWJ (U+200D) — they are *required* for
// correct Persian and Devanagari typesetting, and `--staged` matches by path
// rather than by SCAN_ROOTS, so without an allowance pre-commit rejects any
// commit carrying a correctly-typeset RTL or Indic string.
//
// The allowance is scoped to those two code points rather than skipping the
// files, because these strings are rendered into a public pricing page: a bidi
// control in an RTL locale can reverse a rendered digit run, so a price or a
// licence term can display differently from the JSON a reviewer reads. Excluding
// the whole path would turn off Trojan Source detection exactly where nobody
// eyeballs the rendered output. Verified sufficient: the only such characters in
// either catalog today are U+200B/200C/200D, and no bidi control anywhere.
export const LOCALE_DATA_PREFIXES = ['src/locales/', 'pro-test/src/locales/'];
const LOCALE_ALLOWED_CODEPOINTS = new Set([0x200c, 0x200d]);

export function isLocaleData(path) {
  return LOCALE_DATA_PREFIXES.some(prefix => path.startsWith(prefix));
}

const ZERO_WIDTH = new Set([0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF]);

function isBidiControl(cp) {
  return (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069);
}

function isVariationSelectorSupplement(cp) {
  return cp >= 0xE0100 && cp <= 0xE01EF;
}

function isVariationSelectorSuspicious(cp) {
  // FE0F (emoji presentation selector) is legitimately used after emoji base
  // characters (including ASCII keycap sequences like #️⃣) — skip to avoid
  // false positives. FE00..FE0E (text/emoji selectors) are rare in source and
  // suspicious for steganography.
  return cp >= 0xFE00 && cp <= 0xFE0E;
}

// PUA (E000–F8FF) is intentionally excluded: it doesn't affect parser
// semantics and is legitimately used by icon fonts in string literals.

function getExtension(path) {
  // Basename only. Reading the whole path made `.husky/pre-commit` report an
  // extension of `.husky/pre-commit`, so it never matched the `''` entry that
  // exists precisely to cover it — the git hooks, which execute on every commit
  // and are the highest-value place to hide a Trojan Source payload, were listed
  // in SCAN_ROOTS and silently skipped.
  const base = path.slice(path.lastIndexOf('/') + 1);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

export function shouldScanFile(path) {
  // Dependencies are never ours to fix, and minified vendor bundles are full of
  // zero-width characters. A prefix cannot express this: the list already needed
  // separate `node_modules/` and `scripts/node_modules/` entries, and every new
  // package root would need another. Match the directory name at any depth.
  if (path.split('/').includes('node_modules')) return false;
  if (EXCLUDED_PREFIXES.some(prefix => path.startsWith(prefix))) return false;
  const ext = getExtension(path);
  if (!INCLUDED_EXTENSIONS.has(ext)) return false;
  return true;
}

function walkDir(rootDir, out) {
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(rootDir, entry.name);
    const rel = relative(ROOT, abs).replace(/\\/g, '/');
    if (EXCLUDED_PREFIXES.some(prefix => rel.startsWith(prefix))) continue;
    if (entry.isDirectory()) {
      // Prune here as well as in shouldScanFile: without it the walk descends
      // every directory of every dependency before rejecting the files one by
      // one, which is pure work for a guaranteed-empty result.
      if (entry.name === 'node_modules') continue;
      walkDir(abs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!shouldScanFile(rel)) continue;
    out.push(rel);
  }
}

function getRepoFiles() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    try {
      if (statSync(abs).isDirectory()) walkDir(abs, files);
    } catch {
      // ignore missing roots
    }
  }
  return files;
}

function getStagedFiles() {
  let out = '';
  try {
    out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map(s => s.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter(shouldScanFile);
}

function formatCodePoint(cp) {
  return `U+${cp.toString(16).toUpperCase().padStart(cp > 0xFFFF ? 6 : 4, '0')}`;
}

function classify(cp) {
  if (isBidiControl(cp)) return 'bidi-control';
  if (ZERO_WIDTH.has(cp)) return 'zero-width';
  if (isVariationSelectorSupplement(cp)) return 'variation-selector-supplement';
  if (isVariationSelectorSuspicious(cp)) return 'variation-selector';
  return null;
}

function scanFile(path) {
  const abs = join(ROOT, path);
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  return scanText(path, text);
}

// Exported so the locale allowance can be tested against real content rather
// than only against path predicates — a scope test that asserts which files are
// skipped can never show that the skip is narrower than the threat model.
export function scanText(path, text) {
  const localeData = isLocaleData(path);
  const findings = [];
  const lines = text.split('\n');
  let line = 1;
  let col = 1;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const kind = localeData && LOCALE_ALLOWED_CODEPOINTS.has(cp) ? null : classify(cp);
    if (kind) {
      const lineText = lines[line - 1] ?? '';
      findings.push({
        path,
        line,
        col,
        kind,
        cp: formatCodePoint(cp),
        lineText,
      });
    }

    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      // Astral-plane characters (cp > 0xFFFF) occupy two UTF-16 code units.
      // Increment by 2 so reported columns match editor column positions.
      col += cp > 0xFFFF ? 2 : 1;
    }
  }

  return findings;
}

function main() {
  const files = stagedOnly ? getStagedFiles() : getRepoFiles();
  if (files.length === 0) {
    console.log(stagedOnly ? 'Unicode safety: no staged executable files to scan.' : 'Unicode safety: no files matched scan scope.');
    return;
  }

  const findings = [];
  for (const file of files) {
    findings.push(...scanFile(file));
  }

  if (findings.length === 0) {
    console.log(`Unicode safety: scanned ${files.length} file(s), no suspicious hidden Unicode found.`);
    return;
  }

  console.error(`Unicode safety check failed: ${findings.length} suspicious character(s) found.`);
  for (const f of findings.slice(0, 200)) {
    console.error(`${f.path}:${f.line}:${f.col}  ${f.cp}  ${f.kind}`);
    if (f.lineText) console.error(`  ${f.lineText}`);
  }
  if (findings.length > 200) {
    console.error(`... ${findings.length - 200} more finding(s) omitted.`);
  }
  console.error('');
  console.error('If intentional, replace with visible escapes or remove from executable files.');
  process.exit(1);
}

// realpath BOTH sides: through a symlinked checkout Node sets import.meta.url
// to the realpath while argv[1] keeps the symlink, and the naive comparison
// silently skips main() — a fail-open for a pre-commit security gate.
const isMain =
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href ===
    pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;

if (isMain) main();
