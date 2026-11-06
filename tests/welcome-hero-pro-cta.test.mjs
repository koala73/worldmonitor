// The homepage hero offered "Launch the dashboard" and "See how people use it",
// and nothing on the first screen said a paid plan exists. The second button
// now names the Pro entry price and opens the /pro plans. The price comes from
// the generated product facts, never a literal, so it cannot drift from billing.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

describe('homepage hero names the Pro price', () => {
  const hero = read('pro-test/src/welcome/Hero.tsx');

  it('links the second hero button to the /pro plans and tracks it', () => {
    assert.match(hero, /href="\/pro#pricing"/);
    assert.match(hero, /data-umami-event-target="welcome-hero-pro"/);
    assert.match(hero, /t\('welcome\.hero\.ctaPro', \{ price: `\$\$\{copyStats\.proMonthlyPrice\}` \}\)/);
    assert.doesNotMatch(hero, /\$\d+\.\d\d/, 'no literal price in the hero');
    assert.doesNotMatch(hero, /welcome\.hero\.ctaSecondary/);
  });

  it('quotes the monthly price of the Pro plan', () => {
    const { proMonthlyPrice } = readJson('pro-test/src/generated/copy-stats.json');
    const tiers = readJson('pro-test/src/generated/tiers.json');
    const pro = (Array.isArray(tiers) ? tiers : tiers.tiers).find((tier) => tier.localeKey === 'pro');
    assert.ok(pro, 'the Pro tier must exist');
    assert.equal(proMonthlyPrice, pro.monthlyPrice);
  });

  it('every locale carries the price slot and drops the old label', () => {
    const dir = join(repoRoot, 'pro-test/src/locales');
    const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    assert.ok(files.length >= 28);
    for (const file of files) {
      const hero = JSON.parse(readFileSync(join(dir, file), 'utf8')).welcome?.hero ?? {};
      assert.match(hero.ctaPro ?? '', /\{\{price\}\}/, `${file} welcome.hero.ctaPro`);
      assert.equal(hero.ctaSecondary, undefined, `${file} still has welcome.hero.ctaSecondary`);
    }
  });
});
