import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

describe('news to market correlation panel integration', () => {
  it('keeps topic, market, and window selectors plus explicit non-causal copy', () => {
    const source = read('src', 'components', 'NewsMarketCorrelationPanel.ts');

    assert.match(source, /data-role=\"news-topic\"/);
    assert.match(source, /data-role=\"market-symbol\"/);
    assert.match(source, /data-role=\"window-hours\"/);
    assert.match(source, /Correlation is not causation/);
    assert.match(source, /weak and null results are retained/i);
    assert.match(source, /95% interval/);
  });

  it('registers, primes, and refreshes the panel in market-bearing variants', () => {
    const panels = read('src', 'config', 'panels.ts');
    const app = read('src', 'App.ts');
    const layout = read('src', 'app', 'panel-layout.ts');

    assert.equal((panels.match(/'news-market-correlation': \{ name: 'News ↔ Markets', enabled: true/g) ?? []).length, 3);
    assert.match(layout, /lazyDefaultPanel\('news-market-correlation'/);
    assert.match(app, /primeTask\('news-market-correlation'/);
    assert.match(app, /REFRESH_INTERVALS\.newsMarketCorrelation/);
  });

  it('serves the persisted history through the on-demand bootstrap path', () => {
    const registry = read('shared', 'bootstrap-tier-keys.js');
    const bundle = read('scripts', 'seed-bundle-market-backup.mjs');

    assert.match(registry, /marketCorrelationSeries: 'market:correlation-series:v1'/);
    assert.match(registry, /'marketCorrelationSeries'/);
    assert.match(bundle, /script: 'seed-market-correlation-series\.mjs'/);
    assert.match(bundle, /label: 'Market-Correlation-Series'[^\n]+timeoutMs: 210_000/);
  });

  it('drops stale async selector responses before they can replace current state', () => {
    const source = read('src', 'components', 'NewsMarketCorrelationPanel.ts');

    assert.match(source, /const generation = \+\+this\.requestGeneration/);
    assert.match(source, /const selectedTopic = this\.selectedTopic/);
    assert.match(source, /const selectedSymbol = this\.selectedSymbol/);
    assert.match(source, /if \(generation !== this\.requestGeneration\) return false/);
  });

  it('enables COT positioning and labels the non-reportable proxy honestly', () => {
    const panels = read('src', 'config', 'panels.ts');
    const cot = read('src', 'components', 'CotPositioningPanel.ts');

    assert.match(panels, /'cot-positioning': \{ name: 'COT Positioning', enabled: true/);
    assert.match(cot, /Small Traders \(non-reportable\)/);
    assert.match(cot, /not historical releases, so a retail trend line is not shown/);
    assert.match(cot, /item\.smallTraderAvailable \? renderPositionBar/);
    assert.match(cot, /Small-trader positioning is unavailable until the next CFTC seed refresh/);
  });
});
