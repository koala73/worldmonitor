import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const VALUES = { USA: { 2026: 1 }, FRA: { 2026: 2 } };

function distinctReleaseFor(indicator) {
  const day = String([...indicator].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 28 + 1).padStart(2, '0');
  return { publishedAt: `2000-01-${day}T00:00:00Z`, updatedAt: `2000-02-${day}T00:00:00Z` };
}

async function loadSeeder(file, t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-16T00:00:00Z') });
  globalThis.__imfReleaseFor = distinctReleaseFor;
  globalThis.__imfValues = VALUES;
  t.after(() => { delete globalThis.__imfReleaseFor; delete globalThis.__imfValues; });
  const result = await build({
    entryPoints: [new URL(`../scripts/${file}`, import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'fixture-only-seed-boundary', setup(builder) {
      builder.onResolve({ filter: /_seed-utils\.mjs$/ }, () => ({ path: 'fixture-utils', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const loadEnvFile = () => {};
        export const loadSharedConfig = () => ({US:'USA', FR:'FRA'});
        export const imfSdmxFetchIndicatorWithRelease = async indicator => ({ values: globalThis.__imfValues, release: globalThis.__imfReleaseFor(indicator) });
        export const imfSdmxFetchIndicator = async () => globalThis.__imfValues;
        export const runSeed = () => { throw new Error('Live seed execution forbidden'); };
      ` }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

test('macro stores each displayed metric with its own indicator release', async t => {
  const data = await (await loadSeeder('seed-imf-macro.mjs', t)).fetchImfMacro();
  assert.deepEqual(data.releases, {
    inflationPct: distinctReleaseFor('PCPIPCH'),
    primaryBalancePct: distinctReleaseFor('GGXONLB_NGDP'),
    govExpenditurePct: distinctReleaseFor('GGX_NGDP'),
    govRevenuePct: distinctReleaseFor('GGR_NGDP'),
  });
  assert.equal(data.countries.US.inflationPct, 1);
  assert.equal(data.seededAt, '2026-10-16T00:00:00.000Z');
});

test('growth stores each displayed metric with its own indicator release', async t => {
  const data = await (await loadSeeder('seed-imf-growth.mjs', t)).fetchImfGrowth();
  assert.deepEqual(data.releases, {
    realGdpGrowthPct: distinctReleaseFor('NGDP_RPCH'),
    gdpPerCapitaUsd: distinctReleaseFor('NGDPDPC'),
  });
  assert.equal(data.countries.FR.realGdpGrowthPct, 2);
  assert.equal(data.countries.FR.gdpPerCapitaUsd, 2);
});

test('labor stores the unemployment indicator release', async t => {
  const data = await (await loadSeeder('seed-imf-labor.mjs', t)).fetchImfLabor();
  assert.deepEqual(data.releases, { unemploymentPct: distinctReleaseFor('LUR') });
  assert.equal(data.countries.US.unemploymentPct, 1);
});
