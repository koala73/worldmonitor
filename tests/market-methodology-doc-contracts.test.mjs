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

describe('market and health methodology docs match source contracts', () => {
  const fearGreedDoc = readRepo('docs/fear-greed-index-2.0-brief.md');
  const fearGreedProto = readRepo('proto/worldmonitor/market/v1/get_fear_greed_index.proto');
  const marketOpenApi = readRepo('docs/api/MarketService.openapi.yaml');
  const fsiPanelDoc = readRepo('docs/panels/fsi.mdx');
  const diseaseMethodology = readRepo('docs/methodology/disease-alert-level.mdx');

  it('documents the current Fear & Greed data sources and derived inputs', () => {
    assert.match(fearGreedDoc, /production\.dataviz\.cnn\.io\/index\/fearandgreed\/current/);
    assert.doesNotMatch(fearGreedDoc, /graphdata\/\{date\}/);
    assert.match(fearGreedDoc, /AAII_Bull_Percentile = clamp\(bull% \/ 60 \* 100, 0, 100\)/);
    assert.match(fearGreedDoc, /AAII_Bear_Percentile = clamp\(bear% \/ 55 \* 100, 0, 100\)/);
    assert.match(fearGreedDoc, /all 11 GICS sector ETFs: XLK, XLF, XLE, XLV, XLY, XLP, XLI, XLB, XLU, XLRE, XLC/);
  });

  it('documents the bespoke Fear & Greed header FSI separately from the FSI panel', () => {
    const formula = /\(HYG \/ TLT\) \/ \(VIX \* HY(?:_OAS| OAS) \/ 100\)/;
    const bands = /Low Stress[\s\S]*Moderate Stress[\s\S]*Elevated Stress[\s\S]*High Stress/;

    for (const [label, text] of [
      ['fear-greed doc', fearGreedDoc],
      ['fear-greed proto', fearGreedProto],
      ['MarketService OpenAPI', marketOpenApi],
    ]) {
      assert.match(text, formula, `${label} must document the header FSI formula`);
      assert.match(text, /KCFSI\/ECB FSI panel|KCFSI or ECB CISS\/EU FSI composite|KCFSI\/ECB FSI/, `${label} must distinguish the header FSI from the panel composite`);
    }

    assert.match(fearGreedDoc, bands);
    assert.match(fearGreedProto, /Low Stress \(>=1\.5\), Moderate Stress \(>=0\.8\)/);
    assert.match(marketOpenApi, /Low Stress \(>=1\.5\), Moderate Stress \(>=0\.8\)/);
  });

  it('documents implemented disease source paths without the old RSS source names', () => {
    assert.match(diseaseMethodology, /CDC HAN and Outbreak News Today RSS/);
    assert.match(diseaseMethodology, /ThinkGlobalHealth disease tracker, backed by ProMED-sourced real-time alerts/);
    assert.doesNotMatch(diseaseMethodology, /HealthMap \/ ProMED RSS/);
  });

  it('documents EU FSI as the daily ECB SS_CIN successor series', () => {
    assert.match(fsiPanelDoc, /ECB CISS `SS_CIN` daily series/);
    assert.match(fsiPanelDoc, /EU FSI is seeded daily/);
    assert.match(fsiPanelDoc, /legacy\s+`SS_CI` series/);
    assert.doesNotMatch(fsiPanelDoc, /Weekly for both KCFSI.*EU FSI/);
  });
});
