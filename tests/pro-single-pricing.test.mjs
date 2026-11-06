// /pro conversion audit item 5 (2026-11-06): a "Plans" section (#tiers) showed
// Pro and Enterprise with long feature lists and no prices, nine sections above
// the real price cards (#pricing), so pricing appeared twice. Its only buttons
// jumped to #pricing and #enterprise. It is removed; all five self-serve plans
// stay visible in #pricing (API Starter is about a third of MRR, so it is not
// hidden behind a tab). The nav's "Free" link pointed at #tiers, which had no
// Free plan; it now opens the price cards, where Free comes first.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(repoRoot, 'pro-test/src/App.tsx'), 'utf8');
const localeDir = join(repoRoot, 'pro-test/src/locales');

describe('/pro shows pricing once', () => {
  it('has no priceless Plans section', () => {
    assert.doesNotMatch(app, /TwoPathSplit/);
    assert.doesNotMatch(app, /id="tiers"/);
    assert.doesNotMatch(app, /t\('twoPath\./);
  });

  it('points the nav Free link at the price cards', () => {
    const nav = app.slice(app.indexOf('const Navbar = '), app.indexOf('const SignalBars = '));
    assert.match(nav, /<a href="#pricing"[^>]*>\{t\('nav\.free'\)\}<\/a>/);
    assert.doesNotMatch(nav, /#tiers/);
  });

  it('keeps every self-serve plan in the price grid', () => {
    const pricing = readFileSync(join(repoRoot, 'pro-test/src/components/PricingSection.tsx'), 'utf8');
    assert.match(pricing, /gridTiers\.map\(/);
    const tiers = JSON.parse(readFileSync(join(repoRoot, 'pro-test/src/generated/tiers.json'), 'utf8'));
    for (const key of ['free', 'pro', 'proBusiness', 'api', 'apiBusiness']) {
      assert.ok(tiers.some((tier) => tier.localeKey === key), `tiers.json still offers ${key}`);
    }
  });

  it('drops the removed section copy from every locale', () => {
    for (const file of readdirSync(localeDir).filter((name) => name.endsWith('.json'))) {
      const locale = JSON.parse(readFileSync(join(localeDir, file), 'utf8'));
      assert.equal(locale.twoPath, undefined, `${file} still carries twoPath`);
    }
  });
});
