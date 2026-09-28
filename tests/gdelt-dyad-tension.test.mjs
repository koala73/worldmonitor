import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDyadExport, mergeDyadBuckets } from '../scripts/_gdelt-dyad-tension.mjs';

function row(a, b, quad, mentions = 2, goldstein = -5, tone = -3) {
  const fields = Array(61).fill('');
  for (const [index, value] of [[7, a], [17, b], [29, quad], [30, goldstein], [31, mentions], [34, tone]]) fields[index] = String(value);
  return fields.join('\t');
}

test('counts both directions, all events, conflict classes and mentions-weighted intensity', () => {
  const data = parseDyadExport([
    row('USA', 'RUS', 3), row('RUS', 'USA', 4, 3, -2, 1),
    row('USA', 'RUS', 1), row('USA', 'RUS', 2),
    row('USA', 'RUS', 4, 4, 2), row('USA', 'FRA', 4),
  ].join('\n'));
  assert.deepEqual(data.usa_russia, { total: 5, conflict: 3, intensity: 16, toneSum: -11, toneCount: 5 });
  assert.equal(Object.values(data).reduce((sum, pair) => sum + pair.total, 0), 5);
});

test('replayed cohorts do not count twice, and UTC buckets older than 90 completed days expire', () => {
  const now = Date.parse('2026-09-27T12:15:00Z');
  const batch = { timestamp: '20260927120000', dyads: parseDyadExport(row('USA', 'RUS', 4)) };
  const first = mergeDyadBuckets(null, [batch], now);
  assert.deepEqual(mergeDyadBuckets(first, [batch], now), first);
  const aged = mergeDyadBuckets(first, [], now + 92 * 86400000);
  assert.deepEqual(aged.days, {});
});

const { scoreDyads } = await import('../scripts/_gdelt-dyad-tension.mjs');
const now = Date.parse('2026-09-27T12:00:00Z');
function history(value) {
  const days = {};
  for (let i = 1; i <= 90; i++) {
    const date = new Date(now - i * 86400000).toISOString().slice(0, 10);
    days[date] = { cohorts: 96, pairs: { usa_russia: { total: 30, conflict: 20, intensity: value(i), toneSum: 0, toneCount: 30 } } };
  }
  return { days };
}
test('90-day percentile puts a median week near 50 and maximum week at 100', () => {
  const median = scoreDyads(history(i => i <= 7 ? 45 : i), now).tensionPairs[0];
  assert.ok(median.score >= 45 && median.score <= 55);
  assert.equal(scoreDyads(history(i => i <= 7 ? 100 : i), now).tensionPairs[0].score, 100);
});
test('thin or incomplete history is insufficient, not zero tension', () => {
  const data = history(() => 10);
  data.days['2026-09-26'].pairs.usa_russia.conflict = 0;
  assert.equal(scoreDyads(data, now).tensionPairs.length, 0);
  const missing = history(() => 10);
  missing.days['2026-09-26'].cohorts = 95;
  assert.equal(scoreDyads(missing, now).tensionPairs.length, 0);
});
test('trend uses unrounded change and strict plus/minus 10 percent thresholds', () => {
  for (const [value, expected] of [[110, 'STABLE'], [110.1, 'RISING'], [90, 'STABLE'], [89.9, 'FALLING']]) {
    const pair = scoreDyads(history(i => i <= 7 ? value : 100), now).tensionPairs[0];
    assert.equal(pair.trend, `TREND_DIRECTION_${expected}`);
  }
});
