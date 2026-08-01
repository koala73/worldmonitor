import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handlerSrc = readFileSync('server/worldmonitor/sanctions/v1/list-sanctions-pressure.ts', 'utf8');
const seedSrc = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');
const healthSrc = readFileSync('api/health.js', 'utf8');
const seedHealthSrc = readFileSync('api/seed-health.js', 'utf8');

// ---------------------------------------------------------------------------
// Gold standard: handler must be Redis-read-only (no XML parsing, no live fetch)
// ---------------------------------------------------------------------------
describe('handler: gold standard compliance', () => {
  it('handler does not import XMLParser (no live OFAC fetch at edge)', () => {
    assert.ok(
      !handlerSrc.includes('XMLParser'),
      'handler must not import XMLParser: Vercel reads Redis only, Railway makes all external API calls',
    );
  });

  it('handler does not define OFAC_SOURCES (no direct OFAC HTTP from edge)', () => {
    assert.ok(
      !handlerSrc.includes('OFAC_SOURCES'),
      'handler must not define OFAC_SOURCES: all OFAC fetching belongs in the Railway seed script',
    );
  });

  it('handler uses getCachedJson for Redis read', () => {
    assert.match(
      handlerSrc,
      /getCachedJson\(REDIS_CACHE_KEY/,
      'handler must read from Redis via getCachedJson',
    );
  });
});

// ---------------------------------------------------------------------------
// _state must not leak to API clients
// ---------------------------------------------------------------------------
describe('handler: _state stripping', () => {
  it('handler destructures _state before spreading data', () => {
    assert.match(
      handlerSrc,
      /_state.*_discarded/s,
      'handler must destructure _state out to prevent leaking seed internals to API clients',
    );
  });

  it('seed stores _state under STATE_KEY (not canonical key)', () => {
    assert.match(
      seedSrc,
      /extraKeys.*STATE_KEY/s,
      'extraKeys must reference STATE_KEY to write _state separately from canonical payload',
    );
  });

  it('seed writes country counts only through afterPublish metadata path', () => {
    const extraKeysBlock = seedSrc.match(/extraKeys:\s*\[([\s\S]*?)\]/)?.[1];
    assert.ok(extraKeysBlock, 'seed must declare its extraKeys contract');
    assert.doesNotMatch(
      extraKeysBlock,
      /COUNTRY_COUNTS_KEY/,
      'COUNTRY_COUNTS_KEY must not be duplicated in extraKeys; afterPublish writes it with seed-meta for health',
    );
    assert.match(
      seedSrc,
      /writeExtraKeyWithMeta\(\s*COUNTRY_COUNTS_KEY/s,
      'afterPublish must keep writing COUNTRY_COUNTS_KEY with freshness metadata',
    );
  });

  it('preserves every afterPublish companion key and its seed metadata on failed runs', () => {
    const preserveBlock = seedSrc.match(/preserveKeys:\s*\[([\s\S]*?)\]/)?.[1];
    assert.ok(preserveBlock, 'seed must declare afterPublish companion keys for runSeed preservation');
    for (const key of [
      'ENTITY_INDEX_KEY',
      'ENTITY_INDEX_META_KEY',
      'COUNTRY_COUNTS_KEY',
      'COUNTRY_COUNTS_META_KEY',
    ]) {
      assert.match(preserveBlock, new RegExp(`\\b${key}\\b`),
        `${key} must retain last-good data or metadata when OFAC fetches fail`);
    }
  });
});

// ---------------------------------------------------------------------------
// Seed: sequential fetch to avoid OOM on Railway 512MB
// ---------------------------------------------------------------------------
describe('seed: memory safety', () => {
  it('seed fetches OFAC sources sequentially (not Promise.all)', () => {
    const fnStart = seedSrc.indexOf('async function fetchSanctionsPressure()');
    const fnEnd = seedSrc.indexOf('\nfunction validate(');
    const fnBody = seedSrc.slice(fnStart, fnEnd);
    assert.ok(
      !fnBody.includes('Promise.all(OFAC_SOURCES'),
      'seed must not fetch both OFAC XML files concurrently: combined parse can exceed 512MB heap limit',
    );
  });
});

// ---------------------------------------------------------------------------
// Seed: DEFAULT_RECENT_LIMIT must not exceed handler MAX_ITEMS_LIMIT
// ---------------------------------------------------------------------------
describe('sanctions seed: DEFAULT_RECENT_LIMIT vs MAX_ITEMS_LIMIT', () => {
  it('seed DEFAULT_RECENT_LIMIT does not exceed handler MAX_ITEMS_LIMIT (60)', () => {
    const match = seedSrc.match(/const DEFAULT_RECENT_LIMIT\s*=\s*(\d+)/);
    assert.ok(match, 'DEFAULT_RECENT_LIMIT must be defined in seed script');
    const seedLimit = Number(match[1]);
    const handlerMatch = handlerSrc.match(/const MAX_ITEMS_LIMIT\s*=\s*(\d+)/);
    assert.ok(handlerMatch, 'MAX_ITEMS_LIMIT must be defined in handler');
    const handlerLimit = Number(handlerMatch[1]);
    assert.ok(
      seedLimit <= handlerLimit,
      `DEFAULT_RECENT_LIMIT (${seedLimit}) must not exceed MAX_ITEMS_LIMIT (${handlerLimit}): entries above the handler limit are never served`,
    );
  });
});

describe('sanctions seed: production freshness contract', () => {
  function maxStaleMin(name) {
    const match = healthSrc.match(new RegExp(`${name}:\\s*\\{[^}]*maxStaleMin:\\s*(\\d+)`));
    assert.ok(match, `${name}.maxStaleMin must be declared`);
    return Number(match[1]);
  }

  it('co-produced pressure and entity keys alarm on the same two-missed-run boundary', () => {
    assert.equal(maxStaleMin('sanctionsPressure'), 720);
    assert.equal(maxStaleMin('sanctionsEntities'), 720);
    const seedHealthEntity = seedHealthSrc.match(/'sanctions:entities':\s*\{[^}]*intervalMin:\s*(\d+)/);
    assert.ok(seedHealthEntity, '/api/seed-health must register the sanctions entity companion');
    assert.equal(Number(seedHealthEntity[1]), 360,
      '/api/seed-health must use the same 6h producer cadence as sanctions pressure');
  });

  it('keeps data alive beyond both paired freshness alarms', () => {
    const ttlMatch = seedSrc.match(/const CACHE_TTL\s*=\s*(\d+)\s*\*\s*60\s*\*\s*60/);
    assert.ok(ttlMatch, 'sanctions CACHE_TTL must stay expressed in whole hours');
    const ttlMinutes = Number(ttlMatch[1]) * 60;

    assert.ok(ttlMinutes > maxStaleMin('sanctionsPressure'),
      'canonical pressure data must still exist when STALE_SEED first alarms');
    assert.ok(ttlMinutes > maxStaleMin('sanctionsEntities'),
      'entity data must still exist when STALE_SEED first alarms');
  });

  it('gives the serial recovery ladder a deadline above its two-source worst case', () => {
    function optionMs(name) {
      const match = seedSrc.match(new RegExp(`${name}:\\s*(\\d[\\d_]*)`));
      assert.ok(match, `${name} must be explicit for the OFAC recovery budget`);
      return Number(match[1].replaceAll('_', ''));
    }

    const fetchPhaseTimeoutMs = optionMs('fetchPhaseTimeoutMs');
    const lockTtlMs = optionMs('lockTtlMs');
    assert.ok(fetchPhaseTimeoutMs >= 7 * 60 * 1000,
      'the two serial OFAC source ladders need at least a seven-minute fetch budget');
    assert.ok(lockTtlMs > fetchPhaseTimeoutMs,
      'the lock must outlive the explicit fetch deadline during slow recovery');
  });
});
