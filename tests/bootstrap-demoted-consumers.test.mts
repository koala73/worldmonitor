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
  const correlationLoader = method(
    correlation,
    'function loadCorrelationBootstrap()',
    '// Score-badge BACKGROUND colors.',
  );

  assert.match(forecasts, /await ensureHydrated\('forecasts'\)/);
  assert.doesNotMatch(forecasts, /fetchForecastFeed|getForecasts/);
  assert.match(forecasts, /showError[\s\S]*loadForecasts/);

  assert.match(correlation, /ensureHydrated\('correlationCards'\)/);
  assert.match(correlation, /observeNearViewport\(\(\) => this\.loadBootstrapCards\(\), 400\)/);
  assert.match(correlation, /showError[\s\S]*loadBootstrapCards/);
  assert.match(
    correlationLoader,
    /waitForBootstrapSlowTier\(\)[\s\S]*getHydratedData\('correlationCards'\)[\s\S]*ensureHydrated\('correlationCards'\)/,
    'rolling deploys must re-read the old SLOW response before trying the new per-key URL',
  );
  assert.match(
    correlationLoader,
    /correlationBootstrap === null\) correlationBootstrapPromise = null/,
    'empty reads must remain retryable',
  );
});
