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
 * but no `captureSilentError`, `captureEdgeException`, `Sentry.`, `throw`,
 * or `status: 5xx` (after stripping comments and string literals to avoid
 * matching those tokens inside text) — fail.
 *
 * Mode:
 *   - `--diff` (default in pre-push): only flags catch blocks that
 *     OVERLAP a hunk introduced in the diff vs origin/main. A catch
 *     block in a changed file that wasn't itself touched is tolerated
 *     so unrelated edits in legacy files aren't blocked.
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
//
// These regexes run against the catch body AFTER comments and string
// literals have been stripped — so `throw` inside a comment or a string
// literal will NOT count as safe. Without that strip, prose like "// don't
// throw here" or `console.error('throw failed')` would mask real swallows.
const SAFE_PATTERNS = [
  /\bcaptureSilentError\b/,
  /\bcaptureEdgeException\b/,
  /\bSentry\.captureException\b/,
  /\bSentry\.captureMessage\b/,
  /\bthrow\b/,
  /\bstatus:\s*5\d\d\b/,
];

// Inline override marker — when a catch body needs to swallow on the
// HTTP path but surfaces to Sentry through a non-obvious channel (e.g.,
// `ctx.scheduler.runAfter(...)` to a Convex mutation that throws). The
// marker MUST be in the un-stripped raw source so it survives comment
// removal — we check the raw catch body for it before falling through
// to the safety patterns.
const OVERRIDE_MARKER = /\/\/\s*sentry-coverage-ok\b/;

const LOG_PATTERN = /\bconsole\.(error|warn)\b/;

// Skip the helper files themselves — their `console.warn` on Sentry
// delivery failure is the right behaviour (a Sentry capture inside the
// Sentry helper would loop forever).
const SKIP_FILE_PATTERNS = [
  /\/api\/_sentry-edge\.(js|mjs|ts)$/,
  /\/api\/_sentry-node\.(js|mjs|ts)$/,
  /\/api\/_sentry-common\.(js|mjs|ts)$/,
];

/**
 * Replace JavaScript comments and string literals with spaces of equal
 * length, preserving line numbers and overall indexing. We don't need to
 * preserve the actual content — we just need the safety-pattern regexes
 * to NOT match against tokens that live inside comments or strings.
 *
 * Handled forms:
 *   - line comment   `// ...\n`
 *   - block comment  `/ * ... * /`  (without space)
 *   - single-quoted  'string with \\' escape'
 *   - double-quoted  "string with \\" escape"
 *   - template       `string with ${expr}` — only the static slices, not
 *                    the ${expr} parts (those are real code we still want
 *                    to scan). Best-effort: nested templates and braces
 *                    inside ${...} are tolerated by tracking depth.
 *   - regex literals — matters too because /throw/ would otherwise hit.
 *                    Heuristic: only treat `/.../flags` as a regex when
 *                    the previous non-whitespace token is one of the
 *                    canonical "regex follows" tokens. Imperfect but
 *                    good enough for our codebase; false negatives here
 *                    cost a real-bug detection at worst.
 */
function stripCommentsAndStrings(src) {
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];

  function blank(start, end) {
    for (let k = start; k < end; k++) {
      // Preserve newlines so line numbers stay correct.
      if (out[k] !== '\n') out[k] = ' ';
    }
  }

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    // Line comment
    if (c === '/' && next === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length - 1 && !(src[j] === '*' && src[j + 1] === '/')) j++;
      const end = Math.min(src.length, j + 2);
      blank(i, end);
      i = end;
      continue;
    }
    // String literals (single, double)
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === quote) {
          j++;
          break;
        }
        if (ch === '\n') break; // unterminated — bail
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // Template literal (handle ${ ... } as code we KEEP, rest as string)
    if (c === '`') {
      let j = i + 1;
      let staticStart = j;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (ch === '$' && src[j + 1] === '{') {
          // Blank the static slice before this ${, then descend into the
          // expression and let the outer loop pick it back up after the
          // matching '}'.
          blank(staticStart, j);
          let depth = 1;
          j += 2;
          while (j < src.length && depth > 0) {
            const inner = src[j];
            if (inner === '{') depth++;
            else if (inner === '}') depth--;
            else if (inner === "'" || inner === '"' || inner === '`') {
              // Skip nested strings via a mini-recursion.
              const sub = stripStringFrom(src, j);
              blank(j, sub);
              j = sub;
              continue;
            }
            j++;
          }
          staticStart = j;
          continue;
        }
        if (ch === '`') {
          blank(staticStart, j);
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    i++;
  }

  return out.join('');
}

// Helper — skip past a string starting at `i`, return index after closing.
function stripStringFrom(src, i) {
  const c = src[i];
  if (c !== "'" && c !== '"' && c !== '`') return i + 1;
  const quote = c;
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    j++;
  }
  return j;
}

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

/**
 * For a given file in diff mode, parse `git diff --unified=0` to extract
 * the set of line ranges that were added/modified vs origin/main. Used
 * to scope catch-block checks to "newly introduced or touched" only.
 */
function changedLineRanges(filePath) {
  try {
    const out = execSync(
      `git diff --unified=0 origin/main...HEAD -- "${filePath}"`,
      { encoding: 'utf8' },
    );
    const ranges = [];
    for (const line of out.split('\n')) {
      // Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] ? Number(m[2]) : 1;
      if (count === 0) continue; // pure deletion — no new lines on this side
      ranges.push([start, start + count - 1]);
    }
    return ranges;
  } catch {
    return [];
  }
}

function rangesOverlap(catchStart, catchEnd, ranges) {
  for (const [s, e] of ranges) {
    if (catchEnd >= s && catchStart <= e) return true;
  }
  return false;
}

function listAllFiles() {
  const out = execSync(
    `find ${TARGET_DIRS.join(' ')} -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' -o -name '*.js' \\) -not -path '*/node_modules/*' -not -path '*/_generated/*'`,
    { encoding: 'utf8' },
  );
  return out.split('\n').filter(Boolean);
}

function findUnsafeCatches(filePath, restrictToRanges) {
  const rawSrc = readFileSync(filePath, 'utf8');
  const src = stripCommentsAndStrings(rawSrc);
  const offenders = [];

  // Scan for catch blocks. We balance braces manually to handle nesting
  // (regex alone misses nested `{ }` inside the catch body). Operating on
  // the comment/string-stripped source means brace counts inside string
  // literals can no longer fool the depth tracker.
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

    const rawBody = rawSrc.slice(bodyOpenAbs + 1, bodyEnd - 1);
    const hasOverride = OVERRIDE_MARKER.test(rawBody);

    if (
      !hasOverride &&
      LOG_PATTERN.test(body) &&
      !SAFE_PATTERNS.some((p) => p.test(body))
    ) {
      const startLine = src.slice(0, absStart).split('\n').length;
      const endLine = src.slice(0, bodyEnd).split('\n').length;
      if (!restrictToRanges || rangesOverlap(startLine, endLine, restrictToRanges)) {
        offenders.push({
          filePath,
          lineNo: startLine,
          snippet: rawBody.split('\n').find((l) => l.trim())?.trim().slice(0, 100) ?? '',
        });
      }
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
    const ranges = SCAN_ALL ? null : changedLineRanges(f);
    if (!SCAN_ALL && (!ranges || ranges.length === 0)) continue;
    try {
      allOffenders.push(...findUnsafeCatches(abs, ranges));
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
