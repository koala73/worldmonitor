import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const handlerSrc = readFileSync('server/worldmonitor/sanctions/v1/list-sanctions-pressure.ts', 'utf8');
const seedSrc = readFileSync('scripts/seed-sanctions-pressure.mjs', 'utf8');

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
