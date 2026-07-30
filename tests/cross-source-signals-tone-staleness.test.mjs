// Regression test for issue #5478 (strand 2 follow-through): the media-tone
// deterioration extractor must not mint fresh-looking signals
// (detectedAt=now) off a days-old tone series.
//
// The per-topic gdelt:intel:tone:* keys survive up to TIMELINE_TTL (7d after
// #5478 — brownout-scale on purpose, so last-good data stays SERVABLE through
// a GDELT outage). Serving old data is fine; *signaling* off it is not: a
// week-old declining trend would keep emitting "media tone deterioration"
// cross-source signals stamped as freshly detected for days. The extractor
// must skip payloads it cannot date or that are older than the signal-grade
// window, falling through to the bundled-canonical fallback.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CII_RISK_SCORE_CACHE_KEYS } from '../scripts/_cii-risk-cache-keys.mjs';

const seedSrc = readFileSync('scripts/seed-cross-source-signals.mjs', 'utf8');

const pureSrc = seedSrc
  .replace(/^import\s.*$/gm, '')
  .replace(/loadEnvFile\([^)]+\);\r?\n/, '')
  .replace(/async function readAllSourceKeys[\s\S]*?\r?\n}\r?\n\r?\n\/\/ ── Signal extractors/m, '// readAllSourceKeys removed for unit test\n\n// ── Signal extractors')
  .replace(/runSeed\('intelligence'[\s\S]*$/m, '')
  .replace(/^export\s+(function\s+declareRecords)/m, '$1');

const ctx = vm.createContext({ console, Date, Math, Number, Array, Map, Set, String, RegExp, CII_RISK_SCORE_CACHE_KEYS });
vm.runInContext(`${pureSrc}\n;globalThis.__exports = { extractMediaToneDeterioration };`, ctx);

const { extractMediaToneDeterioration } = ctx.__exports;

const DECLINING_SERIES = [
  { date: '2026-07-18', value: -0.5 },
  { date: '2026-07-19', value: -1.2 },
  { date: '2026-07-20', value: -2.4 },
];

function tonePayload(ageMs, series = DECLINING_SERIES) {
  return { data: series, fetchedAt: new Date(Date.now() - ageMs).toISOString() };
}

describe('extractMediaToneDeterioration staleness guard', () => {
  it('emits a signal for a recent declining tone series', () => {
    const signals = extractMediaToneDeterioration({
      'gdelt:intel:tone:military': tonePayload(3600 * 1000), // 1h old
    });
    assert.equal(signals.length, 1, 'fresh declining series must still signal');
    assert.equal(signals[0].id, 'gdelt-tone:military');
  });

  it('does not signal off a tone series older than the signal-grade window', () => {
    const signals = extractMediaToneDeterioration({
      'gdelt:intel:tone:military': tonePayload(3 * 24 * 3600 * 1000), // 3 days old
    });
    assert.equal(signals.length, 0,
      'a days-old trend must not mint a fresh-looking deterioration signal (7d TTL keeps last-good servable, not signal-grade)');
  });

  it('does not signal off a payload it cannot date', () => {
    const signals = extractMediaToneDeterioration({
      'gdelt:intel:tone:military': { data: DECLINING_SERIES }, // no fetchedAt
    });
    assert.equal(signals.length, 0, 'undatable payloads are not signal-grade');
  });
});
