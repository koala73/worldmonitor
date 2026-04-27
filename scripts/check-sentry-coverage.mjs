#!/usr/bin/env node
/**
 * Sentry-coverage lint guard.
 *
 * Flags catch blocks in api/ and convex/ that log via console.error /
 * console.warn but don't surface to Sentry — i.e., the silent-swallow
 * pattern that hid the canary OCC bug (Sentry issue WORLDMONITOR-PA)
 * for hours and made the post-mortem impossible.
 *
 * Heuristic: for each file under api/ or convex/, find catch blocks
 * (`} catch (...) { ... }`). If a block contains console.error/warn
 * but no `captureSilentError`, `captureEdgeException`, `Sentry.`, or
 * `throw` — fail.
 *
 * Mode:
 *   - `--diff` (default in pre-push): only flags catch blocks introduced
 *     in the diff vs origin/main. Existing legacy catches are tolerated
 *     so we don't block unrelated work.
 *   - `--all`: scans the whole tree. Use ad-hoc to find existing gaps.
 *
 * Exit code: 0 if clean (or no offending changes), 1 if any flag.
 *
 * Run manually:
 *   node scripts/check-sentry-coverage.mjs            # diff mode
 *   node scripts/check-sentry-coverage.mjs --all      # full scan
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const SCAN_ALL = args.includes('--all');

const TARGET_DIRS = ['api', 'convex'];

// A catch block is "OK" if it contains at least one of these markers.
// `throw` covers re-throws (auto-Sentry catches the propagated throw).
// `captureSilentError` is our helper. `captureEdgeException` is the
// pre-sweep alias still imported by notification-channels.ts.
// `status: 5xx` covers HTTP handlers that return a 5xx upstream — Resend
// / Dodo / clients retry, and the inner mutation throw (if any) is already
// captured by Convex auto-Sentry, so the outer catch+log isn't a swallow.
const SAFE_PATTERNS = [
  /\bcaptureSilentError\b/,
  /\bcaptureEdgeException\b/,
  /\bSentry\.captureException\b/,
  /\bSentry\.captureMessage\b/,
  /\bthrow\b/,
  /\bstatus:\s*5\d\d\b/,
];

const LOG_PATTERN = /\bconsole\.(error|warn)\b/;

// Skip the helper files themselves — their `console.warn` on Sentry
// delivery failure is the right behaviour (a Sentry capture inside the
// Sentry helper would loop forever).
const SKIP_FILE_PATTERNS = [
  /\/api\/_sentry-edge\.(js|mjs|ts)$/,
  /\/api\/_sentry-node\.(js|mjs|ts)$/,
];

function listChangedFiles() {
  try {
    const out = execSync('git diff --name-only origin/main...HEAD', {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .filter(Boolean)
      .filter((p) => TARGET_DIRS.some((d) => p.startsWith(`${d}/`)))
      .filter((p) => /\.(ts|tsx|mjs|js)$/.test(p));
  } catch {
    return [];
  }
}

function listAllFiles() {
  const out = execSync(
    `find ${TARGET_DIRS.join(' ')} -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.js' \\) -not -path '*/node_modules/*' -not -path '*/_generated/*'`,
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

function findUnsafeCatches(filePath) {
  const src = readFileSync(filePath, 'utf8');
  const offenders = [];

  // Scan for catch blocks. We balance braces manually to handle nesting
  // (regex alone misses nested `{ }` inside the catch body).
  let i = 0;
  while (i < src.length) {
    const m = src.slice(i).match(/\}\s*catch\s*(?:\([^)]*\))?\s*\{/);
    if (!m) break;
    const startInRest = m.index;
    const absStart = i + startInRest;
    const bodyOpenAbs = absStart + m[0].length - 1; // index of the opening `{`

    // Walk forward to find the matching closing brace.
    let depth = 1;
    let j = bodyOpenAbs + 1;
    while (j < src.length && depth > 0) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const bodyEnd = j; // exclusive
    const body = src.slice(bodyOpenAbs + 1, bodyEnd - 1);

    if (LOG_PATTERN.test(body) && !SAFE_PATTERNS.some((p) => p.test(body))) {
      const lineNo = src.slice(0, absStart).split('\n').length;
      offenders.push({ filePath, lineNo, snippet: body.split('\n')[0].trim().slice(0, 100) });
    }

    i = bodyEnd;
  }

  return offenders;
}

function main() {
  const files = SCAN_ALL ? listAllFiles() : listChangedFiles();
  if (files.length === 0) {
    if (!SCAN_ALL) console.log('  Sentry coverage: no api/ or convex/ files changed.');
    return 0;
  }

  const allOffenders = [];
  for (const f of files) {
    const abs = resolve(f);
    if (SKIP_FILE_PATTERNS.some((p) => p.test(abs))) continue;
    try {
      allOffenders.push(...findUnsafeCatches(abs));
    } catch (err) {
      // Skip unreadable files (e.g., deleted in this diff).
      if (err && err.code !== 'ENOENT') throw err;
    }
  }

  if (allOffenders.length === 0) {
    console.log(`  Sentry coverage: clean (${files.length} file${files.length === 1 ? '' : 's'} checked).`);
    return 0;
  }

  console.error('');
  console.error('============================================================');
  console.error('Sentry coverage check FAILED');
  console.error('');
  console.error(
    `Found ${allOffenders.length} catch block(s) that log via console.error/warn`,
  );
  console.error('but do not surface to Sentry. Either:');
  console.error('  - call `captureSilentError(err, { tags: { ... } })` next to the log, OR');
  console.error('  - re-throw the error (Convex auto-Sentry will capture it).');
  console.error('');
  console.error('Helpers:');
  console.error('  api/ edge:  import { captureSilentError } from \'./_sentry-edge.js\';');
  console.error('  api/ node:  import { captureSilentError } from \'./_sentry-node.js\';');
  console.error('');
  console.error('Offenders:');
  for (const o of allOffenders) {
    console.error(`  ${o.filePath}:${o.lineNo}  ${o.snippet}`);
  }
  console.error('============================================================');
  return 1;
}

process.exit(main());
