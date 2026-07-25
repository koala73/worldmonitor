import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent- and crawler-facing pricing surfaces must not drift from the source
// of truth, convex/config/productCatalog.ts (#4854). These files are
// hand-maintained markdown/MDX or HTML, so this guard extracts prices from
// the catalog SOURCE TEXT (no import — convex modules don't load under
// tsx --test) and checks them four ways (hardened after the post-#4867 review
// flagged the original contains()-only version as brittle):
//   1. prose: each USD figure appears, tolerating thousands separators;
//   2. pricing.md's embedded ```json block: numeric field comparison, so a
//      stale machine-readable summary fails even when the prose was updated;
//   3. /pro's JSON-LD Offer prices and descriptions match catalog-backed data;
//   4. the Commerce OpenAPI example product IDs still exist in the catalog.
//
// Run: node --test tests/pricing-docs-drift.test.mjs

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(__dirname, '..', p), 'utf-8');

const catalogSrc = read('convex/config/productCatalog.ts');

const catalogEntrySourceFor = (planKey) => {
  const blockStart = catalogSrc.indexOf(`\n  ${planKey}: {`);
  assert.notEqual(blockStart, -1, `productCatalog.ts must contain a "${planKey}" entry`);
  const remainder = catalogSrc.slice(blockStart + 1);
  const nextEntry = remainder.slice(1).search(/\n  [A-Za-z_][A-Za-z0-9_]*: \{/);
  return nextEntry === -1 ? remainder : remainder.slice(0, nextEntry + 1);
};

// planKey → priceCents for every publicly-priced subscription plan,
// including the annual API plan the original docs omitted entirely.
const PLAN_KEYS = ['pro_monthly', 'pro_annual', 'api_starter', 'api_starter_annual', 'api_business'];
const priceCentsFor = (planKey) => {
  const m = catalogEntrySourceFor(planKey).match(/priceCents:\s*(\d+)/);
  assert.ok(m, `no priceCents found for ${planKey}`);
  return Number(m[1]);
};

const stringArrayPropertyFromSource = (entrySource, property, context, { required = true } = {}) => {
  const propertyMatch = entrySource.match(new RegExp(`${property}:\\s*\\[`));
  if (!propertyMatch) {
    assert.equal(required, false, `no ${property} found for ${context}`);
    return [];
  }

  const openIndex = propertyMatch.index + propertyMatch[0].lastIndexOf('[');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let closeIndex = -1;
  for (let index = openIndex; index < entrySource.length; index += 1) {
    const character = entrySource[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = index;
        break;
      }
    }
  }

  assert.notEqual(closeIndex, -1, `unterminated ${property} array for ${context}`);
  const arraySource = entrySource.slice(openIndex + 1, closeIndex);
  return [...arraySource.matchAll(/"(?:\\.|[^"\\])*"/g)].map((match) => JSON.parse(match[0]));
};

const stringArrayPropertyFor = (planKey, property, options) =>
  stringArrayPropertyFromSource(catalogEntrySourceFor(planKey), property, planKey, options);
const marketingFeaturesFor = (planKey) => stringArrayPropertyFor(planKey, 'marketingFeatures');
const highlightFeaturesFor = (planKey) =>
  stringArrayPropertyFor(planKey, 'highlightFeatures', { required: false });

test('catalog string-array extraction ignores closing brackets inside quoted features', () => {
  const entrySource = 'marketingFeatures: ["Bracket ] stays inside the feature", "Next feature"]';
  assert.deepEqual(
    stringArrayPropertyFromSource(entrySource, 'marketingFeatures', 'synthetic plan'),
    ['Bracket ] stays inside the feature', 'Next feature']
  );
});

const jsonLdOffersFor = (path) => {
  const html = read(path);
  const blocks = [...html.matchAll(/<script\b(?=[^>]*\btype="application\/ld\+json")[^>]*>\s*([\s\S]*?)\s*<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  const application = blocks.find((block) => block['@type'] === 'SoftwareApplication');
  assert.ok(application, `${path} must contain SoftwareApplication JSON-LD`);
  assert.ok(Array.isArray(application.offers), `${path} SoftwareApplication JSON-LD must contain an Offer array`);
  return application.offers;
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

const PRICE_EXPECT = [
  ['Free', 'free'],
  ['Pro Monthly', 'pro_monthly'],
  ['Pro Annual', 'pro_annual'],
  ['API Starter Monthly', 'api_starter'],
  ['API Starter Annual', 'api_starter_annual'],
  ['API Business', 'api_business'],
];
const FEATURE_OFFERS = [
  ['free', 'Free'],
  ['pro_monthly', 'Pro Monthly'],
  ['api_starter', 'API Starter Monthly'],
  ['api_business', 'API Business'],
];
const EXPECTED_OFFER_NAMES = PRICE_EXPECT.map(([offerName]) => offerName).sort();

const assertJsonLdOffersMatchCatalog = (sourceOffers, deployedOffers) => {
  assert.deepEqual(
    deployedOffers,
    sourceOffers,
    'public/pro/index.html JSON-LD offers are stale — rebuild the /pro bundle'
  );

  const offerNames = sourceOffers.map((offer) => offer.name);
  assert.equal(
    new Set(offerNames).size,
    offerNames.length,
    'JSON-LD offer names must be unique'
  );
  assert.deepEqual(
    [...offerNames].sort(),
    EXPECTED_OFFER_NAMES,
    'JSON-LD must contain exactly the catalog-backed public offers'
  );

  const offerByName = Object.fromEntries(sourceOffers.map((offer) => [offer.name, offer]));
  for (const [offerName, planKey] of PRICE_EXPECT) {
    assert.equal(
      Number(offerByName[offerName].price),
      priceCentsFor(planKey) / 100,
      `JSON-LD ${offerName} price is stale vs productCatalog.ts ${planKey}`
    );
  }

  for (const [planKey, offerName] of FEATURE_OFFERS) {
    const catalogDescription = [
      ...marketingFeaturesFor(planKey),
      ...highlightFeaturesFor(planKey),
    ].join(', ');
    assert.equal(
      offerByName[offerName].description,
      catalogDescription,
      `JSON-LD ${offerName} description must exactly match catalog marketing and highlight features`
    );
  }
};

test('/pro JSON-LD offers match productCatalog.ts prices and marketing features', () => {
  assertJsonLdOffersMatchCatalog(
    jsonLdOffersFor('pro-test/index.html'),
    jsonLdOffersFor('public/pro/index.html')
  );
});

test('/pro JSON-LD guard rejects unexpected and duplicate offers', () => {
  const offers = jsonLdOffersFor('pro-test/index.html');
  const unexpectedOffers = structuredClone(offers);
  unexpectedOffers.push({
    '@type': 'Offer',
    price: '1',
    priceCurrency: 'USD',
    name: 'Retired Legacy Plan',
    description: 'Retired',
  });
  assert.throws(
    () => assertJsonLdOffersMatchCatalog(unexpectedOffers, structuredClone(unexpectedOffers)),
    /exactly the catalog-backed public offers/
  );

  const duplicateOffers = structuredClone(offers);
  duplicateOffers.push(structuredClone(duplicateOffers[0]));
  assert.throws(
    () => assertJsonLdOffersMatchCatalog(duplicateOffers, structuredClone(duplicateOffers)),
    /offer names must be unique/
  );
});

test('/pro JSON-LD guard rejects a removed catalog feature left in a description', () => {
  const staleOffers = jsonLdOffersFor('pro-test/index.html');
  const staleFreeOffer = staleOffers.find((offer) => offer.name === 'Free');
  staleFreeOffer.description += ', Retired catalog feature';
  assert.throws(
    () => assertJsonLdOffersMatchCatalog(staleOffers, structuredClone(staleOffers)),
    /description must exactly match catalog marketing and highlight features/
  );
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
