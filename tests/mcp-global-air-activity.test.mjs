/**
 * #5707 (item: global airborne-traffic snapshot) — get_airspace answers one
 * country at a time; nothing answered "what is aloft worldwide right now?"
 * even though the seeded military flight snapshot IS the world dataset.
 *
 * get_global_air_activity is a cheap aggregate over `military:flights:v1`:
 * one world total, an aircraft-type breakdown, per-theater rollups reusing
 * the SAME theater assignment the surge engine uses (no second geometry
 * implementation), and the count outside every declared theater. Military
 * scope is deliberate and disclosed: the redistribution-gated seeded snapshot
 * covers the world; civilian coverage remains per-country via get_airspace.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { installRedis } from './helpers/fake-upstash-redis.mts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';

const findTool = (name) => TOOL_REGISTRY.find((t) => t.name === name);
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const ORIGINAL_REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_REDIS_URL;
  if (ORIGINAL_REDIS_TOKEN === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_REDIS_TOKEN;
});

// Persian-Gulf coordinates land inside the middle-east posture theater; the
// mid-Pacific point sits outside every declared theater boundary.
const IN_THEATER = { lat: 26.5, lon: 52.0 };
const OUTSIDE_THEATERS = { lat: -40.0, lon: -140.0 };

function flight(id, { lat, lon }, aircraftType, source = 'wingbits') {
  return {
    id,
    callsign: id.toUpperCase(),
    lat,
    lon,
    lastSeenMs: Date.now(),
    operator: 'usaf',
    aircraftType,
    sourceMeta: { source },
  };
}

function install(payload) {
  installRedis({
    'seed-meta:military:flights': { fetchedAt: Date.now(), recordCount: 4, sourceVersion: 'test' },
    'military:flights:v1': payload,
  }, { keepVercelEnv: true });
}

describe('get_global_air_activity (#5707)', () => {
  it('aggregates the world total, type breakdown, theater rollups, and the outside-theater remainder', async () => {
    install({
      flights: [
        flight('f1', IN_THEATER, 'fighter'),
        flight('f2', IN_THEATER, 'tanker'),
        flight('f3', OUTSIDE_THEATERS, 'transport'),
        flight('f4', OUTSIDE_THEATERS, 'unknown'),
      ],
      fetchedAt: Date.now(),
    });

    const result = await findTool('get_global_air_activity')._execute({}, '', {}, {});

    assert.equal(result.data.total_military_aircraft, 4);
    assert.equal(result.data.by_aircraft_type.fighter, 1);
    assert.equal(result.data.by_aircraft_type.tanker, 1);
    assert.equal(result.data.by_aircraft_type.transport, 1);
    assert.equal(result.data.by_aircraft_type.unknown, 1);

    // Theater boundaries overlap; which named theater claims the Gulf point
    // is the surge engine's call, not this test's. What must hold: some
    // theater carries both Gulf flights, correctly typed.
    const gulfTheater = result.data.theaters.find((t) => t.total_aircraft === 2);
    assert.ok(gulfTheater, `a theater must carry both Gulf flights: ${JSON.stringify(result.data.theaters)}`);
    assert.equal(gulfTheater.fighters, 1);
    assert.equal(gulfTheater.tankers, 1);

    const inTheaters = result.data.theaters.reduce((sum, t) => sum + t.total_aircraft, 0);
    assert.equal(result.data.outside_theater_count, result.data.total_military_aircraft - inTheaters);
    assert.equal(typeof result.stale, 'boolean');
  });

  it('quiet theaters are omitted, not reported as zero rows', async () => {
    install({ flights: [flight('f1', IN_THEATER, 'fighter')], fetchedAt: Date.now() });

    const result = await findTool('get_global_air_activity')._execute({}, '', {}, {});

    assert.ok(result.data.theaters.length >= 1);
    for (const theater of result.data.theaters) {
      assert.ok(theater.total_aircraft > 0, `zero-count theater rows are noise: ${theater.theater_id}`);
    }
  });

  it('non-redistributable flights never reach the aggregate', async () => {
    install({
      flights: [
        flight('f1', IN_THEATER, 'fighter'),
        flight('f2', IN_THEATER, 'fighter', 'opensky-network'),
      ],
      fetchedAt: Date.now(),
    });

    const result = await findTool('get_global_air_activity')._execute({}, '', {}, {});

    assert.equal(
      result.data.total_military_aircraft, 1,
      'the OpenSky-sourced flight must be excluded by the shared redistribution gate',
    );
  });

  it('fails loudly when the snapshot is missing rather than reporting an empty sky', async () => {
    installRedis({
      'seed-meta:military:flights': { fetchedAt: Date.now(), recordCount: 4, sourceVersion: 'test' },
    }, { keepVercelEnv: true });

    await assert.rejects(
      () => findTool('get_global_air_activity')._execute({}, '', {}, {}),
      /unavailable|no .*feed/i,
      'an absent snapshot is an availability failure — an empty-sky answer would be a lie',
    );
  });

  it('declares the hybrid tool contract', () => {
    const tool = findTool('get_global_air_activity');
    assert.ok(tool, 'tool must be registered');
    assert.equal(tool._cacheKeys, undefined, 'hybrid _execute tool, not a cache tool');
    assert.deepEqual(tool._coverageKeys, ['military:flights:v1']);
    assert.deepEqual(tool.inputSchema.required, [], 'callable with no arguments');
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
    });
    assert.match(tool.description, /get_airspace/, 'must point per-country/civilian askers at get_airspace');
    const firstSentence = tool.description.match(/^[\s\S]+?[.!?](?:\s|$)/);
    assert.ok(firstSentence && Buffer.byteLength(firstSentence[0].trim(), 'utf8') <= 120,
      'first sentence must survive tools/list compression');
  });
});
