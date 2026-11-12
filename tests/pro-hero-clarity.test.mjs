// /pro conversion audit (2026-11-06):
// - The hero line under "Noise -> Signal" read "The intelligence geopolitical AI
//   layer — ask it, subscribe to it, build on it": ungrammatical, and it did not
//   say what Pro adds. It now names what Pro adds, each claim backed by a Pro
//   tier feature in tiers.json.
// - The first screen carried five controls, including two "Sign in" buttons
//   (nav and hero). The nav keeps sign-in; the hero keeps one plan CTA and the
//   free-dashboard link.
// - Nothing near the prices said a subscription can be cancelled. The EULA does:
//   "You may stop at any time by cancelling; cancellation ends future renewals
//   at the close of the current billing period." The note says only that.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');
const localeDir = join(repoRoot, 'pro-test/src/locales');
const locales = readdirSync(localeDir).filter((file) => file.endsWith('.json'));
const en = JSON.parse(read('pro-test/src/locales/en.json'));

describe('/pro first screen and pricing', () => {
  it('says what Pro adds, with claims the Pro tier backs', () => {
    const line = en.hero.valueProps;
    assert.doesNotMatch(line, /intelligence geopolitical/i);
    // e2e/pro-hero-lcp.spec.ts pins the h1 as the LCP element. At 360px a
    // line past two rows (~75 characters) outweighs "Noise -> Signal" and
    // takes LCP: the first rewrite (135 characters) painted 31,104 px²
    // against the h1's 15,840.
    assert.ok(line.length <= 75, `hero.valueProps is ${line.length} characters; keep it to two lines at 360px`);
    const proFeatures = JSON.parse(read('pro-test/src/generated/tiers.json'))
      .find((tier) => tier.localeKey === 'pro').features.join(' | ');
    for (const [claim, feature] of [
      [/AI analyst/i, /WM Analyst chat/],
      [/alert/i, /alert rules engine/],
      [/briefing/i, /Scheduled AI digest/],
      [/Claude/, /Claude Desktop/],
    ]) {
      assert.match(line, claim);
      assert.match(proFeatures, feature, `the Pro tier must still offer what ${claim} promises`);
    }
  });

  it('keeps a single sign-in control on the first screen', () => {
    const app = read('pro-test/src/App.tsx');
    const hero = app.slice(app.indexOf('const Hero = '), app.indexOf('const SocialProof = '));
    assert.doesNotMatch(hero, /openSignIn|t\('hero\.signIn'\)/, 'the hero must not repeat the nav sign-in');
    assert.match(hero, /t\('hero\.choosePlan'\)/);
    assert.match(hero, /t\('hero\.tryFreeDashboard'\)/);
    for (const file of locales) {
      const hero = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).hero ?? {};
      assert.equal(hero.signIn, undefined, `${file} still carries the unused hero.signIn`);
    }
  });

  it('states the cancellation terms beside the billing toggle', () => {
    const pricing = read('pro-test/src/components/PricingSection.tsx');
    const toggleEnd = pricing.indexOf("t('pricing.saveAnnual')");
    const cardsStart = pricing.indexOf('Tier cards grid');
    const note = pricing.indexOf("t('pricing.cancelAnytime')");
    assert.ok(note > toggleEnd && note < cardsStart, 'the note sits between the billing toggle and the plan cards');
    assert.match(en.pricing.cancelAnytime, /cancel anytime/i);
    assert.match(en.pricing.cancelAnytime, /end of the (billing )?period/i);
    assert.doesNotMatch(en.pricing.cancelAnytime, /refund/i, 'the EULA promises no refund on cancellation');
    for (const file of locales) {
      const pricing = JSON.parse(readFileSync(join(localeDir, file), 'utf8')).pricing ?? {};
      assert.ok(pricing.cancelAnytime, `${file} pricing.cancelAnytime`);
    }
  });
});
