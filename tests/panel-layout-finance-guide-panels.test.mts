import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('panel-layout finance guide panel recovery', () => {
  const filePath = new URL('../src/app/panel-layout.ts', import.meta.url);

  it('keeps the finance guide recovery hook and targets both guide panels', async () => {
    const source = await readFile(filePath, 'utf8');

    assert.match(source, /private ensureFinanceGuidePanelsVisible\(\): void \{/);
    assert.match(source, /SITE_VARIANT !== 'finance'/);
    assert.match(source, /const guideKeys = \['portfolio-impact', 'idea-radar'\] as const;/);
    assert.match(source, /config && config\.enabled === false/);
    assert.match(source, /panel\.show\(\);/);
    assert.match(source, /this\.ensureFinanceGuidePanelsVisible\(\);/);
  });

  it('defaults data-heavy mobile variants to collapsed when no preference is stored', async () => {
    const source = await readFile(filePath, 'utf8');

    assert.match(source, /const hasStoredPreference = stored === 'true' \|\| stored === 'false';/);
    assert.match(source, /const defaultCollapsedVariants = new Set\(\['full', 'finance', 'tech', 'energy', 'commodity'\]\);/);
    assert.match(source, /const collapsed = hasStoredPreference \? stored === 'true' : defaultCollapsedVariants\.has\(SITE_VARIANT\);/);
    assert.match(source, /localStorage\.setItem\('mobile-map-collapsed', 'true'\);/);
  });

  it('keeps variant priority panels ahead of generic live-news ordering', async () => {
    const source = await readFile(filePath, 'utf8');

    assert.match(source, /private prioritizePanelsForVariant\(order: string\[\]\): string\[\] \{/);
    assert.match(source, /finance: \['portfolio-impact', 'idea-radar', 'markets', 'macro-signals', 'live-news'\],/);
    assert.match(source, /full: \['live-news', 'insights', 'strategic-posture', 'forecast', 'strategic-risk', 'markets'\],/);
    assert.match(source, /tech: \['live-news', 'insights', 'tech-readiness', 'security', 'service-status', 'markets'\],/);
    assert.match(source, /energy: \['energy-risk-overview', 'chokepoint-strip', 'pipeline-status', 'energy-complex', 'live-news', 'insights'\],/);
    assert.match(source, /commodity: \['live-news', 'insights', 'markets', 'commodities', 'macro-signals', 'supply-chain'\],/);
    assert.match(source, /allOrder = this\.prioritizePanelsForVariant\(valid\);/);
    assert.match(source, /const hasCustomPriorityVariant = \['finance', 'full', 'tech', 'energy', 'commodity'\]\.includes\(SITE_VARIANT\);/);
    assert.match(source, /if \(hasCustomPriorityVariant\) \{/);
  });
});
