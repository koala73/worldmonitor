// Static-analysis regression test for server/worldmonitor/news/v1/_feeds.ts.
//
// Every Google-News-backed feed (calls to `gn(...)`) MUST carry a `when:Nd`
// time gate. Without one, Google News returns any indexed page on the target
// domain — including static institutional landing pages with no temporal
// relevance — which is the contamination class that landed three Pentagon
// static pages in user_3BovQ1tYlaz2YIGYAdDPXGFBgKy's brief 2026-04-25-2001.
//
// See: docs/plans/2026-04-26-001-fix-brief-static-page-contamination-plan.md
// (R1, U1).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const feedsSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/_feeds.ts'),
  'utf-8',
);

// Match every literal `url: gn('...')` call in the registry.
// `gn` is only ever used as `url: gn('...')` in this file, so this also
// catches future feed additions.
const GN_CALL_RE = /url:\s*gn\(\s*'([^']+)'\s*\)/g;

describe('_feeds.ts time-gate enforcement', () => {
  it('every gn() call carries a when:Nd clause', () => {
    const offenders: Array<{ query: string; line: number }> = [];

    // Recompute line number for each match by counting newlines up to its index.
    let match;
    GN_CALL_RE.lastIndex = 0;
    while ((match = GN_CALL_RE.exec(feedsSrc)) !== null) {
      const query = match[1] ?? '';
      // Accept when:1d through when:99d (single or two-digit day count).
      // Tolerant of arbitrary placement within the query string.
      if (!/\bwhen:\d{1,2}d\b/.test(query)) {
        const line = feedsSrc.slice(0, match.index).split('\n').length;
        offenders.push({ query, line });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Found ${offenders.length} gn() call(s) without a when:Nd time gate. ` +
        `Without when:Nd, Google News surfaces static institutional pages from ` +
        `the target domain. Add when:1d (daily news), when:3d (slower-cadence ` +
        `news), or when:7d (think-tank analysis) per the cadence of the source. ` +
        `Offenders: ${JSON.stringify(offenders, null, 2)}`,
    );
  });

  it('finds at least one gn() call (sanity check on the regex)', () => {
    GN_CALL_RE.lastIndex = 0;
    const matches = [...feedsSrc.matchAll(GN_CALL_RE)];
    assert.ok(
      matches.length >= 10,
      `Expected at least 10 gn() calls in _feeds.ts; found ${matches.length}. ` +
        `If the registry shape changed (e.g., feeds moved to a different ` +
        `module), update the regex or this assertion.`,
    );
  });
});
