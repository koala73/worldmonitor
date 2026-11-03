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

test('accepts the early-published next cohort but still rejects a far-future timestamp', () => {
  const now = Date.parse('2026-09-27T11:48:50Z');
  const early = { timestamp: '20260927120000', dyads: parseDyadExport(row('USA', 'RUS', 4)) };
  assert.equal(mergeDyadBuckets(null, [early], now).cursor, '20260927120000');
  const farFuture = { timestamp: '20260927121500', dyads: parseDyadExport(row('USA', 'RUS', 4)) };
  assert.throws(() => mergeDyadBuckets(null, [farFuture], now), /Invalid dyad cohort timestamp/);
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
    [dayOf(3)]: rebuildDyadDay(dayOf(3), cohortBatches(dayOf(3))),
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

test('a pair added to the config mid-day does not crash the live merge and is rebuilt, not scored partial', () => {
  // The day was created before usa_iran was configured, so it has no bucket.
  const previous = { cursor: '20260927120000', days: { '2026-09-27': { cohorts: 48, pairs: {
    usa_russia: { total: 0, conflict: 0, intensity: 0, toneSum: 0, toneCount: 0 },
  } } } };
  const batch = { timestamp: '20260927121500', dyads: parseDyadExport(row('USA', 'IRN', 4)) };
  const merged = mergeDyadBuckets(previous, [batch], Date.parse('2026-09-27T12:20:00Z'));
  assert.equal(merged.days['2026-09-27'].cohorts, 49);
  assert.equal(merged.days['2026-09-27'].pairs.usa_iran, undefined, 'a bucket started mid-day would be partial');
  const next = { ...merged, cursor: '20260928000000' };
  assert.ok(planDyadRepair(next, Date.parse('2026-09-28T00:20:00Z'), 5).includes('2026-09-27'),
    'a past day missing a configured pair is rebuilt');
});

test('a complete day missing only a configured pair is rebuilt with that pair', () => {
  // 96 cohorts and complete hours: the missing bucket is the only defect.
  const snapshot = { cursor: '20260928171500', days: {} };
  for (let i = 1; i <= 90; i++) snapshot.days[dayOf(i)] = rebuildDyadDay(dayOf(i), cohortBatches(dayOf(i)));
  delete snapshot.days[dayOf(2)].pairs.iran_gcc;
  delete snapshot.days[dayOf(40)].pairs.iran_gcc;
  assert.deepEqual(planDyadRepair(snapshot, repairNow, 90), [dayOf(2), dayOf(40)]);
  const rebuilt = { [dayOf(2)]: rebuildDyadDay(dayOf(2), cohortBatches(dayOf(2))), [dayOf(40)]: rebuildDyadDay(dayOf(40), cohortBatches(dayOf(40))) };
  const replaced = replaceDyadDays(snapshot, rebuilt, repairNow);
  assert.ok(replaced.days[dayOf(2)].pairs.iran_gcc && replaced.days[dayOf(40)].pairs.iran_gcc);
  assert.equal(planDyadRepair(replaced, repairNow, 90).length, 0);
});

test('Iran–GCC sums Iran against every GCC member, in both directions', () => {
  const data = parseDyadExport(['SAU', 'ARE', 'QAT', 'KWT', 'BHR', 'OMN'].flatMap(member => [row('IRN', member, 4), row(member, 'IRN', 3)])
    .concat(row('IRN', 'IRQ', 4), row('SAU', 'ARE', 4)).join('\n'));
  assert.equal(data.iran_gcc.conflict, 12);
  assert.equal(Object.values(data).reduce((sum, pair) => sum + pair.total, 0), 12, 'non-members and intra-GCC rows are not counted');
});

// Live scoring: the last 336 complete hours, so a surge counts before midnight.
const HOUR = 3_600_000;
const DAY = 86_400_000;
const liveNow = Date.parse('2026-10-24T18:20:00Z');
const liveDay = (i) => new Date(liveNow - i * DAY).toISOString().slice(0, 10);
const pinnedIds = Object.keys(parseDyadExport(''));
const emptyBucket = () => ({ total: 0, conflict: 0, intensity: 0, toneSum: 0, toneCount: 0 });
// 90 completed days and today for usa_russia, from one hourly intensity
// rate(hourStartMs): a day's bucket sums its hours, and the last 15 days keep
// them. The cursor is now's hour, which holds only its first cohort.
function liveSnapshot(rate, now = liveNow) {
  const nowHour = Math.floor(now / HOUR) * HOUR;
  const days = {};
  for (let i = 0; i <= 90; i++) {
    const start = Math.floor(now / DAY) * DAY - i * DAY;
    const hours = {};
    let intensity = 0;
    for (let ms = start; ms < start + DAY && ms <= nowHour; ms += HOUR) {
      intensity += rate(ms);
      hours[new Date(ms).toISOString().slice(11, 13)] = { cohorts: ms === nowHour ? 1 : 4, pairs: { usa_russia: [1, rate(ms)] } };
    }
    const pairs = Object.fromEntries(pinnedIds.map(id => [id, emptyBucket()]));
    pairs.usa_russia = { total: 30, conflict: 24, intensity, toneSum: 0, toneCount: 30 };
    const cohorts = i === 0 ? Object.keys(hours).length * 4 - 3 : 96;
    days[new Date(start).toISOString().slice(0, 10)] = { cohorts, pairs, ...(i < 15 && { hours }) };
  }
  return { cursor: new Date(nowHour).toISOString().replace(/\D/g, '').slice(0, 14), days };
}
const usaRussia = (snapshot, now = liveNow) => scoreDyads(snapshot, now).tensionPairs.find(pair => pair.id === 'usa_russia');
const reading = ({ score, trend, changePercent }) => ({ score, trend, changePercent });
// The 168 hours ending at 17:00, the last complete hour at liveNow, read 15;
// every earlier hour reads 10.
const lastHour = Date.parse('2026-10-24T17:00:00Z');
const weekSurge = (ms) => (ms > lastHour - 168 * HOUR ? 15 : 10);

test('a surge today moves the score and the weekly change before the day completes', () => {
  // Every completed day reads 240; today's hours through 17:00 read 1000 each.
  const today = Date.parse('2026-10-24T00:00:00Z');
  const pair = usaRussia(liveSnapshot(ms => (ms >= today ? 1000 : 10)));
  assert.equal(pair.score, 100, 'the 168-hour mean is above every daily value');
  assert.equal(pair.trend, 'TREND_DIRECTION_RISING');
  // Last 168 h: today 00-17 (18 × 1000) + 150 earlier hours × 10 = 19500,
  // against 168 × 10 = 1680 in the 168 hours before them.
  assert.equal(pair.changePercent, 1060.7);
});

test('a week-long surge reads rising against the week before it', () => {
  const pair = usaRussia(liveSnapshot(weekSurge));
  assert.equal(pair.changePercent, 50, '168 hours × 15 against 168 hours × 10');
  assert.equal(pair.trend, 'TREND_DIRECTION_RISING');
  assert.equal(pair.score, 100, 'the 168-hour mean of 360 a day matches the highest completed day');
});

test('a weekday news rhythm reads stable on a Sunday, live and from completed days', () => {
  // Weekend hours carry 0.7 of the weekday volume, the same every week.
  const sunday = Date.parse('2026-10-25T18:20:00Z');
  const rhythm = (ms) => ([0, 6].includes(new Date(ms).getUTCDay()) ? 7 : 10);
  const snapshot = liveSnapshot(rhythm, sunday);
  const live = usaRussia(snapshot, sunday);
  assert.equal(live.changePercent, 0, 'each week holds the same weekdays and weekend');
  assert.equal(live.trend, 'TREND_DIRECTION_STABLE');
  delete snapshot.days['2026-10-20'].hours['05'];
  assert.deepEqual(reading(usaRussia(snapshot, sunday)), reading(live), 'the completed days read the same two weeks');
});

test('the hour in progress waits; the window ends at the last complete hour', () => {
  // 18:00 has only its first cohort, so a value there must not count.
  const snapshot = liveSnapshot(ms => (ms === lastHour + HOUR ? 1e9 : 10));
  const pair = usaRussia(snapshot);
  assert.equal(pair.trend, 'TREND_DIRECTION_STABLE');
  assert.equal(pair.changePercent, 0);
  snapshot.cursor = '20261024174500';
  assert.equal(usaRussia(snapshot).changePercent, 0, 'the :45 cohort completes its own hour');
});

test('any unusable hour among the 336 falls the pair back to completed days, never a partial number', () => {
  // Completed days 1-6 read 360, day 7 holds 6 surge hours (270), older days
  // 240. Days 1-7 sum 2430 against 1680 for days 8-14, and their mean of
  // 347.1 is above 84 of the 90 days.
  const daily = { score: 93.3, trend: 'TREND_DIRECTION_RISING', changePercent: 44.6 };
  const oldest = liveSnapshot(weekSurge);
  oldest.days[liveDay(14)].hours['18'].cohorts = 3;
  assert.deepEqual(reading(usaRussia(oldest)), daily, 'the oldest hour of the window is partial');
  const before = liveSnapshot(weekSurge);
  before.days[liveDay(14)].hours['17'].cohorts = 3;
  assert.equal(usaRussia(before).changePercent, 50, 'an hour before the window does not matter');
  const missing = liveSnapshot(weekSurge);
  delete missing.days[liveDay(3)].hours['05'];
  assert.deepEqual(reading(usaRussia(missing)), daily);
  const newPair = liveSnapshot(weekSurge);
  delete newPair.days[liveDay(0)].pairs.usa_russia;
  assert.deepEqual(reading(usaRussia(newPair)), daily, 'a day without the pair bucket is not read hourly');
});

test('each pair reads its weekly change against its own usual weekly swing', () => {
  // Both pairs rise from 100 a day to 130 over the last 7 days, +30%. Before
  // that US–Russia held 100 a day, while US–China alternated weeks of 50 and
  // 100, so most of its weekly changes exceed 30% and +30% is ordinary for it.
  const days = {};
  const bucket = (intensity) => ({ total: 30, conflict: 20, intensity, toneSum: 0, toneCount: 30 });
  for (let i = 1; i <= 90; i++) {
    const recent = i <= 7 ? 130 : i <= 14 ? 100 : null;
    days[new Date(now - i * DAY).toISOString().slice(0, 10)] = { cohorts: 96, pairs: {
      usa_russia: bucket(recent ?? 100),
      usa_china: bucket(recent ?? (Math.floor((i - 15) / 7) % 2 ? 100 : 50)),
    } };
  }
  const scored = Object.fromEntries(scoreDyads({ days }, now).tensionPairs.map(pair => [pair.id, pair]));
  assert.equal(scored.usa_russia.changePercent, 30);
  assert.equal(scored.usa_russia.trend, 'TREND_DIRECTION_RISING', 'a calm pair keeps the 10% floor');
  assert.equal(scored.usa_china.changePercent, 30);
  assert.equal(scored.usa_china.trend, 'TREND_DIRECTION_STABLE', 'a volatile pair needs more than its usual swing');
});

test('the live merge fills hours, never completes one it joined late, and prunes old hours', () => {
  const previous = { cursor: '20261024171500', days: {
    [liveDay(0)]: { cohorts: 70, pairs: Object.fromEntries(pinnedIds.map(id => [id, emptyBucket()])) },
    [liveDay(15)]: { cohorts: 96, pairs: {}, hours: { '00': { cohorts: 4, pairs: {} } } },
    [liveDay(16)]: { cohorts: 96, pairs: {}, hours: { '00': { cohorts: 4, pairs: {} } } },
  } };
  const batches = ['20261024173000', '20261024174500', '20261024180000', '20261024181500', '20261024183000', '20261024184500']
    .map(timestamp => ({ timestamp, dyads: parseDyadExport(row('USA', 'RUS', 4, 2, -5)) }));
  const merged = mergeDyadBuckets(previous, batches, Date.parse('2026-10-24T18:50:00Z'));
  const hours = merged.days[liveDay(0)].hours;
  assert.equal(hours['17'].cohorts, 2, 'joined at :30, so 17:00 stays incomplete');
  assert.deepEqual(hours['18'], { cohorts: 4, pairs: { usa_russia: [4, 40] } });
  assert.deepEqual(merged.days[liveDay(15)].hours, { '00': { cohorts: 4, pairs: {} } }, 'hours from the last 15 days are kept');
  assert.equal(merged.days[liveDay(16)].hours, undefined, 'hours older than the window are dropped');
});

test('a recent day without complete hours is rebuilt with them; an older day is not', () => {
  const day = (date) => rebuildDyadDay(date, cohortBatches(date));
  const now = repairNow;
  const snapshot = { cursor: '20260928171500', days: {} };
  for (let i = 1; i <= 90; i++) snapshot.days[dayOf(i)] = day(dayOf(i));
  assert.equal(Object.keys(snapshot.days[dayOf(1)].hours).length, 24);
  assert.equal(planDyadRepair(snapshot, now, 90).length, 0);
  delete snapshot.days[dayOf(15)].hours;
  delete snapshot.days[dayOf(16)].hours;
  assert.deepEqual(planDyadRepair(snapshot, now, 90), [dayOf(15)]);
  snapshot.days[dayOf(20)].cohorts = 95;
  const replaced = replaceDyadDays(snapshot, { [dayOf(15)]: day(dayOf(15)), [dayOf(20)]: day(dayOf(20)) }, now);
  assert.equal(Object.keys(replaced.days[dayOf(15)].hours).length, 24);
  assert.equal(replaced.days[dayOf(20)].hours, undefined, 'an older rebuilt day keeps no hours');
});

test('each configured country pair is counted by its own pair', async () => {
  const { default: config } = await import('../scripts/shared/gdelt-tension-pairs.json', { with: { type: 'json' } });
  for (const pair of config) {
    const [left, right] = pair.actors.map(side => [side].flat());
    for (const a of left) for (const b of right) {
      const counts = parseDyadExport([row(a, b, 4), row(b, a, 3)].join('\n'));
      assert.equal(counts[pair.id].conflict, 2, `${a}–${b} counts for ${pair.id} in both directions`);
    }
  }
});
