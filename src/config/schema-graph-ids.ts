/**
 * Canonical JSON-LD entity identifiers and the property values that travel
 * with them (#7459, #7611).
 *
 * The entity graph only folds together if every producer spells these `@id`
 * values identically, so the TypeScript producers share them from here rather
 * than each declaring their own literal. Static HTML entries (index.html,
 * pro-test/*.html), the separate Astro blog build, and the .mjs corpus
 * generators cannot import this module and carry their own copies; the schema
 * contract tests in tests/schema-graph-contract.test.mts are what keep those in
 * step.
 *
 * Pinning `@id` alone was not enough. Three surfaces each built their own node
 * body under the shared `#software` identity, so a consumer merging by `@id`
 * received two `applicationCategory` values for one entity (#7611). The
 * `*_SHARED_PROPERTIES` literals below are therefore the single source of truth
 * for the properties that must not diverge, and the contract test asserts every
 * emitting surface reproduces them exactly.
 */

/** Canonical Organization, declared once on the welcome page. */
export const ORGANIZATION_ID = 'https://www.worldmonitor.app/#organization';

/** Canonical WebSite, declared on the welcome page and the dashboard. */
export const WEBSITE_ID = 'https://www.worldmonitor.app/#website';

/** Canonical Person, declared on the blog author page. */
export const PERSON_ID = 'https://www.worldmonitor.app/blog/authors/elie-habib/#person';

/** Canonical product, declared on every product surface. */
export const SOFTWARE_ID = 'https://www.worldmonitor.app/#software';

/** Canonical site origin, used as the Organization/WebSite `url`. */
export const CANONICAL_ORIGIN = 'https://www.worldmonitor.app/';

/**
 * Property VALUES every `#software` emitter must assert identically.
 *
 * `SoftwareApplication` rather than `WebApplication`: the product also ships
 * desktop builds and an Android TV app, which the narrower subtype would
 * misdescribe, and /schemamap.xml already advertises the supertype.
 * `BusinessApplication` rather than the FinanceApplication / SecurityApplication
 * split it replaces: World Monitor is neither a finance app nor a security app.
 *
 * This pins the values the product decision turns on. It is deliberately NOT
 * the whole guard — enumerating properties would only freeze the ones that
 * happened to be wrong, and the invariant is "one `@id`, one body". The
 * contract test therefore also asserts that every property two emitters both
 * carry agrees, pinned or not, exempting only the union-mergeable ones
 * (`alternateName`, `keywords`, `offers`, `featureList` — the last rewritten
 * per variant by variant-dashboard-html.ts).
 */
export const SOFTWARE_SHARED_PROPERTIES = {
  '@type': 'SoftwareApplication',
  '@id': SOFTWARE_ID,
  name: 'World Monitor',
  url: CANONICAL_ORIGIN,
  description:
    'Free real-time global intelligence dashboard. Curated news feeds, conflict tracking, market data, shipping chokepoints, satellite passes and cyber signals fused into one live map of the world, with AI analysis layered on top.',
  applicationCategory: 'BusinessApplication',
  operatingSystem: 'Web, Windows, macOS, Linux, Android TV',
  // The product's own profiles. https://x.com/eliehabib is the founder's
  // account and stays on the Organization node.
  sameAs: [
    'https://github.com/koala73/worldmonitor',
    'https://www.npmjs.com/package/worldmonitor',
    'https://www.wikidata.org/wiki/Q141237754',
    'https://x.com/worldmonitorai',
    'https://discord.gg/re63kWKxaz',
    'https://www.wired.com/story/world-monitor-elie-habib/',
  ],
} as const;

/**
 * Properties every `#website` emitter must assert identically. The welcome page
 * used to describe the site with its own marketing hook, which its `#webpage`
 * node already carries; the site-level summary belongs here.
 */
export const WEBSITE_SHARED_PROPERTIES = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: 'World Monitor',
  alternateName: 'WorldMonitor',
  url: CANONICAL_ORIGIN,
  description:
    'Real-time global intelligence dashboard — live news, markets, military tracking, infrastructure monitoring, and geopolitical data.',
  inLanguage: 'en',
} as const;
