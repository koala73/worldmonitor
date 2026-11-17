import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { capturePizzaIndex } from '../scripts/freeze-crawlable-live-pulse.mjs';
import {
  MAX_PUBLISHED_PIZZA_INDEX_AGE_MS,
  glossaryPizzaIndex,
  publishedPizzaIndex,
  renderPizzaIndexSection,
} from '../scripts/live-pages/pentagon-pizza-index.mjs';

const NOW = Date.UTC(2026, 10, 23, 4, 41);
const RECORD = Object.freeze({
  updatedAt: '2026-11-22T21:30:00.000Z',
  level: '4',
  label: 'Above Normal',
  venues: [{ name: "Domino's Pizza", status: 'Busier than usual' }],
});

function livePayload(overrides = {}) {
  return {
    pizzint: {
      defconLevel: 5,
      defconLabel: 'Normal Activity',
      locationsMonitored: 1,
      locationsOpen: 1,
      updatedAt: NOW - 5 * 60_000,
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      locations: [{
        name: "Domino's Pizza",
        currentPopularity: 40,
        percentageOfUsual: 100,
        forecastPopularity: 40,
        dataFreshness: 'DATA_FRESHNESS_FRESH',
        isClosedNow: false,
      }],
      ...overrides,
    },
    tensionPairs: [],
  };
}

describe('published Pentagon Pizza Index reading', () => {
  it('reads a frozen reading and rejects malformed or aged ones', () => {
    assert.deepEqual(publishedPizzaIndex({ pizzaIndex: RECORD }, NOW), RECORD);
    assert.deepEqual(publishedPizzaIndex({ pizzaIndex: { ...RECORD, retained: true } }, NOW), RECORD);
    assert.equal(publishedPizzaIndex({}, NOW), null);
    assert.equal(publishedPizzaIndex(null, NOW), null);
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...RECORD, label: 'Normal Activity' } }, NOW), null, 'label must match the level');
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...RECORD, level: '6' } }, NOW), null);
    const { label: _label, ...unlabelled } = RECORD;
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...unlabelled, level: '6' } }, NOW), null, 'unknown level with no label');
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...unlabelled, level: 'constructor' } }, NOW), null, 'inherited key is not a level');
    assert.equal(publishedPizzaIndex({ pizzaIndex: unlabelled }, NOW), null, 'known level with no label');
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...RECORD, updatedAt: 'yesterday' } }, NOW), null);
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...RECORD, updatedAt: new Date(NOW + 60_000).toISOString() } }, NOW), null, 'no future readings');
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...RECORD, venues: [{ name: '' }] } }, NOW), null);
    const aged = new Date(NOW - MAX_PUBLISHED_PIZZA_INDEX_AGE_MS - 1).toISOString();
    assert.equal(publishedPizzaIndex({ pizzaIndex: { ...RECORD, updatedAt: aged } }, NOW), null);
  });

  it('renders the last published level with its UTC time for crawlers', () => {
    const html = renderPizzaIndexSection(RECORD, { live: false });
    assert.match(html, /data-state="ready"/);
    assert.match(html, /data-published-reading/);
    assert.doesNotMatch(html, /data-live-at-request/);
    assert.doesNotMatch(html, /Loading the live level/);
    assert.match(html, /data-live-status>Last published reading</);
    // A dated reading can be days old, so the heading must not call it current.
    assert.match(html, /<h2 id="live-reading-heading">Latest level<\/h2>/);
    assert.doesNotMatch(html, /Current level/);
    assert.match(html, /As of Nov 22, 2026, 9:30 PM UTC, the last published reading of the Pentagon Pizza Index was level 4, Above Normal\./);
    assert.match(html, /<time data-live-updated datetime="2026-11-22T21:30:00.000Z">Published reading Nov 22, 2026, 9:30 PM UTC<\/time>/);
    assert.match(html, /<strong data-pizzint-level>4<\/strong>/);
    assert.match(html, /<li>Domino&#39;s Pizza · Busier than usual<\/li>/);
  });
});

describe('glossary page reading and dateModified', () => {
  const dir = '../../../../docs/snapshots/';
  const older = { ...RECORD, updatedAt: '2026-11-20T10:00:00.000Z', level: '3', label: 'Elevated' };

  it('reads the newest dated snapshot and dates the page by the later of review and reading', () => {
    const pulses = {
      [`${dir}crawlable-live-pulse-2026-11-16.json`]: { pizzaIndex: older },
      [`${dir}crawlable-live-pulse-2026-11-23.json`]: { pizzaIndex: RECORD },
      // Not a weekly edition: same prefix, but the corpus never reads it.
      [`${dir}crawlable-live-pulse-2026-11-30-draft.json`]: { pizzaIndex: { ...RECORD, level: '1', label: 'Maximum Alert' } },
    };
    const { reading, dateModified } = glossaryPizzaIndex(pulses, '2026-11-17', NOW);
    assert.deepEqual(reading, RECORD);
    assert.equal(dateModified, RECORD.updatedAt);
  });

  it('keeps the review date when it is later than the reading or no reading is published', () => {
    const pulses = { [`${dir}crawlable-live-pulse-2026-11-23.json`]: { pizzaIndex: RECORD } };
    assert.equal(glossaryPizzaIndex(pulses, '2026-11-23', NOW).dateModified, '2026-11-23');
    assert.deepEqual(glossaryPizzaIndex({}, '2026-11-17', NOW), { reading: null, dateModified: '2026-11-17' });
    assert.deepEqual(glossaryPizzaIndex({}, undefined, NOW), { reading: null, dateModified: undefined });
    const aged = { [`${dir}crawlable-live-pulse-2026-11-23.json`]: { pizzaIndex: { ...RECORD, updatedAt: '2026-10-01T00:00:00.000Z' } } };
    assert.deepEqual(glossaryPizzaIndex(aged, '2026-11-17', NOW), { reading: null, dateModified: '2026-11-17' });
  });
});

describe('weekly freeze of the Pizza Index', () => {
  const originalFetch = globalThis.fetch;
  const roots = [];
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function rootWith(snapshots) {
    const dir = await mkdtemp(join(tmpdir(), 'pizza-pulse-'));
    roots.push(dir);
    await mkdir(join(dir, 'docs', 'snapshots'), { recursive: true });
    for (const [date, body] of Object.entries(snapshots)) {
      await writeFile(join(dir, 'docs', 'snapshots', `crawlable-live-pulse-${date}.json`), JSON.stringify(body));
    }
    return dir;
  }

  function serve(payload) {
    globalThis.fetch = async (url) => {
      assert.match(String(url), /\/api\/intelligence\/v1\/get-pizzint-status$/);
      if (payload instanceof Error) throw payload;
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  }

  const args = (rootDir) => ({ token: 't', base: 'https://www.worldmonitor.app', authOpts: {}, rootDir, now: NOW });

  it('captures the current level when one exists', async () => {
    serve(livePayload());
    const { pizzaIndex, error } = await capturePizzaIndex(args(await rootWith({ '2026-11-16': { pizzaIndex: RECORD } })));
    assert.equal(error, null);
    assert.equal(pizzaIndex.retained, false);
    assert.equal(pizzaIndex.level, '5');
    assert.equal(pizzaIndex.updatedAt, new Date(NOW - 5 * 60_000).toISOString());
  });

  it('carries the previous edition reading forward when no level is current', async () => {
    serve({ tensionPairs: [] });
    const { pizzaIndex, error } = await capturePizzaIndex(args(await rootWith({ '2026-11-09': { pizzaIndex: { ...RECORD, level: '5', label: 'Normal Activity' } }, '2026-11-16': { pizzaIndex: RECORD } })));
    assert.deepEqual(error, { id: 'pentagon-pizza-index', message: 'no current level' });
    assert.deepEqual(pizzaIndex, { ...RECORD, retained: true }, 'the newest edition wins');
  });

  it('carries the reading forward when the read fails, and publishes none once it ages out', async () => {
    serve(new Error('offline'));
    const fresh = await capturePizzaIndex(args(await rootWith({ '2026-11-16': { pizzaIndex: RECORD } })));
    assert.equal(fresh.error.message, 'offline');
    assert.deepEqual(fresh.pizzaIndex, { ...RECORD, retained: true });

    const aged = new Date(NOW - MAX_PUBLISHED_PIZZA_INDEX_AGE_MS - 1).toISOString();
    const stale = await capturePizzaIndex(args(await rootWith({ '2026-11-02': { pizzaIndex: { ...RECORD, updatedAt: aged } } })));
    assert.equal(stale.pizzaIndex, null);
  });
});
