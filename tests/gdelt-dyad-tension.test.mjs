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

// Self-repair: rebuild incomplete past days from the source exports so a
// partial first day or a missed cohort cannot block scoring for 90 days.
const dyadModule = await import('../scripts/_gdelt-dyad-tension.mjs');
const { planDyadRepair, dyadDayExportTimestamps, rebuildDyadDay, replaceDyadDays } = dyadModule;
const repairNow = Date.parse('2026-09-28T17:30:00Z');
const dayOf = (i) => new Date(repairNow - i * 86400000).toISOString().slice(0, 10);
const cohortBatches = (date, count = 96, conflict = 1) => dyadDayExportTimestamps(date).slice(0, count)
  .map(timestamp => ({ timestamp, dyads: parseDyadExport(Array.from({ length: conflict }, () => row('USA', 'RUS', 4)).join('\n')) }));

test('the repair plan targets incomplete past days in the scoring window, newest first', () => {
  const snapshot = { cursor: '20260928171500', days: {
    '2026-09-28': { cohorts: 70, pairs: {} },
    '2026-09-27': { cohorts: 15, pairs: {} },
    [dayOf(3)]: { cohorts: 96, pairs: {} },
    [dayOf(91)]: { cohorts: 3, pairs: {} },
  } };
  const plan = planDyadRepair(snapshot, repairNow, 200);
  assert.equal(plan[0], '2026-09-27', 'the partial first day is repaired');
  assert.equal(plan[1], dayOf(2), 'a missing day is repaired');
  assert.ok(!plan.includes('2026-09-28'), 'today is still being filled live');
  assert.ok(!plan.includes(dayOf(3)), 'a complete day is left alone');
  assert.ok(plan.includes(dayOf(90)) && !plan.includes(dayOf(91)), 'the window matches scoreDyads');
  assert.equal(plan.length, 89);
  assert.deepEqual(planDyadRepair(snapshot, repairNow, 2), ['2026-09-27', dayOf(2)]);
});

test('the repair plan never touches a day the live merge can still add cohorts to', () => {
  const days = { '2026-09-27': { cohorts: 15, pairs: {} } };
  assert.ok(!planDyadRepair({ cursor: '20260927234500', days }, repairNow, 5).includes('2026-09-27'));
  assert.ok(planDyadRepair({ cursor: '20260928000000', days }, repairNow, 5).includes('2026-09-27'));
  assert.deepEqual(planDyadRepair({ cursor: '', days }, repairNow, 5), [], 'no live cursor, no repair');
  assert.deepEqual(planDyadRepair(null, repairNow, 5), []);
});

test('a day is expected to hold exactly the 96 quarter-hour export cohorts', () => {
  const stamps = dyadDayExportTimestamps('2026-09-27');
  assert.equal(stamps.length, 96);
  assert.equal(stamps[0], '20260927000000');
  assert.equal(stamps.at(-1), '20260927234500');
});

test('a rebuilt day replaces a partial day wholesale instead of adding to it', () => {
  const partial = mergeDyadBuckets(null, cohortBatches('2026-09-27', 15, 3), repairNow);
  const snapshot = { ...partial, cursor: '20260928171500' };
  assert.equal(snapshot.days['2026-09-27'].pairs.usa_russia.conflict, 45);
  const rebuilt = rebuildDyadDay('2026-09-27', cohortBatches('2026-09-27'));
  assert.equal(rebuilt.cohorts, 96);
  const repaired = replaceDyadDays(snapshot, { '2026-09-27': rebuilt }, repairNow);
  assert.equal(repaired.days['2026-09-27'].cohorts, 96);
  assert.equal(repaired.days['2026-09-27'].pairs.usa_russia.conflict, 96, 'not 96 + 45');
  assert.equal(repaired.cursor, snapshot.cursor, 'the live cursor is untouched');
});

test('a rebuild refuses anything but the 96 cohorts of its own day', () => {
  assert.throws(() => rebuildDyadDay('2026-09-27', cohortBatches('2026-09-27', 95)), /96/);
  const foreign = cohortBatches('2026-09-27');
  foreign[5] = { ...foreign[5], timestamp: '20260926120000' };
  assert.throws(() => rebuildDyadDay('2026-09-27', foreign), /96/);
  const duplicate = cohortBatches('2026-09-27');
  duplicate[5] = { ...duplicate[5], timestamp: duplicate[4].timestamp };
  assert.throws(() => rebuildDyadDay('2026-09-27', duplicate), /96/);
});

test('a replacement is ignored for days the live merge still owns or the window has dropped', () => {
  const snapshot = { cursor: '20260927234500', days: {} };
  const rebuilt = rebuildDyadDay('2026-09-27', cohortBatches('2026-09-27'));
  assert.deepEqual(replaceDyadDays(snapshot, { '2026-09-27': rebuilt }, repairNow).days, {});
  const old = dayOf(91);
  const late = { cursor: '20260928171500', days: {} };
  assert.deepEqual(replaceDyadDays(late, { [old]: rebuildDyadDay(old, cohortBatches(old)) }, repairNow).days, {});
});

test('a day that recently failed repair backs off, then becomes eligible again', () => {
  const { DYAD_REPAIR_BACKOFF_MS } = dyadModule;
  const failedAt = repairNow - 60_000;
  const snapshot = { cursor: '20260928171500', days: {}, repairFailures: { '2026-09-27': failedAt } };
  assert.ok(!planDyadRepair(snapshot, repairNow, 90).includes('2026-09-27'), 'inside the backoff it is skipped');
  assert.equal(planDyadRepair(snapshot, repairNow, 1)[0], dayOf(2), 'the next older day takes the slot');
  const later = failedAt + DYAD_REPAIR_BACKOFF_MS;
  assert.equal(planDyadRepair(snapshot, later, 1)[0], '2026-09-27', 'after the backoff it is retried');
});

test('repair failures are recorded, cleared on success, and pruned to repairable days', () => {
  const snapshot = { cursor: '20260928171500', days: {}, repairFailures: {
    '2026-09-27': repairNow - 1000,
    [dayOf(2)]: repairNow - 2000,
    [dayOf(95)]: repairNow - 3000,
  } };
  const rebuilt = { '2026-09-27': rebuildDyadDay('2026-09-27', cohortBatches('2026-09-27')) };
  const next = replaceDyadDays(snapshot, rebuilt, repairNow, { [dayOf(3)]: repairNow });
  assert.deepEqual(next.repairFailures, { [dayOf(2)]: repairNow - 2000, [dayOf(3)]: repairNow });
  assert.equal(replaceDyadDays({ cursor: '20260928171500', days: {} }, {}, repairNow).repairFailures, undefined,
    'no failure record is added when nothing failed');
});

test('once repair completes the 90-day window, every pair with enough events is scored', () => {
  let snapshot = { cursor: '20260928171500', days: {} };
  const rebuilt = {};
  for (const date of planDyadRepair(snapshot, repairNow, 90)) rebuilt[date] = rebuildDyadDay(date, cohortBatches(date, 96, 1));
  snapshot = replaceDyadDays(snapshot, rebuilt, repairNow);
  assert.equal(planDyadRepair(snapshot, repairNow, 90).length, 0);
  const scored = scoreDyads(snapshot, repairNow);
  assert.ok(scored.tensionPairs.some(pair => pair.id === 'usa_russia'));
});
