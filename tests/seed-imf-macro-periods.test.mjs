import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('macro retains each displayed metric period without executing the live seed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-16T00:00:00Z') });
  const indicators = {
    PCPIPCH: { USA: { 2026: 0 }, FRA: { 2025: 2 }, WEOWORLD: { 2026: 3 }, XXX: { 2026: 4 } },
    GGXONLB_NGDP: { USA: { 2025: -7 } },
    GGX_NGDP: { USA: { 2024: 40 } },
    GGR_NGDP: { USA: { 2025: 30 } },
    BCA_NGDPD: { USA: { 2024: -3 } },
    PCPI: { USA: { 2026: 'NaN' } },
  };
  globalThis.__imfPeriodIndicators = indicators;
  t.after(() => { delete globalThis.__imfPeriodIndicators; });
  const result = await build({
    entryPoints: [new URL('../scripts/seed-imf-macro.mjs', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'fixture-only-seed-boundary', setup(builder) {
      builder.onResolve({ filter: /_seed-utils\.mjs$/ }, () => ({ path: 'fixture-utils', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const loadEnvFile = () => {};
        export const loadSharedConfig = () => ({US:'USA', FR:'FRA'});
        export const imfSdmxFetchIndicator = async indicator => globalThis.__imfPeriodIndicators[indicator] ?? {};
        export const imfSdmxFetchIndicatorWithRelease = async indicator => ({ values: globalThis.__imfPeriodIndicators[indicator] ?? {}, release: { publishedAt: null, updatedAt: null } });
        export const runSeed = () => { throw new Error('Live seed execution forbidden'); };
      ` }));
    } }],
  });
  const macro = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const data = await macro.fetchImfMacro();
  assert.deepEqual(data.countries.US.periods, { inflationPct: 2026, primaryBalancePct: 2025, govExpenditurePct: 2024, govRevenuePct: 2025, currentAccountPct: 2024 });
  assert.deepEqual(data.countries.FR.periods, { inflationPct: 2025, primaryBalancePct: null, govExpenditurePct: null, govRevenuePct: null, currentAccountPct: null });
  const { periods, ...legacy } = data.countries.US;
  assert.deepEqual(legacy, { inflationPct: 0, currentAccountPct: -3, govRevenuePct: 30, cpiIndex: null, cpiEopPct: null, govExpenditurePct: 40, primaryBalancePct: -7, year: 2026, latestYear: 2026 });
  assert.deepEqual(Object.keys(data.countries).sort(), ['FR', 'US']);
  assert.equal(data.seededAt, '2026-10-16T00:00:00.000Z');
});
