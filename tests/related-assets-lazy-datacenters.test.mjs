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

  it('refreshes one-shot related-asset renderers after the datacenter chunk resolves', () => {
    assert.match(
      countryIntelSrc,
      /preloadDatacenterIndex\(\)\s*[\r\n\s.]+then\(\(\) => \{[\s\S]*?countryBriefPage\.updateInfrastructure\(code\)/,
      'country brief infrastructure should re-render after the lazy datacenter table resolves',
    );
    assert.match(
      newsPanelSrc,
      /preloadRelatedAssetTables\(titles\)\s*[\r\n\s.]+then\(\(shouldRefresh\) => \{[\s\S]*?if \(shouldRefresh && this\.lastRawClusters\)/,
      'clustered news related assets should re-render only when a lazy table actually loaded',
    );
  });
});
