import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

// Visible FAQ copy and FAQPage JSON-LD must stay aligned with the pricing
// table: 30s is the quote-cache interval, not a dashboard-wide refresh.
const CANONICAL_FAQ_A12 =
  "Pro refreshes market quotes every 30 seconds. Other datasets follow each source's own cadence. Free stays on the standard source cadence.";

function faqPageJsonLd(path) {
  const blocks = [...read(path).matchAll(
    /<script\b(?=[^>]*\btype="application\/ld\+json")[^>]*>\s*([\s\S]*?)\s*<\/script>/g,
  )].map((match) => JSON.parse(match[1]));
  const faqPage = blocks.find((block) => block['@type'] === 'FAQPage');
  assert.ok(faqPage, `${path} must publish FAQPage JSON-LD`);
  return faqPage;
}

describe('pro refresh FAQ contract', () => {
  it('scopes visible and structured FAQ copy to market-quote 30s plus source cadence', () => {
    const en = readJson('pro-test/src/locales/en.json');
    assert.equal(en.faq.a12, CANONICAL_FAQ_A12, 'visible English FAQ must scope 30s to market quotes');

    const localeDir = join(ROOT, 'pro-test/src/locales');
    for (const name of readdirSync(localeDir).filter((file) => file.endsWith('.json'))) {
      const a12 = readJson(`pro-test/src/locales/${name}`).faq?.a12;
      assert.equal(typeof a12, 'string', `${name}: faq.a12 must be present`);
      assert.match(a12, /30|۳۰/, `${name}: FAQ refresh answer must mention the 30s quote cadence`);
      assert.doesNotMatch(
        a12,
        /near real time/i,
        `${name}: must not publish the disproved broad Pro freshness claim`,
      );
      assert.doesNotMatch(
        a12,
        /5\s*[–-]\s*15/,
        `${name}: must not publish the disproved Free 5–15 minute cadence`,
      );
    }

    const faqPage = faqPageJsonLd('pro-test/index.html');
    const refresh = faqPage.mainEntity.find((entry) => entry.name === en.faq.q12);
    assert.ok(refresh, 'FAQPage JSON-LD must include the refresh-rate question');
    assert.equal(
      refresh.acceptedAnswer?.text,
      CANONICAL_FAQ_A12,
      'structured FAQPage answer must match the visible English FAQ',
    );
  });
});
