import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function readRepo(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function parseYahooSymbols(source) {
  const match = source.match(/const YAHOO_SYMBOLS = \[([^\]]+)\];/);
  assert.ok(match, 'YAHOO_SYMBOLS declaration not found');
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, symbol]) => symbol);
}

function parseCnnEndpoint(source) {
  const match = source.match(/fetch\('https:\/\/([^']*\/index\/fearandgreed\/current)'/);
  assert.ok(match, 'CNN Fear & Greed current endpoint not found in seeder');
  return match[1];
}

function parseAaiiAnchors(source) {
  const bull = source.match(/bullPercentile\s*=\s*clamp\(\(bullPct\s*\/\s*(\d+)\)\s*\*\s*100,\s*0,\s*100\)/);
  const bear = source.match(/bearPercentile\s*=\s*clamp\(\(bearPct\s*\/\s*(\d+)\)\s*\*\s*100,\s*0,\s*100\)/);
  assert.ok(bull, 'AAII bull anchor not found in seeder');
  assert.ok(bear, 'AAII bear anchor not found in seeder');
  return { bull: Number(bull[1]), bear: Number(bear[1]) };
}

function parseMomentumSectorEtfs(source) {
  const match = source.match(/sectorCloses:\s*\{([^}]+)\}/);
  assert.ok(match, 'momentum sectorCloses mapping not found in seeder');
  return [...match[1].matchAll(/\b([A-Z]{3,4}):/g)].map(([, symbol]) => symbol);
}

function parseFsiBands(source) {
  const thresholdBands = [...source.matchAll(/(?:if|else if)\s*\(fsiValue\s*>=\s*([0-9.]+)\)\s*fsiLabel\s*=\s*'([^']+)'/g)]
    .map(([, threshold, label]) => ({ threshold, label }));
  const fallback = source.match(/else\s*fsiLabel\s*=\s*'([^']+)'/);
  assert.equal(thresholdBands.length, 3, 'expected three thresholded FSI bands in seeder');
  assert.ok(fallback, 'expected fallback FSI band in seeder');
  return [...thresholdBands, { threshold: null, label: fallback[1] }];
}

function parseEuCissBands(source) {
  const fnBody = source.match(/function classifyLabel\([^)]*\)\s*\{([^}]+)\}/)?.[1];
  assert.ok(fnBody, 'classifyLabel function not found in EU FSI seeder');
  const matches = [...fnBody.matchAll(/if\s*\(value\s*<\s*([0-9.]+)\)\s*return\s*'([^']+)'/g)]
    .map(([, upperExclusive, label]) => ({ upperExclusive, label }));
  const fallback = fnBody.match(/return\s*'([^']+)'/);
  assert.equal(matches.length, 3, 'expected three upper-bound EU CISS bands in seeder');
  assert.ok(fallback, 'expected fallback EU CISS band in seeder');
  return [...matches, { upperExclusive: null, label: fallback[1] }];
}

function compactComparisonWhitespace(text) {
  return text.replace(/\s+/g, '');
}

describe('market and health methodology docs match source contracts', () => {
  const fearGreedDoc = readRepo('docs/fear-greed-index-2.0-brief.md');
  const fearGreedSeeder = readRepo('scripts/seed-fear-greed.mjs');
  const fearGreedProto = readRepo('proto/worldmonitor/market/v1/get_fear_greed_index.proto');
  const marketOpenApi = readRepo('docs/api/MarketService.openapi.yaml');
  const fsiPanelDoc = readRepo('docs/panels/fsi.mdx');
  const fsiEuSeeder = readRepo('scripts/seed-fsi-eu.mjs');
  const diseaseMethodology = readRepo('docs/methodology/disease-alert-level.mdx');

  it('documents the current Fear & Greed data sources and derived inputs', () => {
    const cnnEndpoint = parseCnnEndpoint(fearGreedSeeder);
    const { bull, bear } = parseAaiiAnchors(fearGreedSeeder);
    const sectorEtfs = parseMomentumSectorEtfs(fearGreedSeeder);
    const yahooSymbols = new Set(parseYahooSymbols(fearGreedSeeder));

    assert.equal(yahooSymbols.size, 22, 'Yahoo source universe should stay aligned with docs and seeder comment');
    assert.match(fearGreedSeeder, /Yahoo Finance fetching \(22 symbols, 150ms gaps\)/);
    assert.ok(fearGreedDoc.includes(cnnEndpoint), `Fear & Greed doc must include CNN endpoint ${cnnEndpoint}`);
    assert.doesNotMatch(fearGreedDoc, /graphdata\/\{date\}/);
    assert.match(fearGreedDoc, new RegExp(`AAII_Bull_Percentile = clamp\\(bull% / ${bull} \\* 100, 0, 100\\)`));
    assert.match(fearGreedDoc, new RegExp(`AAII_Bear_Percentile = clamp\\(bear% / ${bear} \\* 100, 0, 100\\)`));
    assert.equal(sectorEtfs.length, 11, 'seeder should keep all 11 GICS sector ETFs in momentum sector RSI');
    for (const symbol of sectorEtfs) {
      assert.ok(yahooSymbols.has(symbol), `sector RSI ETF ${symbol} should be fetched from Yahoo`);
    }
    assert.ok(fearGreedDoc.includes(`all ${sectorEtfs.length} GICS sector ETFs: ${sectorEtfs.join(', ')}`));
    assert.ok(fearGreedDoc.includes(`Yahoo Finance | ${yahooSymbols.size} symbols`));
  });

  it('documents the bespoke Fear & Greed header FSI separately from the FSI panel', () => {
    const formula = /\(HYG \/ TLT\) \/ \(VIX \* HY(?:_OAS| OAS) \/ 100\)/;
    const bands = parseFsiBands(fearGreedSeeder);

    assert.match(
      fearGreedSeeder,
      /fsiValue\s*=\s*Math\.round\(\(\(hygPrice \/ tltPrice\) \/ \(vixLive \* hySpreadVal \/ 100\)\) \* 10000\) \/ 10000/,
      'seeder should compute the documented header FSI formula',
    );

    for (const [label, text] of [
      ['fear-greed doc', fearGreedDoc],
      ['fear-greed proto', fearGreedProto],
      ['MarketService OpenAPI', marketOpenApi],
    ]) {
      assert.match(text, formula, `${label} must document the header FSI formula`);
      assert.match(text, /KCFSI\/ECB FSI panel|KCFSI or ECB CISS\/EU FSI composite|KCFSI\/ECB FSI/, `${label} must distinguish the header FSI from the panel composite`);
    }

    for (const { threshold, label } of bands) {
      assert.ok(fearGreedDoc.includes(label), `fear-greed doc must include FSI band ${label}`);
      assert.ok(fearGreedProto.includes(label), `fear-greed proto must include FSI band ${label}`);
      assert.ok(marketOpenApi.includes(label), `MarketService OpenAPI must include FSI band ${label}`);
      if (threshold != null) {
        const thresholdText = `>=${threshold}`;
        assert.ok(compactComparisonWhitespace(fearGreedDoc).includes(thresholdText), `fear-greed doc must include FSI threshold ${thresholdText}`);
        assert.ok(compactComparisonWhitespace(fearGreedProto).includes(thresholdText), `fear-greed proto must include FSI threshold ${thresholdText}`);
        assert.ok(compactComparisonWhitespace(marketOpenApi).includes(thresholdText), `MarketService OpenAPI must include FSI threshold ${thresholdText}`);
      }
    }
  });

  it('documents implemented disease source paths without the old RSS source names', () => {
    assert.match(diseaseMethodology, /CDC HAN and Outbreak News Today RSS/);
    assert.match(diseaseMethodology, /ThinkGlobalHealth disease tracker, backed by ProMED-sourced real-time alerts/);
    assert.doesNotMatch(diseaseMethodology, /HealthMap \/ ProMED RSS/);
  });

  it('documents EU FSI as the daily ECB SS_CIN successor series', () => {
    const bands = parseEuCissBands(fsiEuSeeder);

    assert.match(fsiPanelDoc, /ECB CISS `SS_CIN` daily series/);
    assert.match(fsiPanelDoc, /EU FSI is seeded daily/);
    assert.match(fsiPanelDoc, /legacy\s+`SS_CI` series/);
    assert.doesNotMatch(fsiPanelDoc, /Weekly for both KCFSI.*EU FSI/);

    for (const { upperExclusive, label } of bands) {
      assert.ok(fsiPanelDoc.includes(`${label} Stress`), `FSI panel doc must include EU CISS band ${label}`);
      if (upperExclusive != null) {
        assert.ok(fsiPanelDoc.includes(`< ${upperExclusive}`), `FSI panel doc must include EU CISS cutoff < ${upperExclusive}`);
      }
    }
    assert.ok(fsiPanelDoc.includes('>= 0.6'), 'FSI panel doc must include EU CISS High cutoff >= 0.6');
  });
});
