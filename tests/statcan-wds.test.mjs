import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CPI_VECTOR_ID,
  LFS_UNEMPLOYMENT_VECTOR_ID,
  STATCAN_WDS_HOST,
  WDS_VECTORS_URL,
  buildStatcanPayload,
  changedCubeListUrl,
  computeCpiYoy,
  declareStatcanRecords,
  fetchApprovedWdsJson,
  parseChangedCubeList,
  parseVectorSeries,
  statcanCacheKey,
  utcDateIso,
  validateStatcanPayload,
} from '../scripts/lib/statcan-wds.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const changedDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/statcan-wds/changed-cube-list.json'), 'utf8'));
const emptyDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/statcan-wds/changed-cube-list-empty.json'), 'utf8'));
const vectorDoc = JSON.parse(readFileSync(resolve(here, 'fixtures/statcan-wds/cpi-lfs-vectors.json'), 'utf8'));
const libSrc = readFileSync(resolve(here, '../scripts/lib/statcan-wds.mjs'), 'utf8');
const seederSrc = readFileSync(resolve(here, '../scripts/seed-statcan-wds.mjs'), 'utf8');
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');

test('UTC date path is required in the change-list URL and cache key', () => {
  assert.equal(utcDateIso(Date.parse('2026-08-13T21:49:00Z')), '2026-08-13');
  const url = changedCubeListUrl('2026-08-13');
  assert.equal(url, 'https://www150.statcan.gc.ca/t1/wds/rest/getChangedCubeList/2026-08-13');
  assert.ok(statcanCacheKey(url).includes('2026-08-13'));
  assert.ok(statcanCacheKey(url).includes('/getChangedCubeList/2026-08-13'));
});

test('empty WDS change-list is valid quiet, not an error', () => {
  const cubes = parseChangedCubeList(emptyDoc);
  assert.deepEqual(cubes, []);
  const payload = buildStatcanPayload({
    asOfDate: '2026-08-13',
    changedCubes: cubes,
    cpiSeries: parseVectorSeries(vectorDoc, CPI_VECTOR_ID),
    lfsSeries: parseVectorSeries(vectorDoc, LFS_UNEMPLOYMENT_VECTOR_ID),
    seededAtMs: Date.parse('2026-08-13T21:00:00Z'),
  });
  assert.equal(payload.changedCount, 0);
  assert.equal(validateStatcanPayload(payload), true);
});

test('captured change-list and CPI/LFS vectors feed the resilience CA series', () => {
  const cubes = parseChangedCubeList(changedDoc);
  assert.ok(cubes.length >= 1);
  assert.equal(cubes[0].productId, 33100036);

  const cpi = parseVectorSeries(vectorDoc, CPI_VECTOR_ID);
  const yoy = computeCpiYoy(cpi.points);
  assert.equal(yoy.refPer, '2026-06-01');
  assert.equal(Number(yoy.inflationPct.toFixed(2)), 2.8);

  const lfs = parseVectorSeries(vectorDoc, LFS_UNEMPLOYMENT_VECTOR_ID);
  const payload = buildStatcanPayload({
    asOfDate: '2026-08-13',
    changedCubes: cubes,
    cpiSeries: cpi,
    lfsSeries: lfs,
    seededAtMs: Date.parse('2026-08-13T21:00:00Z'),
  });
  assert.equal(payload.unemploymentPct, 6.4);
  assert.equal(payload.unemploymentRefPer, '2026-07-01');
  assert.equal(payload.inflationRefPer, '2026-06-01');
  assert.equal(validateStatcanPayload(payload), true);
  assert.ok(declareStatcanRecords(payload) >= 2);
});

test('allowlist rejects a non-WDS host, errors on redirects, and sends Chrome UA', async () => {
  const url = changedCubeListUrl('2026-08-13');
  await assert.rejects(
    fetchApprovedWdsJson('https://example.com/t1/wds/rest/getChangedCubeList/2026-08-13'),
    /UNTRUSTED_SOURCE_HOST/,
  );

  let init;
  const cache = new Map();
  const doc = await fetchApprovedWdsJson(url, {
    fetchFn: async (_url, options) => {
      init = options;
      return new Response(JSON.stringify(emptyDoc), { headers: { 'content-type': 'application/json' } });
    },
    cache,
  });
  assert.equal(init.redirect, 'error');
  assert.match(init.headers['User-Agent'], /Chrome/);
  assert.equal(doc.status, 'SUCCESS');
  assert.ok(cache.has(statcanCacheKey(url)));
  assert.equal(STATCAN_WDS_HOST, 'www150.statcan.gc.ca');
  assert.match(WDS_VECTORS_URL, /www150\.statcan\.gc\.ca/);
});

test('tests import the lib, not the seeder main; neither binds fetch', () => {
  assert.doesNotMatch(testSrc, /from ['"][^'"]*seed-statcan-wds/);
  assert.doesNotMatch(libSrc, /fetch\.bind/);
  assert.doesNotMatch(seederSrc, /fetch\.bind/);
  assert.doesNotMatch(libSrc, /fetch\.bind\(globalThis\)/);
  assert.match(seederSrc, /from '\.\/lib\/statcan-wds\.mjs'/);
});
