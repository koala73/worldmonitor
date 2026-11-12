// /pro conversion audit item 7 (2026-11-06): every /pro heading was a
// search-style question (PR #7385). For a buyer, the first two sections read
// like an FAQ. They now state the benefit; every heading below them stays a
// question, because those still serve search and answer engines, including
// "How much does World Monitor cost?", which matches a real query. Homepage
// headings are out of scope: tests/pro-welcome-prerender.test.mjs pins them
// as answer passages.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(join(repoRoot, 'pro-test/src/locales/en.json'), 'utf8'));

describe('/pro headings', () => {
  it('opens with benefit statements, not questions', () => {
    assert.equal(en.whyUpgrade.title, 'Hear about it before the headlines');
    assert.equal(en.proShowcase.title, 'An AI analyst for stocks, macro and geopolitics');
  });

  it('backs each benefit with the section it heads', () => {
    assert.match(en.whyUpgrade.noiseDesc, /Signal, not headlines/);
    assert.match(en.whyUpgrade.noiseDesc, /in under a minute/);
    assert.match(en.proShowcase.subtitle, /Stocks, macro, geopolitical risk/);
  });

  it('keeps the lower headings as answer-shaped questions', () => {
    for (const title of [
      en.pricing.headerTitle,
      en.pricingTable.title,
      en.apiSection.title,
      en.enterpriseShowcase.title,
    ]) {
      assert.match(title, /\?$/, `${title} stays a question`);
    }
    assert.equal(en.pricing.headerTitle, 'How much does World Monitor cost?');
  });
});
