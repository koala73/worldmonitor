// /pro names the buyer jobs before the feature lists: each job card links a
// published use-case workflow and a dashboard view the URL parser accepts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { USE_CASE_PAGES } from '../scripts/build-use-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8');

const app = read('pro-test/src/App.tsx');
const overview = read('pro-test/index.html');
const layerKeys = new Set(
  [...read('src/config/map-layer-definitions.ts').matchAll(/^\s+(\w+):\s+def\(/gm)].map((m) => m[1]),
);
const useCasePaths = new Set(USE_CASE_PAGES.map((page) => page.path));

const proJobsBlock = app.match(/const PRO_JOBS = \[([\s\S]*?)\] as const;/)?.[1];

describe('/pro job section', () => {
  it('renders before the feature pillars', () => {
    assert.ok(proJobsBlock, 'PRO_JOBS must be defined in App.tsx');
    assert.match(app, /<SourceMarquee \/>\s*<ProJobs \/>\s*<Pillars \/>/);
  });

  it('links each job to a published use-case workflow', () => {
    const hrefs = [...proJobsBlock.matchAll(/workflowHref: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(hrefs, ['/use-cases/monitor-supply-chain-disruptions/', '/use-cases/verify-breaking-news/']);
    for (const href of hrefs) assert.ok(useCasePaths.has(href), `${href} must be a published use case`);
  });

  it('opens dashboard views with layers the dashboard accepts', () => {
    const mapPaths = [...proJobsBlock.matchAll(/mapPath: `\$\{DASHBOARD_URL\}\?([^`]+)`/g)].map((m) => m[1]);
    assert.equal(mapPaths.length, 2);
    for (const query of mapPaths) {
      const params = new URLSearchParams(query);
      const layers = params.get('layers')?.split(',') ?? [];
      assert.ok(layers.length > 0, `${query} must name layers`);
      for (const layer of layers) assert.ok(layerKeys.has(layer), `unknown layer ${layer}`);
      assert.ok(['1h', '6h', '24h', '48h', '7d', 'all'].includes(params.get('timeRange')), `${query} timeRange`);
    }
  });

  it('puts the jobs in the crawlable overview ahead of the feature lists', () => {
    const jobs = overview.indexOf('<h2>What can you get done with World Monitor Pro?</h2>');
    const features = overview.indexOf('<h2>What does World Monitor Pro include?</h2>');
    assert.ok(jobs > 0 && jobs < features, 'job section must precede the feature list');
    const section = overview.slice(jobs, features);
    for (const href of ['/use-cases/monitor-supply-chain-disruptions/', '/use-cases/verify-breaking-news/', '/use-cases/']) {
      assert.ok(section.includes(`href="${href}"`), `overview must link ${href}`);
    }
  });
});
