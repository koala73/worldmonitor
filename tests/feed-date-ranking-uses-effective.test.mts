/**
 * Static guardrail: every ranking/recency consumer of feed-item pubDate in
 * `src/services/` and `src/app/` MUST route through `effectivePubDateMs`
 * from `src/services/feed-date.ts`. Without this guard, a future ranking
 * call site could silently call `item.pubDate.getTime()` directly and
 * re-introduce the false-freshness bug U3 fixed.
 *
 * Audit shape: walks .ts files under src/services/ and src/app/, finds
 * every line containing `.pubDate.getTime()` inside a freshness comparator
 * or recency gate, and fails if that line doesn't ALSO reference
 * `effectivePubDateMs`. Files have an explicit per-line allow-list with
 * documented reasons for legitimate non-ranking uses (metadata storage,
 * identity keys, embedding index timestamps).
 *
 * Self-fixture: also pins the regex against synthetic samples for both
 * the sort-comparator shape (`b.pubDate.getTime() - a.pubDate.getTime()`)
 * AND the recency-gate shape (`Date.now() - item.pubDate.getTime() <
 * windowMs`), so a future regex simplification cannot silently stop
 * matching one of them. Pattern source: skill
 * `test-ci-gotchas/reference/static-grep-audit-test-undertested-by-only-
 * matching-one-shape`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const SCAN_DIRS = ['src/services', 'src/app'];

// Files (path, line number) that legitimately use raw .pubDate.getTime()
// for NON-ranking purposes — metadata storage, identity key generation,
// embedding index timestamps. Each entry MUST carry a reason. The audit
// fails if a listed (file,line) no longer matches — i.e., either the line
// moved (forcing review of whether it's still legitimate) or the file
// removed the line (allow-list can be trimmed).
interface AllowEntry {
  file: string;
  line: number;
  reason: string;
}

const ALLOW_LIST: AllowEntry[] = [
  {
    file: 'src/services/rss.ts',
    line: 315,
    reason: 'mlWorker.vectorStoreIngest stores pubDate as embedding metadata; not used as a freshness comparator.',
  },
  {
    file: 'src/services/feed-date.ts',
    line: 72,
    reason: 'effectivePubDateMs implementation — the helper itself necessarily calls .getTime() on the underlying Date.',
  },
  {
    file: 'src/services/feed-date.ts',
    line: 83,
    reason: 'effectivePubDateMs implementation — string-input branch reconstructs Date and reads getTime; covered by NaN/Infinity guard immediately below.',
  },
  {
    file: 'src/services/analysis-core.ts',
    line: 207,
    reason: 'generateClusterId sort produces a stable identity string from earliest pubDate; not a freshness comparator.',
  },
  {
    file: 'src/services/analysis-core.ts',
    line: 209,
    reason: 'generateClusterId uses earliest pubDate.getTime() in the identity string prefix.',
  },
  {
    file: 'src/services/analysis-core.ts',
    line: 297,
    reason: 'cluster date aggregation for firstSeen/lastUpdated metadata; not a per-item ranking comparator.',
  },
  {
    file: 'src/services/clustering.ts',
    line: 116,
    reason: 'allDates aggregation for cluster firstSeen/lastUpdated metadata; not a per-item ranking comparator.',
  },
  {
    file: 'src/services/trending-keywords.ts',
    line: 271,
    reason: 'headlineKey identity computation — used for dedupe, not freshness ranking.',
  },
  {
    file: 'src/services/trending-keywords.ts',
    line: 390,
    reason: 'publishedAt record-keeping in headline registry; not a freshness comparator.',
  },
  {
    file: 'src/app/data-loader.ts',
    line: 3331,
    reason: 'Cache serialization step — wraps pubDate.getTime() into the persisted entry payload, not a comparator.',
  },
];

// Match three shapes that all flow item.pubDate into a comparator:
//   (a) item.pubDate.getTime()      — direct
//   (b) item.pubDate?.getTime()     — optional chain (idiomatic TS 4+)
//   (c) new Date(item.pubDate).getTime()  — wrap-then-getTime (real-world
//                                          bypass found in country-intel.ts
//                                          and several other src/app/ sites)
// The negative-coverage tests below pin each shape so a future regex tweak
// can't silently drop one. NOTE: paren-wrapped reads (`(item.pubDate).
// getTime()`), aliased reads (`const t = item.pubDate; t.getTime()`), and
// destructured reads (`const { pubDate } = item; pubDate.getTime()`) still
// bypass this regex. They're documented residual risk — adopting AST-level
// analysis (ts-morph or @typescript-eslint) would close them but is out of
// scope here.
const PUBDATE_GETTIME_RE = /(?:\.pubDate\s*\??\s*\.\s*getTime\s*\(\s*\)|new\s+Date\s*\([^)]*\bpubDate[^)]*\)\s*\.\s*getTime\s*\(\s*\))/;
const EFFECTIVE_HELPER_RE = /effectivePubDateMs\b/;

function listTsFiles(dir: string): string[] {
  const abs = resolve(repoRoot, dir);
  const out: string[] = [];
  for (const entry of readdirSync(abs)) {
    const full = resolve(abs, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(relative(repoRoot, full)));
      continue;
    }
    if (!stat.isFile()) continue;
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
    out.push(relative(repoRoot, full));
  }
  return out;
}

function isAllowed(file: string, line: number): boolean {
  return ALLOW_LIST.some((a) => a.file === file && a.line === line);
}

describe('feed-date freshness guardrail — effectivePubDateMs usage', () => {
  it('every .pubDate.getTime() in src/services + src/app is helper-routed or explicitly allow-listed', () => {
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const dir of SCAN_DIRS) {
      for (const file of listTsFiles(dir)) {
        const src = readFileSync(resolve(repoRoot, file), 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i]!;
          if (!PUBDATE_GETTIME_RE.test(text)) continue;
          // Skip JSDoc / line comments — these aren't executing code. A line
          // beginning with `*` (JSDoc continuation) or `//` (line comment)
          // is documentation, not a ranking call site. Block comments that
          // contain the pattern on their own line (e.g. `* Returns ... .pubDate.
          // getTime()`) are caught here too.
          const trimmed = text.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
          if (EFFECTIVE_HELPER_RE.test(text)) continue; // helper invoked nearby
          if (isAllowed(file, i + 1)) continue;
          violations.push({ file, line: i + 1, text: trimmed });
        }
      }
    }

    if (violations.length > 0) {
      const lines = violations.map(
        (v) => `  ${v.file}:${v.line}\n    ${v.text}`,
      );
      assert.fail(
        `Found ${violations.length} raw .pubDate.getTime() call(s) in ranking/recency code that ` +
          `do not route through effectivePubDateMs from src/services/feed-date.ts.\n\n` +
          `Either:\n` +
          `  1. Replace with effectivePubDateMs(item) so items with pubDateMissing get 0 and ` +
          `fail freshness gates (recommended for any sort or recency check), OR\n` +
          `  2. If this is a legitimate non-ranking use (metadata storage, identity key, ` +
          `embedding index), add an entry to ALLOW_LIST in this test with a documented reason.\n\n` +
          `Violations:\n${lines.join('\n')}`,
      );
    }
  });

  it('every ALLOW_LIST entry still matches a real line (catches drift)', () => {
    const stale: string[] = [];
    for (const entry of ALLOW_LIST) {
      const src = readFileSync(resolve(repoRoot, entry.file), 'utf8');
      const lines = src.split('\n');
      const line = lines[entry.line - 1];
      // Comments don't count as legitimate allow-list anchors — they don't
      // execute. A pin to a comment line is always wrong.
      const trimmed = line?.trim() ?? '';
      const isComment = trimmed.startsWith('*') || trimmed.startsWith('//');
      if (!line || !PUBDATE_GETTIME_RE.test(line) || isComment) {
        stale.push(
          `${entry.file}:${entry.line} — allow-list entry no longer matches an executable .pubDate.getTime() call. ` +
            `Either the line moved (re-pin) or it was removed (drop from allow-list). Reason was: ${entry.reason}`,
        );
      }
    }
    if (stale.length > 0) {
      assert.fail(`Stale allow-list entries:\n${stale.map((s) => `  - ${s}`).join('\n')}`);
    }
  });

  // Self-fixtures: prove the regex matches EVERY shape it claims to and
  // does NOT match unrelated patterns. Without these, a future regex
  // simplification could silently stop matching one shape, and the audit
  // would pass coincidentally because today's codebase happens to not
  // have a violation in that shape. Each shape below is a real-world
  // form a developer is likely to write — country-intel.ts:297 shipped a
  // `new Date(item.pubDate).getTime()` bypass that the original 2-shape
  // self-fixture would have missed.
  it('PUBDATE_GETTIME_RE matches the direct sort-comparator shape', () => {
    const sample = 'items.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());';
    assert.ok(PUBDATE_GETTIME_RE.test(sample));
  });

  it('PUBDATE_GETTIME_RE matches the recency-gate shape', () => {
    const sample = 'if (Date.now() - item.pubDate.getTime() < windowMs) {}';
    assert.ok(PUBDATE_GETTIME_RE.test(sample));
  });

  it('PUBDATE_GETTIME_RE matches the optional-chain shape', () => {
    const sample = 'const ts = item.pubDate?.getTime() ?? 0;';
    assert.ok(PUBDATE_GETTIME_RE.test(sample));
  });

  it('PUBDATE_GETTIME_RE matches the new-Date-wrap shape', () => {
    const sample = 'return new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime();';
    assert.ok(PUBDATE_GETTIME_RE.test(sample));
  });

  it('PUBDATE_GETTIME_RE does NOT match unrelated getTime calls', () => {
    const sample = 'const t = otherDate.getTime();';
    assert.ok(!PUBDATE_GETTIME_RE.test(sample));
  });

  it('PUBDATE_GETTIME_RE does NOT match new Date() over an unrelated field', () => {
    const sample = 'const t = new Date(item.endDate).getTime();';
    assert.ok(!PUBDATE_GETTIME_RE.test(sample));
  });

  it('EFFECTIVE_HELPER_RE matches a comparator using the helper', () => {
    const sample = 'items.sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a));';
    assert.ok(EFFECTIVE_HELPER_RE.test(sample));
  });
});
