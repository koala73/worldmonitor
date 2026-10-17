// #9097: label calibration. The digest logs each new story's first coverage
// label and every later change; the seeder folds a cohort day's events into one
// immutable record once its stories have passed + 7 days, and publishes a
// monthly table with n on every row. These tests drive the rules with fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CALIBRATION_EVENTS_MAX,
  CALIBRATION_LOW_N,
  FACT_CHECK_STATUS,
  LABEL_CALIBRATION_KEY,
  buildCalibrationTable,
  buildCohortDay,
  calibrationDayKey,
  calibrationEventsKey,
  calibrationMonths,
  dayStartMs,
  encodeCalibrationEvent,
  eventDaysFor,
  finalizableDays,
  parseCalibrationEvent,
  parseCalibrationTable,
  parseCohortDay,
  type CalibrationEvent,
} from '../shared/label-calibration.js';
import {
  UNCONFIRMED_PREFIX,
  UNTRACKED_LABEL,
  calibrationEventCommands,
  calibrationEventFor,
  keepUnloggedMoves,
  labelChangeCommands,
  labelChangeFor,
  storyLabel,
} from '../server/_shared/label-history.ts';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';
import { listLabelChanges } from '../server/worldmonitor/news/v1/list-label-changes.ts';
import {
  LABEL_CALIBRATION_ACTIVATION_KEY,
  LABEL_CALIBRATION_SEED_META_KEY,
  buildLabelCalibration,
  declareRecords,
  finalizeCohortDays,
} from '../scripts/seed-label-calibration.mjs';
// @ts-expect-error — JS module, no declaration file
import { __testing__ as health } from '../api/health.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const id = (n: number) => n.toString(16).padStart(64, '0');
const DAY_1 = '2026-09-01';
const T0 = dayStartMs(DAY_1);
const f = (n: number, state: CalibrationEvent['state'], at: number): CalibrationEvent => ({ kind: 'f', storyId: id(n), state, at });
const s = (n: number, state: CalibrationEvent['state'], at: number): CalibrationEvent => ({ kind: 's', storyId: id(n), state, at });

describe('calibration events', () => {
  it('round-trip, and anything else parses to null', () => {
    const event = f(1, 'single-publisher', T0 + 5);
    const raw = encodeCalibrationEvent(event)!;
    assert.equal(raw, `f|${id(1)}|single-publisher|${T0 + 5}`);
    assert.deepEqual(parseCalibrationEvent(raw), event);
    assert.equal(encodeCalibrationEvent(f(1, 'other', T0)), null, 'a first label is always a tracked state');
    assert.equal(encodeCalibrationEvent({ ...event, storyId: 'x' }), null);
    for (const bad of [42, '', `f|${id(1)}|verified|1`, `x|${id(1)}|corroborated|1`, `${raw}|extra`, `f|${id(1)}|corroborated|1.5`]) {
      assert.equal(parseCalibrationEvent(bad), null, String(bad));
    }
  });
});

describe('cohort day', () => {
  const events = [
    f(1, 'single-publisher', T0 + HOUR), // later carried by 2+ families within 24h, stays
    s(1, 'corroborated', T0 + 3 * HOUR),
    f(2, 'single-publisher', T0 + 2 * HOUR), // widens only after 24h
    s(2, 'corroborated', T0 + 2 * HOUR + 2 * DAY),
    f(3, 'single-publisher', T0 + 3 * HOUR), // never changes
    f(4, 'corroborated', T0 + 4 * HOUR), // narrows, then goes tier-4 only before day 7
    s(4, 'single-publisher', T0 + 10 * HOUR),
    s(4, 'other', T0 + 5 * DAY),
    f(5, 'corroborated', T0 + 5 * HOUR), // flaps back to the same label by 24h
    s(5, 'single-publisher', T0 + 6 * HOUR),
    s(5, 'corroborated', T0 + 7 * HOUR),
    f(6, 'single-publisher', T0 + 23 * HOUR), // change exactly at the 24h checkpoint counts
    s(6, 'corroborated', T0 + 47 * HOUR),
    f(7, 'single-publisher', T0 + DAY + HOUR), // next day's cohort
    f(8, 'single-publisher', T0 - HOUR), // previous day's cohort
    s(8, 'corroborated', T0 + HOUR),
  ];

  it('counts each story once, in the cohort of its first label, with outcomes at 24h and 7d', () => {
    const record = buildCohortDay(DAY_1, events);
    assert.deepEqual(record.cohorts['single-publisher'], {
      n: 4,
      '24h': { same: 2, changed: 2, other: 0 },
      '7d': { same: 1, changed: 3, other: 0 },
    });
    assert.deepEqual(record.cohorts.corroborated, {
      n: 2,
      '24h': { same: 1, changed: 1, other: 0 },
      '7d': { same: 1, changed: 0, other: 1 },
    });
    assert.equal(record.incomplete, false);
  });

  it('is a pure function of the logged events: order of lists does not matter, duplicates do not count twice', () => {
    const shuffled = [...events].reverse();
    const duplicated = [...events, ...events];
    const expected = buildCohortDay(DAY_1, events);
    assert.deepEqual(buildCohortDay(DAY_1, shuffled), expected);
    assert.deepEqual(buildCohortDay(DAY_1, duplicated), expected);
    assert.deepEqual(buildCohortDay(DAY_1, [...events, null]), expected, 'an unparsable list entry is skipped');
  });

  it('replays a later first label as the story\'s label at that time, never drops it', () => {
    // The track row was not written after the first cycle, so the next cycle
    // logged a first label again, by then in a different state.
    const record = buildCohortDay(DAY_1, [f(9, 'single-publisher', T0 + HOUR), f(9, 'corroborated', T0 + 2 * HOUR)]);
    assert.equal(record.cohorts['single-publisher'].n, 1);
    assert.equal(record.cohorts.corroborated.n, 0, 'one story, one cohort');
    assert.deepEqual(record.cohorts['single-publisher']['24h'], { same: 0, changed: 1, other: 0 });
    // The same two events in the other order (lists are read day by day).
    assert.deepEqual(buildCohortDay(DAY_1, [f(9, 'corroborated', T0 + 2 * HOUR), f(9, 'single-publisher', T0 + HOUR)]), record);
  });

  it('a story first logged on the day before stays in that cohort', () => {
    const record = buildCohortDay(DAY_1, [f(8, 'single-publisher', T0 - HOUR), f(8, 'single-publisher', T0 + HOUR)]);
    assert.equal(record.cohorts['single-publisher'].n, 0);
  });

  it('an incomplete day carries no figures', () => {
    const record = buildCohortDay(DAY_1, events, { incomplete: true });
    assert.equal(record.incomplete, true);
    assert.equal(record.cohorts['single-publisher'].n, 0);
  });

  it('parses only records whose outcomes add up to n', () => {
    const record = buildCohortDay(DAY_1, events);
    assert.deepEqual(parseCohortDay(JSON.stringify(record)), record);
    const broken = structuredClone(record);
    broken.cohorts.corroborated['7d'].same += 1;
    assert.equal(parseCohortDay(JSON.stringify(broken)), null);
    assert.equal(parseCohortDay('not json'), null);
    assert.equal(parseCohortDay(JSON.stringify({ ...record, version: 2 })), null);
  });
});

describe('finalization window', () => {
  it('a day is finalized only after its last story has passed 7 days, within the event retention', () => {
    // 2026-09-01 ends 09-02T00:00; its last story passes + 7d at 09-09T00:00, plus a 1h settle.
    assert.ok(!finalizableDays(dayStartMs('2026-09-09') + 30 * 60 * 1000).includes(DAY_1));
    assert.ok(finalizableDays(dayStartMs('2026-09-09') + HOUR).includes(DAY_1));
    assert.ok(!finalizableDays(dayStartMs('2026-09-22')).includes(DAY_1), 'its events have expired by then');
    assert.deepEqual(eventDaysFor(DAY_1), ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
  });

  it('covers the current month and the 12 before it', () => {
    const months = calibrationMonths(dayStartMs('2026-10-16'));
    assert.equal(months.length, 13);
    assert.equal(months[0], '2026-10');
    assert.equal(months.at(-1), '2025-10');
  });
});

describe('monthly table', () => {
  const day = (date: string, single: [number, number, number, number], incomplete = false) => {
    const [n, same, changed, other] = single;
    return {
      day: date,
      version: 1,
      incomplete,
      cohorts: {
        'single-publisher': { n, '24h': { same, changed, other }, '7d': { same, changed, other } },
        corroborated: { n: 1, '24h': { same: 1, changed: 0, other: 0 }, '7d': { same: 0, changed: 1, other: 0 } },
      },
    };
  };

  it('sums cohort days per month, newest first, with n on every row', () => {
    const table = buildCalibrationTable([
      day('2026-09-01', [10, 7, 2, 1]),
      day('2026-09-02', [5, 3, 2, 0]),
      day('2026-09-03', [0, 0, 0, 0], true),
      day('2026-08-31', [4, 4, 0, 0]),
      day('2025-01-01', [100, 100, 0, 0]), // outside the 13 months
    ], { generatedAt: dayStartMs('2026-09-20') });
    assert.deepEqual(table.months.map((month) => month.month), ['2026-09', '2026-08']);
    const [september] = table.months;
    assert.equal(september!.cohortDays, 2);
    assert.equal(september!.excludedDays, 1);
    assert.equal(september!.firstDay, '2026-09-01');
    assert.equal(september!.lastDay, '2026-09-02');
    assert.deepEqual(september!.rows, [
      { state: 'single-publisher', horizon: '24h', n: 15, same: 10, changed: 4, other: 1 },
      { state: 'single-publisher', horizon: '7d', n: 15, same: 10, changed: 4, other: 1 },
      { state: 'corroborated', horizon: '24h', n: 2, same: 2, changed: 0, other: 0 },
      { state: 'corroborated', horizon: '7d', n: 2, same: 0, changed: 2, other: 0 },
    ]);
    assert.equal(table.lowNThreshold, CALIBRATION_LOW_N);
    assert.equal(table.factCheckStatus, FACT_CHECK_STATUS);
    assert.match(table.factCheckNote, /^Not measured\./);
    assert.deepEqual(parseCalibrationTable(table), table);
    assert.equal(declareRecords(table), 3);
  });

  it('rejects a table whose rows do not add up', () => {
    const table = buildCalibrationTable([day('2026-09-01', [10, 7, 2, 1])], { generatedAt: dayStartMs('2026-09-20') });
    const broken = structuredClone(table);
    broken.months[0]!.rows[0]!.same += 1;
    assert.equal(parseCalibrationTable(broken), null);
  });

  it('never words an outcome as a verdict', () => {
    const text = readFileSync(new URL('../shared/label-calibration.js', import.meta.url), 'utf8');
    for (const line of text.split('\n').filter((l) => /FACT_CHECK_NOTE|'Not measured/.test(l))) {
      assert.doesNotMatch(line, /\b(true|false|accurate|confirmed|verified)\b/i);
    }
  });
});

describe('digest wiring', () => {
  const single = storyLabel([{ source: 'Reuters World', corroborationCount: 1 }]);
  const corroborated = storyLabel([{ source: 'Reuters World', corroborationCount: 2 }, { source: 'BBC World' }]);
  const tier4 = { state: 'tier4-only' as const, publishers: 2, roster: [] };

  it('logs a first label only for a new story in a tracked state', () => {
    assert.deepEqual(calibrationEventFor(id(1), undefined, single, T0), f(1, 'single-publisher', T0));
    assert.equal(calibrationEventFor(id(1), undefined, tier4, T0), null);
    assert.deepEqual(calibrationEventFor(id(1), { label: undefined }, single, T0), f(1, 'single-publisher', T0), 'a row another variant created has no label: full/en has not labelled the story yet');
    assert.equal(calibrationEventFor(id(1), { label: undefined }, tier4, T0), null);
  });

  it('logs every later move itself, apart from the guarded public change log', () => {
    assert.deepEqual(calibrationEventFor(id(1), { label: 'corroborated|2' }, tier4, T0), s(1, 'other', T0));
    assert.deepEqual(calibrationEventFor(id(1), { label: UNTRACKED_LABEL }, single, T0), s(1, 'single-publisher', T0));
    assert.equal(calibrationEventFor(id(1), { label: UNTRACKED_LABEL }, tier4, T0), null);
    assert.deepEqual(calibrationEventFor(id(1), { label: 'single-publisher|1' }, corroborated, T0), s(1, 'corroborated', T0));
    assert.equal(calibrationEventFor(id(1), { label: 'single-publisher|1' }, single, T0), null);
    // The public log's guard may suppress a quick flip-back; the calibration log must not depend on it.
    const change = labelChangeFor(id(1), 'single-publisher|1', corroborated, { at: T0, title: 't', link: '' })!;
    assert.equal(labelChangeCommands(change).some((command) => command[0] === 'RPUSH'), false);
  });

  it('appends to the UTC day list, capped and expiring', () => {
    const commands = calibrationEventCommands([f(1, 'single-publisher', T0), f(2, 'corroborated', T0 + DAY)]);
    assert.deepEqual(commands, [
      ['RPUSH', calibrationEventsKey('2026-09-01'), `f|${id(1)}|single-publisher|${T0}`],
      ['LTRIM', calibrationEventsKey('2026-09-01'), 0, CALIBRATION_EVENTS_MAX - 1],
      ['EXPIRE', calibrationEventsKey('2026-09-01'), 21 * 24 * 60 * 60],
      ['RPUSH', calibrationEventsKey('2026-09-02'), `f|${id(2)}|corroborated|${T0 + DAY}`],
      ['LTRIM', calibrationEventsKey('2026-09-02'), 0, CALIBRATION_EVENTS_MAX - 1],
      ['EXPIRE', calibrationEventsKey('2026-09-02'), 21 * 24 * 60 * 60],
    ]);
  });

  it('a move whose write was not confirmed is logged again from the current state next cycle', () => {
    const labels = new Map([[id(1), UNTRACKED_LABEL], [id(2), 'single-publisher|1'], [id(3), 'single-publisher|1']]);
    keepUnloggedMoves(labels, [s(1, 'other', T0), f(2, 'single-publisher', T0), s(3, 'single-publisher', T0), s(4, 'corroborated', T0)]);
    assert.equal(labels.get(id(1)), `${UNCONFIRMED_PREFIX}${UNTRACKED_LABEL}`);
    assert.equal(labels.get(id(2)), 'single-publisher|1', 'a first label is persisted regardless');
    assert.equal(labels.has(id(4)), false, 'a label the public log kept back stays unwritten');
    // The append may have landed with its reply lost, and the story may be
    // back where it started: the next cycle still logs where it is now.
    const unconfirmed = `${UNCONFIRMED_PREFIX}${UNTRACKED_LABEL}`;
    assert.deepEqual(calibrationEventFor(id(1), { label: unconfirmed }, single, T0 + HOUR), s(1, 'single-publisher', T0 + HOUR));
    assert.deepEqual(calibrationEventFor(id(1), { label: unconfirmed }, tier4, T0 + HOUR), s(1, 'other', T0 + HOUR));
    // The public change log still compares against the label behind the prefix.
    const kept = labels.get(id(3))!;
    assert.equal(kept, `${UNCONFIRMED_PREFIX}single-publisher|1`);
    assert.ok(labelChangeFor(id(3), kept, corroborated, { at: T0 + HOUR, title: 't', link: '' }), 'single-publisher → corroborated is still logged publicly');
    const day = buildCohortDay(DAY_1, [f(1, 'single-publisher', T0), s(1, 'other', T0 + 1), s(1, 'single-publisher', T0 + HOUR)]);
    assert.equal(day.cohorts['single-publisher']['24h'].same, 1, 'the returned label is the outcome, not the lost-reply move');
  });

  it('storyLabelChanges returns the events of this cycle', () => {
    const item = (overrides: Record<string, unknown>) => ({
      source: 'Reuters World', title: 'Central bank holds rates', link: 'https://www.reuters.com/world/x-1',
      importanceScore: 10, credibilityScore: 70, corroborationCount: 1, ...overrides,
    });
    const items = [item({ titleHash: id(1) }), item({ titleHash: id(2), source: 'Example Aggregator' }), item({ titleHash: id(3) })];
    const tracks = new Map([[id(3), { firstSeen: 1, lastSeen: 1, mentionCount: 1, sourceCount: 1, label: UNTRACKED_LABEL }]]);
    const { calibrationEvents } = __testing__.storyLabelChanges(items as never, items as never, tracks, T0, new Set([id(2)]));
    assert.deepEqual(calibrationEvents, [f(1, 'single-publisher', T0), s(3, 'single-publisher', T0)]);
  });
});

/** In-memory Redis for the seeder: lists, strings with NX, EXISTS, LLEN, GET. */
function memoryRedis(lists: Record<string, string[]>, strings: Record<string, string> = {}) {
  const commands: unknown[][] = [];
  const pipeline = async (batch: unknown[][]) => {
    commands.push(...batch);
    return batch.map(([verb, key, ...rest]) => {
      const k = String(key);
      switch (verb) {
        case 'EXISTS': return { result: k in strings ? 1 : 0 };
        case 'LLEN': return { result: lists[k]?.length ?? 0 };
        case 'LRANGE': return { result: lists[k] ?? [] };
        case 'GET': return { result: strings[k] ?? null };
        case 'SET': {
          if (rest.includes('NX') && k in strings) return { result: null };
          strings[k] = String(rest[0]);
          return { result: 'OK' };
        }
        default: throw new Error(`unexpected ${String(verb)}`);
      }
    });
  };
  return { pipeline, strings, commands };
}

describe('seeder', () => {
  const now = dayStartMs('2026-09-09') + 2 * HOUR;
  const encoded = (events: CalibrationEvent[]) => events.map((event) => encodeCalibrationEvent(event)!);

  it('finalizes a due day once from its event lists, and publishes the table from day records', async () => {
    const redis = memoryRedis({
      [calibrationEventsKey(DAY_1)]: encoded([f(1, 'single-publisher', T0 + HOUR), f(2, 'corroborated', T0 + 2 * HOUR)]),
      [calibrationEventsKey('2026-09-02')]: encoded([s(1, 'corroborated', T0 + DAY + 2 * HOUR)]),
    });
    const table = await buildLabelCalibration(now, { pipeline: redis.pipeline });
    const record = parseCohortDay(redis.strings[calibrationDayKey(DAY_1)])!;
    assert.deepEqual(record.cohorts['single-publisher'], { n: 1, '24h': { same: 1, changed: 0, other: 0 }, '7d': { same: 0, changed: 1, other: 0 } }, 'the change came 25h after the first label');
    assert.equal(Object.keys(redis.strings).length, 1, 'a day with no events gets no record');
    assert.equal(table.months[0]!.cohortDays, 1);
    assert.equal(table.months[0]!.rows[0]!.n, 1);

    // A later run never rewrites a finalized day.
    const before = redis.strings[calibrationDayKey(DAY_1)];
    assert.deepEqual(await finalizeCohortDays(now, redis.pipeline), []);
    assert.equal(redis.strings[calibrationDayKey(DAY_1)], before);
  });

  it('marks a day incomplete when a list it depends on reached the cap', async () => {
    const full = Array.from({ length: CALIBRATION_EVENTS_MAX }, () => `s|${id(9)}|other|${T0 + DAY}`);
    const redis = memoryRedis({
      [calibrationEventsKey(DAY_1)]: encoded([f(1, 'single-publisher', T0 + HOUR)]),
      [calibrationEventsKey('2026-09-02')]: full,
    });
    const table = await buildLabelCalibration(now, { pipeline: redis.pipeline });
    assert.equal(parseCohortDay(redis.strings[calibrationDayKey(DAY_1)])!.incomplete, true);
    assert.equal(table.months[0]!.cohortDays, 0);
    assert.equal(table.months[0]!.excludedDays, 1);
  });

  it('fails the run on a Redis error instead of publishing a partial table', async () => {
    const failing = async () => null;
    await assert.rejects(() => buildLabelCalibration(now, { pipeline: failing }));
  });
});

describe('ListLabelChanges serves the calibration table', () => {
  function fakeRedis(reply: (command: unknown[]) => unknown) {
    const saved = { fetch: globalThis.fetch, url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
    const commands: unknown[][] = [];
    globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '[]') as unknown[][];
      commands.push(...body);
      return { ok: true, status: 200, json: async () => body.map((command) => ({ result: reply(command) })) };
    }) as unknown as typeof fetch;
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
    return {
      commands,
      restore() {
        globalThis.fetch = saved.fetch;
        if (saved.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = saved.url;
        if (saved.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
      },
    };
  }
  const ctx = () => ({ request: new Request('https://example.test/api/news/v1/list-label-changes'), pathParams: {}, headers: {} });
  const table = buildCalibrationTable([buildCohortDay(DAY_1, [f(1, 'single-publisher', T0 + HOUR)])], { generatedAt: T0 + 9 * DAY });

  it('unwraps the seed envelope and serves the table on the all-stories request only', async () => {
    const envelope = JSON.stringify({ _seed: { fetchedAt: T0, recordCount: 1, sourceVersion: 'v1', schemaVersion: 1, state: 'OK' }, data: table });
    const redis = fakeRedis((command) => {
      if (command[0] === 'GET' && command[1] === LABEL_CALIBRATION_KEY) return envelope;
      if (command[0] === 'SMEMBERS') return [];
      return command[0] === 'LRANGE' ? [] : null;
    });
    try {
      const response = await listLabelChanges(ctx(), { storyId: '', limit: 0 });
      assert.deepEqual(response.calibration, {
        ...table,
        months: table.months.map((month) => ({ ...month, rows: month.rows.map(({ n, ...row }) => ({ ...row, stories: n })) })),
      }, 'the API names the sample size `stories`');
      const before = redis.commands.length;
      const one = await listLabelChanges(ctx(), { storyId: id(1), limit: 0 });
      assert.equal(one.calibration, undefined);
      assert.equal(redis.commands.slice(before).some((command) => command[1] === LABEL_CALIBRATION_KEY), false);
    } finally {
      redis.restore();
    }
  });

  it('serves no table rather than a malformed one', async () => {
    const broken = structuredClone(table);
    broken.months[0]!.rows[0]!.n += 1;
    const redis = fakeRedis((command) => {
      if (command[0] === 'GET' && command[1] === LABEL_CALIBRATION_KEY) return JSON.stringify(broken);
      if (command[0] === 'SMEMBERS') return [];
      return command[0] === 'LRANGE' ? [] : null;
    });
    try {
      const response = await listLabelChanges(ctx(), { storyId: '', limit: 0 });
      assert.equal(response.state, 'ok');
      assert.equal(response.calibration, undefined);
    } finally {
      redis.restore();
    }
  });

  it('the OpenAPI example rows add up', () => {
    const spec = JSON.parse(readFileSync(new URL('../docs/api/NewsService.openapi.json', import.meta.url), 'utf8'));
    const example = spec.paths['/api/news/v1/list-label-changes'].get.responses['200'].content['application/json'].example;
    const stored = {
      ...example.calibration,
      months: example.calibration.months.map((month: { rows: Array<{ stories: number }> }) => ({
        ...month,
        rows: month.rows.map(({ stories, ...row }) => ({ ...row, n: stories })),
      })),
    };
    assert.ok(parseCalibrationTable(stored), 'the curated example passes the reader');
    assert.deepEqual(Object.keys(spec.components.schemas.LabelCalibrationRow.properties).sort(), ['changed', 'horizon', 'other', 'same', 'state', 'stories']);
  });
});

describe('health registration', () => {
  const classify = (overrides: Record<string, unknown>) => health.classifyKey('labelCalibration', LABEL_CALIBRATION_KEY, { allowOnDemand: true }, {
    keyStrens: new Map(), keyErrors: new Map(), keyMetaValues: new Map(), keyMetaErrors: new Map(), now: T0, ...overrides,
  });

  it('is a standalone check bound to the seeder\'s keys and activation marker', () => {
    assert.equal(health.STANDALONE_KEYS.labelCalibration, LABEL_CALIBRATION_KEY);
    assert.equal(health.SEED_META.labelCalibration.key, LABEL_CALIBRATION_SEED_META_KEY);
    assert.equal(health.SEED_META.labelCalibration.maxStaleMin, 1080);
    assert.equal(health.ACTIVATION_MARKERS.labelCalibration, LABEL_CALIBRATION_ACTIVATION_KEY);
    assert.ok(health.EMPTY_DATA_OK_KEYS.has('labelCalibration'));
  });

  it('is OK for a fresh empty table, soft before the first publish, stale after 18 hours', () => {
    const fresh = classify({
      keyStrens: new Map([[LABEL_CALIBRATION_KEY, 120]]),
      keyMetaValues: new Map([[LABEL_CALIBRATION_SEED_META_KEY, JSON.stringify({ fetchedAt: T0 - 60_000, recordCount: 0 })]]),
    });
    assert.equal(fresh.status, 'OK');
    assert.notEqual(health.STATUS_COUNTS[classify({}).status], 'crit');
    const stale = classify({
      keyStrens: new Map([[LABEL_CALIBRATION_KEY, 120]]),
      keyMetaValues: new Map([[LABEL_CALIBRATION_SEED_META_KEY, JSON.stringify({ fetchedAt: T0 - 19 * HOUR, recordCount: 3 })]]),
    });
    assert.equal(stale.status, 'STALE_SEED');
  });
});
