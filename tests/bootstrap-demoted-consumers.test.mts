import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

function method(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `cannot isolate ${start}`);
  return source.slice(from, to);
}

test('FAST-demoted consumers use demand-gated public hydration without miss-to-RPC fallback', () => {
  const loader = read('src/app/data-loader.ts');
  const forecasts = method(loader, '  async loadForecasts()', '  async loadSimulationOutcome(');
  const correlation = read('src/components/CorrelationPanel.ts');
  const correlationLoader = read('src/services/correlation-snapshots.ts');
  const correlationRefresh = method(correlationLoader, 'async function refresh()', 'function tick()');

  assert.match(forecasts, /await ensureHydrated\('forecasts'\)/);
  assert.doesNotMatch(forecasts, /fetchForecastFeed|getForecasts/);
  assert.match(forecasts, /showError[\s\S]*loadForecasts/);

  assert.match(correlationLoader, /ensureHydrated\('correlationCards'\)/);
  assert.match(correlation, /observeNearViewport\(\(\) => \{[\s\S]*subscribeCorrelationSnapshot[\s\S]*\}, 400\)/);
  assert.match(
    correlationRefresh,
    /waitForBootstrapSlowTier\(3_500\)[\s\S]*getHydratedData\('correlationCards'\)[\s\S]*ensureHydrated\('correlationCards'\)/,
    'rolling deploys must re-read the old SLOW response before trying the new per-key URL',
  );
  assert.doesNotMatch(correlationLoader, /ServiceClient|\/api\/.*\/v1\//);
});
