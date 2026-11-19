// The relay's v2 strike tally (CII v15 Stage B3) runs beside the v1 feed on
// main. Main's v14 scorer reads conflict:iran-events:v1 and
// conflict:strike-pressure:v1 with no version check, so the shadow loop must
// leave both keys, and therefore every v14 score, byte-identical. This test
// replays the shadow cycle against an in-memory Redis seeded with a committed
// production capture and scores v14 before and after.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { expectedFromTable, loadCiiFixtures, scoreCiiFixture } from '../scripts/lib/cii-fixtures.mts';
import { CII_FORMULA_VERSION } from '../server/worldmonitor/intelligence/v1/_risk-config.ts';

const require = createRequire(import.meta.url);
const strikesV1 = require('../scripts/lib/middle-east-strikes.cjs');
const strikesV2 = require('../scripts/lib/middle-east-strikes-v2.cjs');

// The strike keys the v14 scorer reads (get-risk-scores.ts readRiskInputs list).
const SCORER_STRIKE_KEYS = { iranEvents: 'conflict:iran-events:v1', strikePressure: 'conflict:strike-pressure:v1' } as const;
const FIXTURE = loadCiiFixtures().find((f) => f.label === '2026-10-23T0946Z');
const MIN = 60_000;

function score(inputs: Record<string, unknown>) {
  return scoreCiiFixture({ inputs: inputs as never, nowMs: FIXTURE!.nowMs, iranEventsEnabled: FIXTURE!.iranEventsEnabled });
}

function scoreBytes(inputs: Record<string, unknown>): string {
  const table = score(inputs);
  return JSON.stringify({ scores: table.scores, rows: table.rows });
}

async function runShadowCycle(redis: Map<string, string>, now: number) {
  const get = async (key: string) => ({ ok: true, value: redis.has(key) ? JSON.parse(redis.get(key)!) : null });
  const set = async (key: string, value: unknown) => { redis.set(key, JSON.stringify(value)); return true; };
  // Same Telegram channel shapes as the relay's items; strikes on countries v14 scores.
  const posts = [
    { id: 'saudidcd:1', channel: 'saudidcd', url: 'https://t.me/SaudiDCD/1', ts: new Date(now - 20 * MIN).toISOString(), text: 'Missile debris hit a building in Riyadh' },
    { id: 'saudidcd:2', channel: 'saudidcd', url: 'https://t.me/SaudiDCD/2', ts: new Date(now - 10 * MIN).toISOString(), text: 'A drone struck an oil facility in Ras Tanura' },
  ];
  const places = [['Riyadh', 'critical'], ['Ras Tanura', 'critical']];
  return strikesV2.publishStrikeCycle({
    now,
    pendingItems: posts,
    readStore: () => get(strikesV2.STORE_KEY),
    writeStore: (store: unknown) => set(strikesV2.STORE_KEY, store),
    writeCanonical: (payload: unknown) => set(strikesV2.CANONICAL_KEY, payload),
    writeSeedMeta: (meta: unknown) => set(strikesV2.SEED_META_KEY, meta),
    readCache: async (key: string) => (await get(key)).value,
    writeCache: (key: string, value: unknown) => set(key, value),
    classify: async (texts: string[]) => texts.map((_, i) => ({
      i, isStrike: true, kind: 'strike', when: 'new', atSea: false, place: places[i]![0], countryIso2: 'SA', severity: places[i]![1],
    })),
    loadGdelt: async (processed: unknown[]) => ({ candidates: [], processed, fetched: 0 }),
    telegramPolledAt: now - MIN,
    readPressure: () => get(strikesV2.PRESSURE_KEY),
    writePressure: (pressure: unknown) => set(strikesV2.PRESSURE_KEY, pressure),
    writePressureMeta: async (meta: unknown) => {
      await set(strikesV2.PRESSURE_SEED_META_KEY, meta);
      await set(strikesV2.PRESSURE_ACTIVATION_KEY, String(now));
      return true;
    },
  });
}

describe('v2 strike tally beside the live v14 scorer', () => {
  it('uses a committed capture whose v14 strike inputs are live', () => {
    assert.ok(FIXTURE, 'tests/fixtures/cii/2026-10-23T0946Z.json');
    assert.equal(FIXTURE.iranEventsEnabled, true);
    assert.equal(CII_FORMULA_VERSION, 'v14');
    assert.equal((FIXTURE.inputs.strikePressure as { version?: number }).version, 1);
    assert.equal(strikesV1.PRESSURE_KEY, SCORER_STRIKE_KEYS.strikePressure);
    assert.equal(strikesV1.CANONICAL_KEY, SCORER_STRIKE_KEYS.iranEvents);
    // The scorer still reads exactly these two strike keys.
    const scorer = readFileSync(new URL('../server/worldmonitor/intelligence/v1/get-risk-scores.ts', import.meta.url), 'utf8');
    for (const key of Object.values(SCORER_STRIKE_KEYS)) assert.ok(scorer.includes(`{ key: '${key}', raw: true }`), key);
    assert.ok(!/conflict:(iran-events|strike-pressure):v2/.test(scorer), 'v14 must not read the v2 keys');
  });

  it('leaves every v14 score byte-identical after a shadow cycle writes a v2 tally', async () => {
    const redis = new Map<string, string>();
    for (const [input, key] of Object.entries(SCORER_STRIKE_KEYS)) redis.set(key, JSON.stringify(FIXTURE!.inputs[input as keyof typeof SCORER_STRIKE_KEYS]));
    const scorerBytesBefore = Object.values(SCORER_STRIKE_KEYS).map((key) => redis.get(key));
    const before = scoreBytes(FIXTURE!.inputs as Record<string, unknown>);
    // The committed v14 expectation is what production computed; the seam reproduces it.
    assert.deepEqual(expectedFromTable(score(FIXTURE!.inputs as Record<string, unknown>)), FIXTURE!.expected.v14);

    const out = await runShadowCycle(redis, FIXTURE!.nowMs);
    assert.equal(out.status, 'ok');
    assert.equal(out.pressureStatus, 'ok');
    const v2 = JSON.parse(redis.get(strikesV2.PRESSURE_KEY)!);
    assert.equal(v2.version, 2);
    const day = new Date(FIXTURE!.nowMs).toISOString().slice(0, 10);
    assert.deepEqual(v2.days[day], { SA: [2, 0, 0, 0] }, 'the shadow cycle tallied its strikes');

    assert.deepEqual(Object.values(SCORER_STRIKE_KEYS).map((key) => redis.get(key)), scorerBytesBefore, 'v1 keys untouched');
    const afterInputs = { ...FIXTURE!.inputs } as Record<string, unknown>;
    for (const [input, key] of Object.entries(SCORER_STRIKE_KEYS)) afterInputs[input] = JSON.parse(redis.get(key)!);
    assert.equal(scoreBytes(afterInputs), before);
  });

  it('control: the same v2 tally in the v1 key would move v14 scores', async () => {
    const redis = new Map<string, string>();
    await runShadowCycle(redis, FIXTURE!.nowMs);
    const before = scoreBytes(FIXTURE!.inputs as Record<string, unknown>);
    const leaked = { ...FIXTURE!.inputs, strikePressure: JSON.parse(redis.get(strikesV2.PRESSURE_KEY)!) } as Record<string, unknown>;
    assert.notEqual(scoreBytes(leaked), before, 'v14 has no version check, so a v2 tally on the v1 key changes scores');
  });
});
