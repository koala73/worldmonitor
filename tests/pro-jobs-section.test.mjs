// /pro names its buyers before the feature lists: one grid of six buyers, each
// with its job, what Pro adds, and a published use-case workflow.

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
const en = JSON.parse(read('pro-test/src/locales/en.json'));
const useCasePaths = new Set(USE_CASE_PAGES.map((page) => page.path));

const buyersBlock = app.match(/const PRO_BUYERS = \[([\s\S]*?)\] as const;/)?.[1];
const buyers = [...(buyersBlock ?? '').matchAll(/key: '(\w+)'[^\n]*workflowHref: '([^']+)'/g)]
  .map((m) => ({ key: m[1], href: m[2] }));

describe('/pro buyer section', () => {
  it('renders one buyer grid before the feature pillars, with no second persona section', () => {
    assert.ok(buyersBlock, 'PRO_BUYERS must be defined in App.tsx');
    assert.match(app, /<SourceMarquee \/>\s*<ProJobs \/>\s*<Pillars \/>/);
    assert.doesNotMatch(app, /AudiencePersonas/, 'the generic persona grid duplicated the buyer grid');
  });

  it('covers six buyers, each with a job, a Pro line and a distinct published workflow', () => {
    assert.deepEqual(buyers.map((b) => b.key), ['investors', 'traders', 'researchers', 'journalists', 'gov', 'teams']);
    assert.equal(new Set(buyers.map((b) => b.href)).size, buyers.length, 'each buyer links its own guide');
    for (const { key, href } of buyers) {
      assert.ok(useCasePaths.has(href), `${href} must be a published use case`);
      assert.ok(en.audience[`${key}Title`], `audience.${key}Title`);
      assert.ok(en.proJobs[`${key}Job`], `proJobs.${key}Job`);
      assert.ok(en.proJobs[`${key}Pro`], `proJobs.${key}Pro`);
    }
  });

  it('names each card link after its buyer so screen-reader link lists can tell them apart', () => {
    const component = app.match(/const ProJobs = \(\) => \(([\s\S]*?)\n\);/)?.[1];
    assert.ok(component, 'ProJobs must be defined in App.tsx');
    assert.match(component, /<h3 id=\{`job-\$\{buyer\.key\}-title`\}/);
    assert.match(component, /<span id=\{`job-\$\{buyer\.key\}-workflow`\}>/);
    const cardLinks = [...component.matchAll(/<a href=\{buyer\.workflowHref\}[^>]*>/g)].map((m) => m[0]);
    assert.equal(cardLinks.length, 1);
    assert.match(cardLinks[0], /aria-labelledby=\{`job-\$\{buyer\.key\}-workflow job-\$\{buyer\.key\}-title`\}/);
    assert.match(component, /<a href="\/use-cases\/"/, 'the grid ends with a link to every workflow');
  });

  it('puts the buyers in the crawlable overview ahead of the feature lists', () => {
    const jobs = overview.indexOf(`<h2>${en.audience.title}</h2>`);
    const features = overview.indexOf('<h2>What does World Monitor Pro include?</h2>');
    assert.ok(jobs > 0 && jobs < features, 'buyer section must precede the feature list');
    const section = overview.slice(jobs, features);
    for (const href of [...buyers.map((b) => b.href), '/use-cases/']) {
      assert.ok(section.includes(`href="${href}"`), `overview must link ${href}`);
    }
  });
});
