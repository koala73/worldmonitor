// Guard: the CoinGecko retry ladder in every seeder registered in SEEDERS must
// leave room for the CoinPaprika fallback inside the bundle section timeout
// that runs it.
//
// Why this needs a CI gate rather than a code review:
//
// `_bundle-runner.mjs` SIGTERMs a section at its `timeoutMs`. Each seeder only
// falls back to CoinPaprika once its CoinGecko fetch throws, and that only
// happens after the whole 429 backoff ladder is exhausted. The ladder's wall
// time and the section's timeout live in different files with nothing tying
// them together, so either can be edited on its own until the ladder alone
// outlasts the section and the fallback becomes unreachable.
//
// Why it covers a registry rather than one seeder: the ladder was copy-pasted
// between seeders, and copies do not receive fixes. `seed-crypto-quotes.mjs`
// diagnosed this exact overrun on 2026-04-14 ("10+20+30+40+50=150s overruns
// the bundle's 120s timeout") and was reordered around it; the identical
// copies in seed-token-panels and seed-stablecoin-markets kept the bug. On
// 2026-09-20 `seed-bundle-market-backup` crashed on it: CoinGecko answered 429
// on every attempt, Token-Panels slept through the ladder and was SIGTERMed at
// 120.0s after five CoinGecko attempts and zero CoinPaprika attempts, the
// runner exited 1, and Railway paged "Deploy Crashed!" for all 13 sections.
// The fallback that exists for this failure never ran. Adding a seeder to
// SEEDERS is the only step needed to put it under this gate.
//
// Per seeder, the first test pins the arithmetic the seeder declares. The
// second drives the real fallback chain under faked timers and checks that
// CoinPaprika is reached before the section deadline, so the declared budget
// is proven to be the ceiling the arithmetic assumes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SECTION_TIMEOUT_MS } from '../scripts/_bundle-runner.mjs';
import * as tokenPanels from '../scripts/seed-token-panels.mjs';
import * as stablecoinMarkets from '../scripts/seed-stablecoin-markets.mjs';
import { extractBundleSections, listBundleFiles, resolveExpr } from './helpers/bundle-section-parser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(resolve(__dirname, '..'), 'scripts');

// `coingeckoEndpoint` returns api.coingecko.com or pro-api.coingecko.com
// depending on the key tier, so the stub matches the registrable domain and
// its subdomains. A bare `endsWith('coingecko.com')` would also accept
// evilcoingecko.com, which CodeQL flags and which would misattribute a request.
const isCoinGeckoHost = (hostname) => hostname === 'coingecko.com' || hostname.endsWith('.coingecko.com');

/**
 * Each entry names the seeder script as the bundle manifest spells it and the
 * module that exports REQUEST_TIMEOUT_MS, COINGECKO_RETRY_BUDGET_MS,
 * COINPAPRIKA_WORST_CASE_MS and the fetch entrypoint named by `fetchExport`.
 */
const SEEDERS = [
  { script: 'seed-token-panels.mjs', module: tokenPanels, fetchExport: 'fetchTokenPanels' },
  { script: 'seed-stablecoin-markets.mjs', module: stablecoinMarkets, fetchExport: 'fetchStablecoinMarkets' },
];

/**
 * Find the bundle section that runs the seeder and resolve its timeoutMs from
 * source. Bundle manifests cannot be imported (top-level `runBundle` would
 * spawn the real seeders), and a section this gate cannot read is a section
 * it cannot vouch for, so anything unresolvable fails rather than skips.
 */
function readSeederSection(script) {
  const found = [];
  for (const bundlePath of listBundleFiles(SCRIPTS_DIR)) {
    const src = readFileSync(bundlePath, 'utf-8');
    for (const section of extractBundleSections(src)) {
      if (section.script !== script) continue;
      const timeoutMs = section.timeoutMsExpr == null
        ? DEFAULT_SECTION_TIMEOUT_MS
        : resolveExpr(src, section.timeoutMsExpr, {}, { file: bundlePath });
      found.push({ bundle: basename(bundlePath), label: section.label, timeoutMs });
    }
  }
  assert.equal(
    found.length,
    1,
    `expected exactly one bundle section with script: '${script}', found ${found.length} `
    + `(${JSON.stringify(found)}). If the seeder moved bundles, point this gate at the new section; if the parser `
    + 'dropped it, fix tests/helpers/bundle-section-parser.mjs rather than leaving the seeder unchecked.',
  );
  const [section] = found;
  assert.ok(
    Number.isFinite(section.timeoutMs) && section.timeoutMs > 0,
    `${section.bundle} / ${section.label}: timeoutMs did not resolve to a positive number (${section.timeoutMs})`,
  );
  return section;
}

/**
 * Run a promise chain that sleeps through `setTimeout` to completion under
 * MockTimers: yield so resolved continuations can schedule their next sleep,
 * then fire it. `runAll` also advances the mocked Date to the fired timer, so
 * `Date.now()` inside the seeder observes the slept time.
 */
async function settleUnderFakeTimers(t, promise, fetchExport) {
  let outcome = null;
  promise.then(
    (value) => { outcome = { status: 'fulfilled', value }; },
    (reason) => { outcome = { status: 'rejected', reason }; },
  );
  for (let i = 0; i < 1_000 && outcome == null; i++) {
    await new Promise((r) => setImmediate(r));
    if (outcome == null) t.mock.timers.runAll();
  }
  assert.ok(outcome, `${fetchExport} did not settle under faked timers; something in the chain waits on real time`);
  return outcome;
}

function assertBudgetFitsSection({ script, module }) {
  const { REQUEST_TIMEOUT_MS, COINGECKO_RETRY_BUDGET_MS, COINPAPRIKA_WORST_CASE_MS } = module;
  // A zero export (an empty CoinPaprika id map, a budget set to 0) would pass
  // the arithmetic below vacuously.
  for (const [name, value] of Object.entries({ REQUEST_TIMEOUT_MS, COINGECKO_RETRY_BUDGET_MS, COINPAPRIKA_WORST_CASE_MS })) {
    assert.ok(Number.isFinite(value) && value > 0, `${script} must export ${name} as a positive number, got ${value}`);
  }

  const section = readSeederSection(script);
  const worstCaseMs = COINGECKO_RETRY_BUDGET_MS + COINPAPRIKA_WORST_CASE_MS;
  assert.ok(
    worstCaseMs <= section.timeoutMs,
    `${section.bundle} / ${section.label}: CoinGecko retry budget ${COINGECKO_RETRY_BUDGET_MS}ms + CoinPaprika worst case `
    + `${COINPAPRIKA_WORST_CASE_MS}ms = ${worstCaseMs}ms exceeds the section's ${section.timeoutMs}ms timeoutMs. `
    + 'The runner SIGTERMs the seeder before the fallback can run. Lower COINGECKO_RETRY_BUDGET_MS; do not raise timeoutMs.',
  );
}

async function assertFallbackReachedBeforeDeadline(t, { script, module, fetchExport }) {
  const { REQUEST_TIMEOUT_MS, COINGECKO_RETRY_BUDGET_MS } = module;
  const fetchSeed = module[fetchExport];
  assert.equal(typeof fetchSeed, 'function', `${script} must export ${fetchExport} so the fallback chain can be driven`);
  const section = readSeederSection(script);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});

  const requests = [];
  const originalFetch = globalThis.fetch;
  // A 429 that arrives only at the request timeout is the slowest CoinGecko
  // outcome the budget has to absorb, so every CoinGecko call is charged the
  // full timeout before it answers.
  globalThis.fetch = async (url) => {
    const { hostname } = new URL(url);
    if (isCoinGeckoHost(hostname)) t.mock.timers.tick(REQUEST_TIMEOUT_MS);
    requests.push({ hostname, atMs: Date.now() });
    return new Response(null, { status: 429 });
  };

  let outcome;
  try {
    outcome = await settleUnderFakeTimers(t, fetchSeed(), fetchExport);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(outcome.status, 'rejected', 'with every upstream answering 429 the seeder must fail rather than publish');

  const coingecko = requests.filter((r) => isCoinGeckoHost(r.hostname));
  const paprika = requests.filter((r) => r.hostname === 'api.coinpaprika.com');
  assert.ok(coingecko.length > 0, 'the stub saw no CoinGecko request, so the retry ladder was never exercised');
  assert.ok(
    paprika.length > 0,
    `CoinPaprika was never requested: the seeder gave up after ${coingecko.length} CoinGecko attempt(s) at `
    + `${Date.now()}ms without falling back`,
  );

  const reachedAtMs = paprika[0].atMs;
  assert.ok(
    reachedAtMs < section.timeoutMs,
    `CoinPaprika was first reached at ${reachedAtMs}ms of simulated time after ${coingecko.length} CoinGecko `
    + `attempt(s), at or past the ${section.timeoutMs}ms ${section.bundle} / ${section.label} timeout. The runner `
    + 'SIGTERMs the seeder before the fallback runs, which is the 2026-09-20 crash.',
  );
  assert.ok(
    reachedAtMs <= COINGECKO_RETRY_BUDGET_MS,
    `the CoinGecko phase ran ${reachedAtMs}ms, past its declared ${COINGECKO_RETRY_BUDGET_MS}ms budget. `
    + 'COINGECKO_RETRY_BUDGET_MS is not the ceiling the static gate multiplies.',
  );
}

for (const entry of SEEDERS) {
  test(`${entry.script}: the CoinGecko retry budget leaves room for the CoinPaprika fallback inside the section timeout`, () => {
    assertBudgetFitsSection(entry);
  });

  test(`${entry.script}: under sustained CoinGecko 429s the seeder reaches CoinPaprika before the section deadline`, async (t) => {
    await assertFallbackReachedBeforeDeadline(t, entry);
  });
}
