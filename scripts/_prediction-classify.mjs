// Primary-category classification for prediction-market records (#5733).
//
// THE BUG THIS REPLACES. seed-prediction-markets used to build its three pools
// as three independent filters over the SAME candidate list:
//
//   geopolitical = filterAndScore(markets, null)                      // no filter at all
//   tech         = filterAndScore(markets, m => m.tags ∈ TECH_TAGS)
//   finance      = filterAndScore(markets, m => kalshi || tags ∈ FINANCE_TAGS)
//
// so `geopolitical` was an unfiltered copy of every market fetched (the fetch
// tag list is the UNION of all three domains), and the tech/finance tag lists
// shared `economy`, `crypto`, and `business`. The pools came out as near-
// duplicates: production on 2026-07-30 published 75 records covering only 46
// distinct markets, with a Fed-rates market at $45.6M sitting at the top of the
// "geopolitical" pool while the genuine Iran/Ukraine/Taiwan lines were buried.
// Because every consumer picks ONE pool by name — the RPC (site variant), the
// MCP `category` argument, the deduct-situation prompt builder — the labels were
// load-bearing and meaningless at the same time.
//
// THE MODEL. Each market gets exactly ONE primary category, decided by a fixed
// precedence: geopolitical, then tech, then finance. Precedence (rather than
// three independent predicates) is what makes the pools disjoint by
// construction.
//
// PRECEDENCE IS LOAD-BEARING, not a tie-breaker of last resort. The `classify`
// tag lists in prediction-tags.json are mutually disjoint, which guarantees no
// single TAG maps to two categories — but a market routinely carries tags from
// more than one list, and then the ORDER decides. "Kraken IPO by December 31,
// 2026?" is tagged both `crypto` (tech) and `business`/`finance` (finance), and
// lands in tech purely because tech is checked first. So reordering CATEGORIES
// silently moves real markets between published pools; the order is pinned by
// tests/prediction-market-classification.test.mjs, not merely documented here.
//
// WHY GEOPOLITICAL IS FIRST, AND WHY IT READS BOTH TITLE AND TAGS.
// WorldMonitor's identity is geopolitical intelligence, so a genuine geo market
// must never be filed elsewhere. The two signals cover each other's blind spots:
//   - the TITLE matcher (isGeopoliticalMarket, shared with the bet families) is
//     precision-first and deliberately misses e.g. "Berlin state elections",
//     but it is the ONLY signal for Kalshi records, which always ship tags: [].
//   - the venue TAGS catch what the title matcher declines to guess, but only
//     for Polymarket.
// `politics` is deliberately NOT a geo tag: Polymarket puts it on crypto
// legislation ("Clarity Act") and any market a US politician appears in. The geo
// tag list sticks to statecraft / conflict / national-election vocabulary.
//
// WHY FINANCE IS THE DEFAULT. Something has to own the untagged tail, which in
// practice is every Kalshi record whose title is not geopolitical. Finance was
// already that bucket (the old `source === 'kalshi'` rule), so defaulting there
// keeps those records where consumers already found them; what changes is that
// a Kalshi record with a geopolitical title (a next-Prime-Minister-of-Israel
// line) is now correctly promoted to the geo pool instead.

import { isGeopoliticalMarket } from './_bet-templates-markets-classify.mjs';
import { filterAndScore } from './_prediction-scoring.mjs';
import predictionTags from './data/prediction-tags.json' with { type: 'json' };

// Canonical pool names, in precedence order. Also the MCP tool's `category`
// enum and the bootstrap payload's top-level keys — do not reorder casually.
export const CATEGORIES = Object.freeze(['geopolitical', 'tech', 'finance']);

// The smallest healthy single-pool cycle in the production fixture contains
// eight records. Keep this floor below that so a legitimate category outage
// can still publish, while refusing a one-record partial fetch outright.
export const MIN_PUBLISHED_MARKETS = 5;

// Pool that owns records matching no category tag (see header).
export const DEFAULT_CATEGORY = 'finance';

// Health metadata deliberately uses published counts, not pre-ranking
// classification counts: these are the records each category consumer can
// actually retrieve from the canonical snapshot.
//
// Absent/malformed pools report 0 (producer-side fail closed) so a partial
// payload cannot look healthy. Health consumers parse with parsePoolCounts,
// which treats a missing/malformed whole object as null (unproven coverage) —
// different from an explicit zero for a single pool.
export function predictionPoolCounts(data) {
  return Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      Array.isArray(data?.[category]) ? data[category].length : 0,
    ]),
  );
}

const CLASSIFY_TAGS = Object.freeze(Object.fromEntries(
  CATEGORIES.map((category) => [
    category,
    new Set((predictionTags.classify?.[category] ?? []).map((tag) => String(tag).toLowerCase())),
  ]),
));

// Venue tag slugs are not case-normalized upstream — Polymarket ships both
// `interest-rates` and `Global-Rates` — so compare lowercased and trimmed.
export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const slug = tag.trim().toLowerCase();
    if (slug) out.push(slug);
  }
  return out;
}

export function hasCategoryTag(tags, category) {
  const slugs = CLASSIFY_TAGS[category];
  if (!slugs) return false;
  return normalizeTags(tags).some((tag) => slugs.has(tag));
}

// The single primary category for one raw market record. Pure and total: any
// input, including junk, resolves to exactly one member of CATEGORIES.
export function classifyMarket(market) {
  const title = market?.title;
  const tags = market?.tags;
  if (isGeopoliticalMarket(typeof title === 'string' ? title : '') || hasCategoryTag(tags, 'geopolitical')) {
    return 'geopolitical';
  }
  if (hasCategoryTag(tags, 'tech')) return 'tech';
  if (hasCategoryTag(tags, 'finance')) return 'finance';
  return DEFAULT_CATEGORY;
}

// Every market in a published bootstrap payload, across all three pools.
//
// USE THIS, NOT `payload.geopolitical`, for any whole-universe read. Before
// #5733 the geopolitical pool WAS every market, so several consumers used it as
// a cheap stand-in for "all markets" — scripts/seed-forecasts.mjs's
// detectFromPredictionMarkets and calibrateWithMarkets, and
// scripts/_forecast-resolution.mjs's title->endDate settlement index. Now that
// the pools are a disjoint partition, `payload.geopolitical` means only
// geopolitical, and those readers would silently lose every macro, rates,
// crypto, and AI market. One helper so they cannot drift apart again.
export function allBootstrapMarkets(payload) {
  return dedupeMarkets(
    [payload?.geopolitical, payload?.tech, payload?.finance]
      .filter(Array.isArray)
      .flat(),
  );
}

// Split candidates into the three disjoint pools. Every valid record lands in
// exactly one; nothing is duplicated and nothing is dropped.
export function partitionMarkets(markets) {
  const pools = { geopolitical: [], tech: [], finance: [] };
  if (!Array.isArray(markets)) return pools;
  for (const market of markets) {
    if (!market || typeof market !== 'object') continue;
    pools[classifyMarket(market)].push(market);
  }
  return pools;
}

// Stable identity for duplicate detection. The venue url is the real key (the
// bet families derive their slug from it); title is the fallback so a record
// with an unusable url still participates in the check.
//
// "Unusable" matters more than it looks: both producer paths build the url from
// a template (`.../event/${event.slug}`, `.../markets/${topMarket.ticker}`), so a
// missing slug/ticker yields the literal string ".../undefined" — identical for
// every such record. Keying on that would collapse unrelated markets onto one
// identity and silently drop all but one of them. Fall back to the title
// instead, which still distinguishes them.
const DEGENERATE_SLUGS = new Set(['undefined', 'null', 'nan', '']);

export function marketIdentity(market) {
  const url = String(market?.url ?? '').trim();
  if (url) {
    const slug = url.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? '';
    if (!DEGENERATE_SLUGS.has(slug.toLowerCase())) return `url:${url}`;
  }
  return `title:${String(market?.title ?? '').trim().toLowerCase()}`;
}

// Collapse same-identity records, keeping the highest-volume one.
//
// WHY THIS EXISTS AND WHY IT MUST NOT BE A HARD FAILURE. Upstream can legitimately
// hand us two records with one identity: the Polymarket url is built from
// `event.slug` while the fetch loop dedupes on `event.id`, so a parent event and
// its derivative (the feed really does carry a `parent-for-derivative` tag) can
// share a slug under two ids. If those two land in different pools, the payload
// contains a cross-pool duplicate through no fault of the classifier — and
// because the integrity gate refuses the whole publish, an upstream fan-out
// quirk would freeze ALL THREE pools until a human shipped a fix, with
// /api/health only noticing 90 minutes later. Deduping here keeps that a data
// condition we absorb, not an outage. Highest volume wins so the choice is
// deterministic run-to-run rather than dependent on tag-iteration order.
export function dedupeMarkets(markets) {
  if (!Array.isArray(markets)) return [];
  const best = new Map();
  for (const market of markets) {
    if (!market || typeof market !== 'object') continue;
    const identity = marketIdentity(market);
    const incumbent = best.get(identity);
    if (!incumbent) {
      best.set(identity, market);
      continue;
    }
    const incumbentVolume = Number(incumbent.volume);
    const challengerVolume = Number(market.volume);
    const incumbentRank = Number.isFinite(incumbentVolume) ? incumbentVolume : -Infinity;
    const challengerRank = Number.isFinite(challengerVolume) ? challengerVolume : -Infinity;
    if (challengerRank > incumbentRank) best.set(identity, market);
  }
  return [...best.values()];
}

// Assemble the published payload's three pools from the raw candidate list:
// dedupe by identity, assign one primary category each, then rank WITHIN each
// pool. This is the producer's real pool-building path — seed-prediction-markets
// calls exactly this, and so do the tests, so a regression in the wiring (for
// example reverting `geopolitical` to an unfiltered `filterAndScore(markets,
// null)`) cannot pass the suite. Keeping the wiring here rather than inline in
// the seeder is deliberate: the seeder calls runSeed at module scope and can
// never be imported by a test.
//
// Returns the pools plus the pre-truncation classification counts, so the
// seeder can log how many candidates each category actually had versus how many
// survived the per-pool ranking cap.
export function buildBootstrapPools(markets, { limit, now = Date.now() } = {}) {
  const source = Array.isArray(markets) ? markets : [];
  const deduped = dedupeMarkets(source);
  const partitioned = partitionMarkets(deduped);
  return {
    pools: {
      geopolitical: filterAndScore(partitioned.geopolitical, null, limit, now),
      tech: filterAndScore(partitioned.tech, null, limit, now),
      finance: filterAndScore(partitioned.finance, null, limit, now),
    },
    classified: {
      geopolitical: partitioned.geopolitical.length,
      tech: partitioned.tech.length,
      finance: partitioned.finance.length,
    },
    duplicatesDropped: source.length - deduped.length,
  };
}

// Category-integrity check over an assembled payload (#5733 item 3). Returns
// the list of violations — empty means the pools are disjoint AND every entry
// sits in the pool its own classification demands. Both properties hold by
// construction when the payload came from buildBootstrapPools, so a non-empty
// result means the producer regressed, not that upstream data was odd. That is
// why the seeder treats it as a publish gate rather than a warning.
//
// WHAT THIS CANNOT CATCH — do not over-trust a green gate. The mismatch check
// re-runs the SAME classifyMarket that built the partition, so it is a
// SELF-CONSISTENCY check, not a correctness one. It catches a regression in the
// pipeline SHAPE — someone reverting `geopolitical` to an unfiltered
// filterAndScore(markets, null), a merge that copies a pool, a hand-assembled
// payload — which is exactly the #5733 defect. It can NOT tell you the taxonomy
// itself is right: if the title regex or the classify tag lists start misfiling
// real markets, every pool still agrees with its own classifier and this gate
// stays green. The independent ground truth for the taxonomy lives in
// tests/prediction-market-classification.test.mjs, which asserts hand-verified
// expected categories for named real production titles.
//
// A pool key that is absent is vacuously clean: whether a partial payload is
// publishable is the caller's own validation, not this function's business.
export function poolIntegrityViolations(pools) {
  const violations = [];
  const owner = new Map();
  for (const category of CATEGORIES) {
    const pool = pools?.[category];
    if (pool == null) continue;
    if (!Array.isArray(pool)) {
      violations.push({ kind: 'pool-not-array', category });
      continue;
    }
    for (const market of pool) {
      const title = String(market?.title ?? '');
      const expected = classifyMarket(market);
      if (expected !== category) {
        violations.push({ kind: 'category-mismatch', category, expected, title });
      }
      const identity = marketIdentity(market);
      const previous = owner.get(identity);
      if (previous) {
        violations.push({ kind: 'duplicate-market', category, otherCategory: previous, title });
      } else {
        owner.set(identity, category);
      }
    }
  }
  return violations;
}

// One-line summary for seeder logs.
export function formatIntegrityViolations(violations, limit = 10) {
  return violations.slice(0, limit).map((v) => {
    if (v.kind === 'pool-not-array') return `pool-not-array: ${v.category}`;
    if (v.kind === 'duplicate-market') return `duplicate-market: "${v.title}" in ${v.category} and ${v.otherCategory}`;
    return `category-mismatch: "${v.title}" in ${v.category}, classifies as ${v.expected}`;
  });
}

// The seeder's atomicPublish validateFn, lifted here so the publish gate itself
// is unit-testable — seed-prediction-markets.mjs cannot be imported by a test
// (it calls runSeed at module scope). Returns true iff the payload is
// publishable.
//
// A rejection makes runSeed preserve last-good and mirror its original
// fetchedAt into seed-meta, so /api/health flips to STALE_SEED past maxStaleMin
// rather than serving pools whose labels lie — which is how #5733 stayed
// invisible. That also means a WRONG rejection is a 90-minute-latent data
// outage, so the population floor below is deliberately the weakest one that
// still protects last-good while allowing a legitimate single-pool cycle.
//
// WHY THE PER-POOL FLOOR IS GONE. The pre-#5733 check required
// `(geopolitical || tech) && finance` to be non-empty. That was safe only
// because `finance` was then a catch-all — every Kalshi record landed there via
// the old `source === 'kalshi'` rule. Now that pool membership is decided by
// CONTENT, a legitimate run can empty any single pool: a cycle whose Kalshi
// records are all geopolitical by title and whose Polymarket finance tags all
// 429'd yields real, publishable geo+tech data that the old floor would have
// thrown away, freezing the feed. Any payload at or above MIN_PUBLISHED_MARKETS
// is therefore publishable; a genuinely empty fetch is already caught upstream by runSeed's
// contract mode (declareRecords === 0 -> RETRY, which preserves last-good
// without ever reaching validateFn). Detecting a partial-volume collapse is a
// coverage-floor job (api/health.js minRecordCount), not this gate's.
export function validateBootstrapPayload(data, { log = console.error } = {}) {
  const total = CATEGORIES.reduce(
    (sum, category) => sum + (Array.isArray(data?.[category]) ? data[category].length : 0),
    0,
  );
  if (total < MIN_PUBLISHED_MARKETS) {
    log(`  COVERAGE: only ${total} published market(s); refusing a partial snapshot below ${MIN_PUBLISHED_MARKETS} (#5733)`);
    return false;
  }
  const violations = poolIntegrityViolations(data);
  if (violations.length === 0) return true;
  log(`  INTEGRITY: ${violations.length} pool-classification violation(s) — refusing to publish mislabeled pools (#5733)`);
  for (const line of formatIntegrityViolations(violations)) log(`    ${line}`);
  return false;
}
