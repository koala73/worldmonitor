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

describe('classifyTrack — residue mode (the P1 reviewer fix + safety guard)', () => {
  // Default test setup: lastSeen 48h ago (well past the 24h default
  // staleness gate), so missing publishedAt → residue.
  const STALE_LAST_SEEN = String(NOW - 48 * HOUR);

  it('matches rows missing publishedAt AND lastSeen older than min-stale (the actual residue)', () => {
    const t = {
      title: 'Stale Pentagon item',
      link: 'https://news.google.com/x',
      lastSeen: STALE_LAST_SEEN,
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 24 * HOUR,
    });
    assert.deepEqual(r, ['residue']);
  });

  it('SAFETY: does NOT match rows missing publishedAt if lastSeen is fresh (P2 reviewer fix)', () => {
    // The reviewer-flagged risk: a legitimate recent story that just
    // hasn't had publishedAt populated yet (write race, or first cron
    // tick after deploy hasn't re-mentioned it but it WAS touched
    // recently). Must NOT be deleted.
    const t = {
      title: 'Recent legitimate story',
      lastSeen: String(NOW - 2 * HOUR), // 2h ago — well within fresh window
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 24 * HOUR,
    });
    assert.deepEqual(r, [], 'fresh lastSeen must protect the row');
  });

  it('boundary: lastSeen exactly at min-stale threshold matches (>= boundary)', () => {
    const t = {
      lastSeen: String(NOW - 24 * HOUR),
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 24 * HOUR,
    });
    assert.deepEqual(r, ['residue']);
  });

  it('boundary: lastSeen 1ms newer than threshold does NOT match', () => {
    const t = {
      lastSeen: String(NOW - 24 * HOUR + 1),
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 24 * HOUR,
    });
    assert.deepEqual(r, []);
  });

  it('matches rows with empty-string publishedAt + stale lastSeen', () => {
    const r = classifyTrack(
      { publishedAt: '', lastSeen: STALE_LAST_SEEN },
      { mode: 'residue', maxAgeMs: 0, nowMs: NOW, residueMinStaleMs: 24 * HOUR },
    );
    assert.deepEqual(r, ['residue']);
  });

  it('matches rows with literal "undefined"/"NaN" publishedAt + stale lastSeen', () => {
    assert.deepEqual(
      classifyTrack(
        { publishedAt: 'undefined', lastSeen: STALE_LAST_SEEN },
        { mode: 'residue', maxAgeMs: 0, nowMs: NOW, residueMinStaleMs: 24 * HOUR },
      ),
      ['residue'],
    );
  });

  it('does NOT match rows with a parseable publishedAt (residue is absence-of-evidence)', () => {
    const t = {
      publishedAt: String(NOW - 100 * 24 * HOUR), // 100 days old
      lastSeen: STALE_LAST_SEEN,
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 24 * HOUR,
    });
    assert.deepEqual(r, [], 'old-but-known should be caught by --mode=age, not --mode=residue');
  });

  it('treats missing lastSeen as ancient (errs toward eviction in opt-in destructive mode)', () => {
    const r = classifyTrack(
      { title: 'Anomalous row, no lastSeen' },
      { mode: 'residue', maxAgeMs: 0, nowMs: NOW, residueMinStaleMs: 24 * HOUR },
    );
    assert.deepEqual(r, ['residue']);
  });

  it('does NOT include url match in residue mode (operator opts in explicitly)', () => {
    const t = {
      link: 'https://www.defense.gov/About/Section-508/',
      lastSeen: STALE_LAST_SEEN,
    };
    const r = classifyTrack(t, {
      mode: 'residue',
      maxAgeMs: 0,
      nowMs: NOW,
      residueMinStaleMs: 24 * HOUR,
    });
    // residue matches because publishedAt is missing AND lastSeen is stale;
    // url is NOT additionally included because residue mode is
    // single-classifier by design.
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
  it('defaults to mode=url, maxAgeHours=48, residueMinStaleHours=24, apply=false', () => {
    const a = parseArgs([]);
    assert.equal(a.mode, 'url');
    assert.equal(a.maxAgeHours, 48);
    assert.equal(a.residueMinStaleHours, 24);
    assert.equal(a.apply, false);
  });

  it('--residue-min-stale-hours=N overrides default', () => {
    assert.equal(parseArgs(['--residue-min-stale-hours=48']).residueMinStaleHours, 48);
  });

  it('--residue-min-stale-hours=foo silently ignores (default kept)', () => {
    assert.equal(parseArgs(['--residue-min-stale-hours=foo']).residueMinStaleHours, 24);
  });

  it('--residue-min-stale-hours=0 ignored (positive-only)', () => {
    assert.equal(parseArgs(['--residue-min-stale-hours=0']).residueMinStaleHours, 24);
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
