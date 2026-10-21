import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * AusTender ships no scraper.
 *
 * This is a policy guard, not a wiring test: the Australian portal publishes no
 * closing date through any sanctioned feed, so the adapter is deliberately
 * absent and the blocker is documented instead. A source scan is the right tool
 * here — the invariant is "this code does not exist anywhere in the seeder", a
 * property no unit test can observe. Everything else about the procurement
 * panel (registration, premium gating, rendering) is covered by executing the
 * dashboard in e2e/variant-live-smoke.spec.ts.
 */

const read = (path: string) => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');

const docs = read('docs/global-procurement-intelligence.mdx');
const panel = read('src/components/GlobalProcurementPanel.ts');

// Any AusTender identifier, host, or notice-path reference in CODE (the blocker
// comment legitimately cites the feed URLs, so comments are stripped first)
// means a scraper or adapter is being reintroduced without going through the
// documented unblock path.
const SCRAPER_PATTERN = /austender|tenders\.gov\.au|atm\/(show|searchdescription|docshow)/i;

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the documented AusTender blocker stays documented and no scraper ships in its place', () => {
  const seeder = read('scripts/seed-global-tenders.mjs');
  const normalizer = read('scripts/_global-tenders.mjs');

  assert.match(docs, /### Australia: AusTender adapter is blocked/);
  assert.match(seeder, /austender.*BLOCKED on the provider/s);

  assert.doesNotMatch(stripComments(seeder), SCRAPER_PATTERN);
  assert.doesNotMatch(stripComments(normalizer), SCRAPER_PATTERN);
  assert.doesNotMatch(panel, SCRAPER_PATTERN);
});

test('the guard pattern catches casing and naming evasions', () => {
  // A negative assertion fails open if its pattern can be sidestepped, so pin
  // the pattern's reach explicitly — a green guard must not be able to coexist
  // with a renamed or relocated scraper.
  for (const evasion of [
    'function scrapeAusTender() {}',
    "fetch('https://www.TENDERS.gov.au/Atm/Show/abc')",
    'const url = `${base}/ATM/SHOW/${id}`',
    'AUSTENDER_FEED_URL',
  ]) {
    assert.match(evasion, SCRAPER_PATTERN, `guard pattern must catch: ${evasion}`);
  }
});

test('the panel never claims bidding eligibility from keyword relevance', () => {
  // A correctness/compliance claim about rendered copy: keyword matches are
  // evidence of relevance only, and saying otherwise would mislead operators.
  assert.doesNotMatch(panel, /eligible to bid|bidding eligibility confirmed|qualified to bid/i);
  assert.match(docs, /never assert that an AI system, agent, or vendor is eligible to bid/);
});
