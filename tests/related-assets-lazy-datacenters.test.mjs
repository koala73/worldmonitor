import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const relatedAssetsSrc = readFileSync(resolve(root, 'src/services/related-assets.ts'), 'utf8');
const countryIntelSrc = readFileSync(resolve(root, 'src/app/country-intel.ts'), 'utf8');
const newsPanelSrc = readFileSync(resolve(root, 'src/components/NewsPanel.ts'), 'utf8');

describe('related-assets lazy datacenter table contract', () => {
  it('keeps failed lazy datacenter imports retryable instead of caching empty results', () => {
    assert.match(
      relatedAssetsSrc,
      /export function preloadDatacenterIndex\(\): Promise<void>/,
      'related-assets must expose a preload promise for one-shot render callers',
    );
    assert.match(
      relatedAssetsSrc,
      /\.catch\(\(error\) => \{\s*datacenterIndexPromise = null;\s*throw error;\s*\}\)/s,
      'failed imports must clear the in-flight promise so a later render can retry',
    );
    assert.ok(
      !/catch\([^)]*\)\s*=>\s*\{\s*datacenterIndex\s*=\s*\[\]/s.test(relatedAssetsSrc),
      'failed imports must not poison the session with a permanently empty datacenter index',
    );
  });

  it('refreshes one-shot related-asset renderers after the lazy infrastructure chunks resolve', () => {
    const preloadBlockStart = countryIntelSrc.indexOf(
      'void Promise.all([',
      countryIntelSrc.indexOf('page.updateInfrastructure(code);'),
    );
    assert.notEqual(preloadBlockStart, -1, 'country brief should preload lazy related-asset tables after first render');
    const preloadBlockEnd = countryIntelSrc.indexOf('const intelClient =', preloadBlockStart);
    assert.notEqual(preloadBlockEnd, -1, 'country brief preload block should precede intelligence client setup');
    const preloadBlock = countryIntelSrc.slice(preloadBlockStart, preloadBlockEnd);
    assert.match(preloadBlock, /preloadInfrastructureTables\(\)/);
    assert.match(preloadBlock, /countryBriefPage\.updateInfrastructure\(code\)/);
    assert.match(
      newsPanelSrc,
      /preloadRelatedAssetTables\(titles\)\s*[\r\n\s.]+then\(\(shouldRefresh\) => \{[\s\S]*?if \(shouldRefresh && this\.lastRawClusters\)/,
      'clustered news related assets should re-render only when a lazy table actually loaded',
    );
  });

  it('preloads every detected lazy related-asset table before the one-shot refresh', () => {
    assert.match(
      relatedAssetsSrc,
      /types\.includes\(['"]datacenter['"]\)[\s\S]*?preloadDatacenterIndex\(\)/,
      'datacenter-related clusters should preload the datacenter table before refreshing',
    );
    assert.match(
      relatedAssetsSrc,
      /types\.includes\(['"]cable['"]\)[\s\S]*?preloadCableIndex\(\)/,
      'cable-related clusters should preload the cable table before refreshing',
    );
    assert.match(
      relatedAssetsSrc,
      /types\.includes\(['"]nuclear['"]\)[\s\S]*?preloadNuclearFacilities\(\)/,
      'nuclear-related clusters should preload the nuclear table before refreshing',
    );
    assert.match(
      relatedAssetsSrc,
      /Promise\.allSettled\(preloadTasks\)[\s\S]*?status === ['"]fulfilled['"]/,
      'mixed lazy table preloads should still refresh when at least one table resolves',
    );
  });
});

describe('geo-map lazy table contract (#4404)', () => {
  const infraCascadeSrc = readFileSync(resolve(root, 'src/services/infrastructure-cascade.ts'), 'utf8');
  const cableActivitySrc = readFileSync(resolve(root, 'src/services/cable-activity.ts'), 'utf8');

  it('lazy-loads UNDERSEA_CABLES + NUCLEAR_FACILITIES from geo-map, not the eager barrel', () => {
    for (const re of [
      /import\(['"]@\/config\/geo-map['"]\)[\s\S]*?UNDERSEA_CABLES/,
      /import\(['"]@\/config\/geo-map['"]\)[\s\S]*?NUCLEAR_FACILITIES/,
    ]) {
      assert.match(relatedAssetsSrc, re, 'related-assets must dynamic-import cable/nuclear tables from geo-map');
    }
    assert.ok(
      !/import\s*\{[^}]*\b(UNDERSEA_CABLES|NUCLEAR_FACILITIES)\b[^}]*\}\s*from\s*['"]@\/config(\/geo)?['"]/s.test(relatedAssetsSrc),
      'related-assets must not statically import the moved tables from the eager barrel',
    );
  });

  it('keeps failed geo-map imports retryable (no permanently-empty cache)', () => {
    assert.match(
      relatedAssetsSrc,
      /cableIndexPromise = null;\s*throw error;/s,
      'a failed cable import must clear the in-flight promise so a later query retries',
    );
    assert.match(
      relatedAssetsSrc,
      /nuclearFacilitiesPromise = null;\s*throw error;/s,
      'a failed nuclear import must clear the in-flight promise so a later query retries',
    );
  });

  it('infrastructure-cascade + cable-activity lazy-load cables and clear the graph cache on load', () => {
    assert.ok(
      !/import\s*\{[^}]*\bUNDERSEA_CABLES\b[^}]*\}\s*from\s*['"]@\/config(\/geo)?['"]/s.test(infraCascadeSrc),
      'infrastructure-cascade must not statically import UNDERSEA_CABLES',
    );
    assert.match(
      infraCascadeSrc,
      /import\(['"]@\/config\/geo-map['"]\)[\s\S]*?UNDERSEA_CABLES[\s\S]*?clearGraphCache\(\)/,
      'infrastructure-cascade must lazy-import cables and rebuild the graph once they resolve',
    );
    assert.ok(
      !/import\s*\{[^}]*\bUNDERSEA_CABLES\b[^}]*\}\s*from\s*['"]@\/config(\/geo)?['"]/s.test(cableActivitySrc),
      'cable-activity must not statically import UNDERSEA_CABLES',
    );
    assert.match(
      cableActivitySrc,
      /import\(['"]@\/config\/geo-map['"]\)/,
      'cable-activity must lazy-import cables from geo-map',
    );
    assert.match(
      cableActivitySrc,
      /let cablesDataPromise: Promise<void> \| null = null;/,
      'cable-activity should keep a shared in-flight cable table import promise',
    );
    assert.match(
      cableActivitySrc,
      /if \(!cablesDataPromise\) \{[\s\S]*?import\(['"]@\/config\/geo-map['"]\)[\s\S]*?cablesDataPromise = null;\s*throw error;/,
      'cable-activity should coalesce concurrent imports while keeping failed imports retryable',
    );
  });
});
