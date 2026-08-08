// Pure-function tests for the audit script's classifier + arg parser.
// The Redis side (scanKeys, batchHgetAll, batchDel, main) is covered
// only by manual dry-run invocation per the runbook in the script header.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrack,
  parseArgs,
} from '../scripts/audit-static-page-contamination.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 3, 26, 8, 0, 0);

describe('classifyTrack — url mode', () => {
  it('matches institutional static page URL', () => {
    const t = { link: 'https://www.defense.gov/About/Section-508/' };
    const r = classifyTrack(t, { mode: 'url', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, ['url']);
  });

  it('does not match a real news article on the same host', () => {
    const t = { link: 'https://www.defense.gov/News/Releases/Release/Article/4123456/x/' };
    const r = classifyTrack(t, { mode: 'url', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, []);
  });

  it('does not match Google News redirect URLs (the structural blind spot)', () => {
    const t = { link: 'https://news.google.com/rss/articles/CBMi.../?oc=5' };
    const r = classifyTrack(t, { mode: 'url', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, []);
  });

  it('handles missing link defensively', () => {
    const r = classifyTrack({}, { mode: 'url', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, []);
  });
});

describe('classifyTrack — age mode', () => {
  it('matches a row whose publishedAt is older than the cutoff', () => {
    const t = { publishedAt: String(NOW - 60 * HOUR) }; // 60h old
    const r = classifyTrack(t, { mode: 'age', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, ['age']);
  });

  it('does NOT match a fresh row', () => {
    const t = { publishedAt: String(NOW - 12 * HOUR) }; // 12h old
    const r = classifyTrack(t, { mode: 'age', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, []);
  });

  it('does NOT match rows missing publishedAt (legacy back-compat — use --mode=residue)', () => {
    const t = { link: 'https://news.google.com/x' };
    const r = classifyTrack(t, { mode: 'age', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, []);
  });

  it('does NOT match rows with unparseable publishedAt', () => {
    const t = { publishedAt: 'undefined' };
    const r = classifyTrack(t, { mode: 'age', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, []);
  });
});

describe('classifyTrack — residue mode (P1 + weekly-user safety guard)', () => {
  // Default residueMinStaleMs is 192h (8d = 7d max digest window + 24h
  // buffer). Aligns with the readTimeAgeCutoffMs formula in
  // digest-orchestration-helpers.mjs so residue mode never deletes a row
  // still legitimately ship-able for ANY user (daily, twice-daily,
  // weekly).
  const RESIDUE_DEFAULT_MS = 192 * HOUR;
  const ANCIENT_LAST_SEEN = String(NOW - 200 * HOUR); // 200h > 192h default

  it('matches rows missing publishedAt AND lastSeen older than min-stale', () => {
    const t = {
      title: 'Stale Pentagon item',
      link: 'https://news.google.com/x',
      lastSeen: ANCIENT_LAST_SEEN,
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(r, ['residue']);
  });

  it('SAFETY: does NOT match weekly-user 5d-old story (P2 round-2 reviewer fix)', () => {
    // The reviewer-flagged regression: a pre-PR-3422 row with no
    // publishedAt but lastSeen 5 days ago is still legitimately
    // ship-able for a weekly user (whose readTimeAgeCutoffMs is
    // windowStart - 24h = 8d ago). Earlier 24h default would have
    // deleted it. Default 192h aligns with weekly-user window and
    // protects it.
    const t = {
      title: 'Weekly-user legitimate story',
      lastSeen: String(NOW - 5 * 24 * HOUR), // 5d ago, within weekly window
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(
      r,
      [],
      '5d-old lastSeen must be PROTECTED — weekly users still need this row',
    );
  });

  it('SAFETY: does NOT match recent (2h) lastSeen even when publishedAt is missing', () => {
    // Original P2 review case: row touched recently, publishedAt missing
    // due to write race. Must NOT be deleted.
    const t = {
      title: 'Just-touched row',
      lastSeen: String(NOW - 2 * HOUR),
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(r, [], 'fresh lastSeen must protect the row');
  });

  it('boundary: lastSeen exactly at min-stale threshold matches (>= boundary)', () => {
    const t = {
      lastSeen: String(NOW - RESIDUE_DEFAULT_MS),
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(r, ['residue']);
  });

  it('boundary: lastSeen 1ms newer than threshold does NOT match', () => {
    const t = {
      lastSeen: String(NOW - RESIDUE_DEFAULT_MS + 1),
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(r, []);
  });

  it('matches rows with empty-string publishedAt + ancient lastSeen', () => {
    const r = classifyTrack(
      { publishedAt: '', lastSeen: ANCIENT_LAST_SEEN },
      { mode: 'residue', maxAgeMs: 0, nowMs: NOW, residueMinStaleMs: RESIDUE_DEFAULT_MS },
    );
    assert.deepEqual(r, ['residue']);
  });

  it('matches rows with literal "undefined"/"NaN" publishedAt + ancient lastSeen', () => {
    assert.deepEqual(
      classifyTrack(
        { publishedAt: 'undefined', lastSeen: ANCIENT_LAST_SEEN },
        { mode: 'residue', maxAgeMs: 0, nowMs: NOW, residueMinStaleMs: RESIDUE_DEFAULT_MS },
      ),
      ['residue'],
    );
  });

  it('does NOT match rows with a parseable publishedAt (residue is absence-of-evidence)', () => {
    const t = {
      publishedAt: String(NOW - 100 * 24 * HOUR), // 100 days old
      lastSeen: ANCIENT_LAST_SEEN,
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(r, [], 'old-but-known should be caught by --mode=age, not --mode=residue');
  });

  it('treats missing lastSeen as ancient (errs toward eviction in opt-in destructive mode)', () => {
    const r = classifyTrack(
      { title: 'Anomalous row, no lastSeen' },
      { mode: 'residue', maxAgeMs: 0, nowMs: NOW, residueMinStaleMs: RESIDUE_DEFAULT_MS },
    );
    assert.deepEqual(r, ['residue']);
  });

  it('does NOT include url match in residue mode (operator opts in explicitly)', () => {
    const t = {
      link: 'https://www.defense.gov/About/Section-508/',
      lastSeen: ANCIENT_LAST_SEEN,
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: RESIDUE_DEFAULT_MS,
    });
    assert.deepEqual(r, ['residue']);
  });

  it('operator can override to 48h for daily-only fleet (--residue-min-stale-hours=48)', () => {
    // Documented escape hatch in the script header: operators with
    // confidence the fleet is daily-only can drop to 48h for faster
    // cleanup. Verify the override works.
    const t = {
      lastSeen: String(NOW - 60 * HOUR), // 60h — past 48h, within 192h default
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 48 * HOUR,
    });
    assert.deepEqual(r, ['residue']);
  });
});

describe('classifyTrack — both mode (url ∪ age)', () => {
  it('matches when both signals fire (institutional URL AND stale)', () => {
    const t = {
      link: 'https://www.defense.gov/About/Section-508/',
      publishedAt: String(NOW - 60 * HOUR),
    };
    const r = classifyTrack(t, { mode: 'both', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r.sort(), ['age', 'url']);
  });

  it('matches on URL alone when publishedAt is fresh', () => {
    const t = {
      link: 'https://www.defense.gov/About/Section-508/',
      publishedAt: String(NOW - 1 * HOUR),
    };
    const r = classifyTrack(t, { mode: 'both', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, ['url']);
  });

  it('matches on age alone when URL is non-institutional', () => {
    const t = {
      link: 'https://news.google.com/x',
      publishedAt: String(NOW - 60 * HOUR),
    };
    const r = classifyTrack(t, { mode: 'both', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, ['age']);
  });

  it('does NOT include residue (residue is opt-in via --mode=residue only)', () => {
    const t = {
      link: 'https://www.defense.gov/About/Section-508/',
      // No publishedAt
    };
    const r = classifyTrack(t, { mode: 'both', maxAgeMs: 48 * HOUR, nowMs: NOW });
    assert.deepEqual(r, ['url'], 'residue must NOT be included unless mode=residue');
  });
});

describe('parseArgs — flag handling', () => {
  it('defaults to mode=url, maxAgeHours=48, residueMinStaleHours=192, apply=false', () => {
    // residueMinStaleHours = 192h = 7d max digest window + 24h buffer.
    // Aligns with the readTimeAgeCutoffMs formula in
    // digest-orchestration-helpers.mjs so residue mode never deletes a
    // row still legitimately ship-able for any user (incl. weekly).
    const a = parseArgs([]);
    assert.equal(a.mode, 'url');
    assert.equal(a.maxAgeHours, 48);
    assert.equal(a.residueMinStaleHours, 192);
    assert.equal(a.apply, false);
  });

  it('--residue-min-stale-hours=N overrides default (e.g. 48 for daily-only fleet)', () => {
    assert.equal(parseArgs(['--residue-min-stale-hours=48']).residueMinStaleHours, 48);
  });

  it('--residue-min-stale-hours=foo silently ignores (default kept)', () => {
    assert.equal(parseArgs(['--residue-min-stale-hours=foo']).residueMinStaleHours, 192);
  });

  it('--residue-min-stale-hours=0 ignored (positive-only)', () => {
    assert.equal(parseArgs(['--residue-min-stale-hours=0']).residueMinStaleHours, 192);
  });

  it('--apply flips to true', () => {
    assert.equal(parseArgs(['--apply']).apply, true);
  });

  it('--mode=age | --mode=both | --mode=residue all accepted', () => {
    assert.equal(parseArgs(['--mode=age']).mode, 'age');
    assert.equal(parseArgs(['--mode=both']).mode, 'both');
    assert.equal(parseArgs(['--mode=residue']).mode, 'residue');
  });

  it('--max-age-hours=N accepts positive integer', () => {
    assert.equal(parseArgs(['--max-age-hours=24']).maxAgeHours, 24);
  });

  it('--max-age-hours=foo silently ignores (default kept)', () => {
    assert.equal(parseArgs(['--max-age-hours=foo']).maxAgeHours, 48);
  });

  it('--max-age-hours=0 ignored (positive-only)', () => {
    assert.equal(parseArgs(['--max-age-hours=0']).maxAgeHours, 48);
  });

  it('rejects unknown args by exiting (the P3 footgun fix)', () => {
    // parseArgs calls process.exit(2) on unknown args. Capture by spawning
    // a subprocess instead of letting it kill the test process.
    // Inline subprocess spawn via Node's worker_threads is overkill; a
    // simpler way is to monkey-patch process.exit + console.error and
    // restore. Keep the assertion shape simple: invocation throws via
    // the patched exit.
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    let errMsg = '';
    process.exit = ((code) => {
      exitCode = code;
      throw new Error('__patched_exit__');
    });
    console.error = (...args) => { errMsg += args.join(' ') + '\n'; };
    try {
      assert.throws(() => parseArgs(['--mode', 'age']), /__patched_exit__/);
      assert.equal(exitCode, 2);
      assert.match(errMsg, /Unknown args/);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });

  it('rejects --mode=invalid (out-of-set value)', () => {
    const origExit = process.exit;
    const origErr = console.error;
    let exitCode = null;
    process.exit = ((code) => {
      exitCode = code;
      throw new Error('__patched_exit__');
    });
    console.error = () => {};
    try {
      assert.throws(() => parseArgs(['--mode=invalid']), /__patched_exit__/);
      assert.equal(exitCode, 2);
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
  });
});
