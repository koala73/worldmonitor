import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CABLE_REGIONS,
  declareRecords,
  fetchSubmarineCables,
  validate,
} from '../scripts/seed-submarine-cables.mjs';

const ORIGINALS = {
  fetch: globalThis.fetch,
  setTimeout: globalThis.setTimeout,
  log: console.log,
  warn: console.warn,
};

beforeEach(() => {
  console.log = () => {};
  console.warn = () => {};
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 150) {
      queueMicrotask(() => callback(...args));
      return 0;
    }
    return ORIGINALS.setTimeout(callback, ms, ...args);
  };
});

afterEach(() => {
  globalThis.fetch = ORIGINALS.fetch;
  globalThis.setTimeout = ORIGINALS.setTimeout;
  console.log = ORIGINALS.log;
  console.warn = ORIGINALS.warn;
});

function installSubmarineCableFetchMock({ malformedDetail }) {
  const detailIds = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/cable/cable-geo.json')) {
      return Response.json({ features: [] });
    }
    if (href.endsWith('/landing-point/landing-point-geo.json')) {
      return Response.json({ features: [] });
    }
    if (href.includes('/cable/')) {
      const id = href.split('/').pop().replace('.json', '');
      detailIds.push(id);
      if (malformedDetail(id)) {
        return new Response('<!DOCTYPE html><html>blocked</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      return Response.json({
        name: id,
        landing_points: [],
        owners: [],
        rfs_year: null,
      });
    }
    throw new Error(`Unexpected URL: ${href}`);
  };

  return { detailIds };
}

describe('seed-submarine-cables strategic slug list', () => {
  const allIds = CABLE_REGIONS.flatMap(r => r.ids);

  it('has no duplicate slugs across regions', () => {
    const seen = new Set();
    const dupes = [];
    for (const id of allIds) {
      if (seen.has(id)) dupes.push(id);
      seen.add(id);
    }
    assert.deepEqual(dupes, [], `duplicate cable slug(s): ${dupes.join(', ')}`);
  });

  it('uses only well-formed lowercase-kebab slugs', () => {
    const bad = allIds.filter(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id));
    assert.deepEqual(bad, [], `malformed cable slug(s): ${bad.join(', ')}`);
  });

  it('drops the dead unityeac-pacific slug in favour of unity', () => {
    // TeleGeography split the combined "Unity/EAC-Pacific" cable; the old slug
    // now returns HTTP 200 with the SPA's HTML shell (not a 404) — the <!DOCTYPE
    // parse failure that broke the static-ref bundle before #4516 tolerated
    // per-cable fetch failures.
    assert.equal(allIds.includes('unityeac-pacific'), false, 'unityeac-pacific is a dead slug');
    assert.equal(allIds.includes('unity'), true, 'unity is the live replacement slug');
  });
});

describe('seed-submarine-cables detail fetch resilience', () => {
  it('skips a malformed individual detail response when the validation floor still passes', async () => {
    const state = installSubmarineCableFetchMock({
      malformedDetail: (id) => id === 'marea',
    });

    const data = await fetchSubmarineCables();

    assert.ok(state.detailIds.length > 80, 'test should cover the full strategic cable list');
    assert.equal(data.cables.length, state.detailIds.length - 1);
    assert.equal(data.cables.some(cable => cable.id === 'marea'), false);
    assert.equal(validate(data), true);
    assert.equal(declareRecords(data), data.cables.length);
  });

  it('throws when malformed detail responses drop the payload below the validation floor', async () => {
    const state = installSubmarineCableFetchMock({
      malformedDetail: () => true,
    });

    await assert.rejects(
      fetchSubmarineCables(),
      (err) => err instanceof Error
        && err.message.startsWith('Fetched 0/')
        && err.message.includes('below minimum')
        && err.message.includes('failed details:'),
    );
    assert.ok(state.detailIds.length > 80, 'test should cover the full strategic cable list');
  });
});
