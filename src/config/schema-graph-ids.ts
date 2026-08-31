/**
 * Canonical JSON-LD entity identifiers (#7459).
 *
 * The entity graph only folds together if every producer spells these `@id`
 * values identically, so the TypeScript producers share them from here rather
 * than each declaring their own literal. Static HTML entries (index.html,
 * pro-test/*.html), the separate Astro blog build, and the .mjs corpus
 * generators cannot import this module and carry their own copies; the schema
 * contract tests in tests/schema-graph-contract.test.mts are what keep those in
 * step.
 */

/** Canonical Organization, declared once on the welcome page. */
export const ORGANIZATION_ID = 'https://www.worldmonitor.app/#organization';

/** Canonical WebSite, declared once on the welcome page. */
export const WEBSITE_ID = 'https://www.worldmonitor.app/#website';

/** Canonical Person, declared on the blog author page. */
export const PERSON_ID = 'https://www.worldmonitor.app/blog/authors/elie-habib/#person';

/** Canonical site origin, used as the Organization/WebSite `url`. */
export const CANONICAL_ORIGIN = 'https://www.worldmonitor.app/';
