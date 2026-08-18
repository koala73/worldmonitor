import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

describe('Submarine-Cables declares a bundle slot it can actually be given (#6799)', () => {
  // seed-bundle-static-ref admits a section only when its DECLARED worst case
  // (timeoutMs + KILL_GRACE_MS) fits the budget still left on the tick — the
  // runner decides before running, so the declaration is all it has to go on.
  //
  // That makes the timeout a reservation, not a ceiling drawn down on use, and
  // over-declaring is a real cost: Submarine-Cables asked for 300s to do ~141s
  // of work, so with 293s left it was refused by 17 seconds and its key was
  // never written at all. Under-declaring is the opposite failure and just as
  // bad — Arms-Suppliers declared 450s for ~547s of work and burned its whole
  // fetch deadline on every run.
  //
  // So this is two-sided: the declaration must cover the measured runtime, and
  // its reservation must still fit the budget that realistically remains.
  //
  // Measured 2026-08-17 against submarinecablemap.com. Note the seeder fetches
  // the CURATED list (CABLE_REGIONS), not the 702 cables in all.json — 86 ids,
  // 18 batches of 5 at ~0.97s, plus ~5s for cable-geo.json (739KB) and
  // landing-point-geo.json (360KB).
  const MEASURED_RUNTIME_S = 22;
  const KILL_GRACE_S = 10;
  // What is left of the 570s budget once Arms-Suppliers has run at its measured
  // ~277s. The ceiling is expressed against this rather than as a ratio because
  // the harm from over-declaring is the absolute reservation, not the multiple.
  const BUDGET_REMAINING_S = 293;

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  it('covers the measured run and still fits the budget that remains', () => {
    const bundle = readFileSync(join(root, 'scripts/seed-bundle-static-ref.mjs'), 'utf8');
    const row = /label: 'Submarine-Cables'[^}]*timeoutMs:\s*([\d_]+)/.exec(bundle);
    assert.ok(row, 'seed-bundle-static-ref must declare a Submarine-Cables timeoutMs');
    const declaredS = Number(row[1].replace(/_/g, '')) / 1000;

    assert.ok(
      declaredS >= MEASURED_RUNTIME_S,
      `declared ${declaredS}s is below the measured ${MEASURED_RUNTIME_S}s — the section would be `
      + 'killed mid-run, which is how Arms-Suppliers burned its deadline every tick',
    );
    assert.ok(
      declaredS + KILL_GRACE_S <= BUDGET_REMAINING_S,
      `declared ${declaredS}s reserves ${declaredS + KILL_GRACE_S}s, more than the `
      + `${BUDGET_REMAINING_S}s left after Arms-Suppliers. The bundle admits on the declaration, `
      + 'so a reservation this size locks the section out of every tick (#6799).',
    );
  });

  it('the curated list is what sets that runtime, not all.json', () => {
    // If the seeder ever switched to the full catalogue the measurement above
    // would be ~6x optimistic and the slot too small, so pin what it iterates.
    const ids = CABLE_REGIONS.flatMap((region) => region.ids);
    assert.ok(ids.length > 80 && ids.length < 200, `curated list is ${ids.length} ids`);
  });
});
