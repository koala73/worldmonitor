import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent-facing pricing surfaces must not drift from the source of truth,
// convex/config/productCatalog.ts (#4854). The /pro page has its own
// freshness gate; these files are hand-maintained markdown/MDX with no
// generator, so this guard extracts prices from the catalog SOURCE TEXT
// (no import — convex modules don't load under tsx --test) and checks them
// three ways (hardened after the post-#4867 review flagged the original
// contains()-only version as brittle):
//   1. prose: each USD figure appears, tolerating thousands separators;
//   2. pricing.md's embedded ```json block: numeric field comparison, so a
//      stale machine-readable summary fails even when the prose was updated;
//   3. the Commerce OpenAPI example product IDs still exist in the catalog.
//
// Run: node --test tests/pricing-docs-drift.test.mjs

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

const catalogSrc = read('convex/config/productCatalog.ts');

// planKey → priceCents for every publicly-priced subscription plan,
// including the annual API plan the original docs omitted entirely.
const PLAN_KEYS = ['pro_monthly', 'pro_annual', 'api_starter', 'api_starter_annual', 'api_business'];
const priceCentsFor = (planKey) => {
  const blockStart = catalogSrc.indexOf(`${planKey}: {`);
  assert.notEqual(blockStart, -1, `productCatalog.ts must contain a "${planKey}" entry`);
  const m = catalogSrc.slice(blockStart).match(/priceCents:\s*(\d+)/);
  assert.ok(m, `no priceCents found for ${planKey}`);
  return Number(m[1]);
};

// $999 for even dollars, $39.99 otherwise — matching how the docs and the
// live /api/product-catalog payload both render whole-dollar prices.
const usdText = (cents) =>
  cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);

// Prose matcher: "$1299.99" or "$1,299.99" both count; the dot is escaped.
const proseRegexFor = (cents) => {
  const [int, frac] = usdText(cents).split('.');
  const intWithOptionalCommas = int
    .split('')
    .reverse()
    .map((ch, i) => (i > 0 && i % 3 === 0 ? `${ch},?` : ch))
    .reverse()
    .join('');
  // `$` optional: pricing.md/mdx write "$39.99", api-commerce.mdx's example
  // JSON writes bare `39.99` — both count as carrying the current price.
  return new RegExp(`\\$?${intWithOptionalCommas}${frac ? `\\.${frac}` : '(?![.\\d])'}`);
};

// api-commerce.mdx is included because its example /api/product-catalog
// response embeds real prices — it shipped $20/$180 Pro for months before
// anyone noticed (caught twice: the 2026-07-05 docs audit and the #4946
// review). Every doc here must carry every current price.
const DOCS = ['public/pricing.md', 'docs/pricing.mdx', 'docs/api-commerce.mdx'];

for (const doc of DOCS) {
  const content = read(doc);
  for (const planKey of PLAN_KEYS) {
    const cents = priceCentsFor(planKey);
    test(`${doc} carries the current ${planKey} price ($${usdText(cents)})`, () => {
      assert.match(
        content,
        proseRegexFor(cents),
        `${doc} must contain $${usdText(cents)} for ${planKey} — productCatalog.ts changed and this doc did not`
      );
    });
  }
}

// pricing.md's Machine-Readable Summary is what agents actually parse — a
// stale number there passes a doc-wide contains() check as long as the prose
// was updated, so compare the JSON numerically, field by field.
test('pricing.md machine-readable JSON block matches productCatalog.ts numerically', () => {
  const pricingMd = read('public/pricing.md');
  const jsonBlock = pricingMd.match(/```json\n([\s\S]*?)```/);
  assert.ok(jsonBlock, 'pricing.md must contain a ```json machine-readable summary block');
  const summary = JSON.parse(jsonBlock[1]);
  const planByName = Object.fromEntries(summary.plans.map((p) => [p.name, p]));

  const EXPECT = [
    ['Pro', 'price_usd_monthly', 'pro_monthly'],
    ['Pro', 'price_usd_yearly', 'pro_annual'],
    ['API', 'price_usd_monthly', 'api_starter'],
    ['API', 'price_usd_yearly', 'api_starter_annual'],
    ['API Business', 'price_usd_monthly', 'api_business'],
  ];
  for (const [plan, field, planKey] of EXPECT) {
    assert.ok(planByName[plan], `JSON summary must have a "${plan}" plan`);
    assert.equal(
      planByName[plan][field],
      priceCentsFor(planKey) / 100,
      `JSON summary ${plan}.${field} is stale vs productCatalog.ts ${planKey}`
    );
  }
  assert.equal(planByName.Free?.price_usd_monthly, 0, 'Free plan must stay $0 in the JSON summary');
});

// The Dodo product IDs are surfaced by GET /api/product-catalog, and
// docs/openapi/CommerceService.openapi.yaml embeds two of them as examples.
// A rotated product ID in the catalog must not leave the published OpenAPI
// example pointing at a dead product.
test('CommerceService.openapi.yaml example product IDs exist in productCatalog.ts', () => {
  const spec = read('docs/openapi/CommerceService.openapi.yaml');
  const exampleIds = [...spec.matchAll(/pdt_[A-Za-z0-9]+/g)].map((m) => m[0]);
  assert.ok(exampleIds.length > 0, 'spec example must include at least one Dodo product ID');
  for (const id of exampleIds) {
    assert.ok(
      catalogSrc.includes(`"${id}"`),
      `spec example product ID ${id} is not present in productCatalog.ts`
    );
  }
});
