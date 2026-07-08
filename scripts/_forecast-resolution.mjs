// Pure spec-builder module for the forecast resolvability contract (#4976 Bet 1).
//
// Every published forecast gets a machine-checkable ResolutionSpec: `hard`
// (auto-resolvable from a WorldMonitor feed the detector already scored from)
// or `judged` (a resolution question for a later LLM judge, Bet 2). This
// module owns that dispatch, the feed allowlist a hard spec's `sourceFeed`
// must belong to (R4), and the deadline math (R5).
//
// No console output in normal operation. No Date.now() anywhere — every
// timestamp is threaded in as `generatedAt` so output is deterministic and
// testable (same inputs -> identical spec across calls).
//
// metricKey format: '<feedKey>|<fn>(<field>==<value>)' — a path expression
// over the shape read from that feed, with REAL substituted values (region,
// title, ticker) and a unified '==' comparison grammar across every family,
// e.g. 'conflict:ucdp-events:v1|count(country==Mali)' or
// 'market:commodities-bootstrap:v1|price(symbol==CL=F)'. It documents where in
// the feed the metric lives and what to match; it is not executable code and
// is not parsed by this module or any consumer today (Bet 2's resolver
// interprets it). The grammar is frozen into 45-day history, so it must be
// consistent — no literal '<region>'/'<title>' placeholders, no '=' vs '=='
// drift between families. count() means NEW events dated within the spec's
// 'within-horizon' window ([emission, deadline]), with a horizon-scoped
// threshold (#5010) — never the feed's full 365-day trailing tally.

// ── Horizon -> deadline math (R5) ───────────────────────────────────────
//
// Production detectors and the state-derived path emit only '24h'/'7d'/'30d'
// (verified exhaustively against scripts/seed-forecasts.mjs — every
// makePrediction() call site and the state-derived domain ternary). '14d' is
// a deliberate superset entry: it appears nowhere in production emission but
// is kept here so a future detector can add it without a map update, and so
// fixtures that want to exercise a horizon distinct from the other three
// have one available.
const DAY_MS = 24 * 60 * 60 * 1000;

export const HORIZON_MS = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * DAY_MS,
  '14d': 14 * DAY_MS,
  '30d': 30 * DAY_MS,
};

// Never returns null and never silently coerces an unrecognized horizon to a
// nearby one — a silent '7d' fallback would score a 14d forecast a full week
// early and corrupt the track record this bet exists to make trustworthy.
// An unrecognized horizon is a programming/config error and must surface
// loudly as a thrown error, caught by the drift-guard test below or, if it
// ever reaches production, a loud seeder failure.
export function deriveDeadline(generatedAt, timeHorizon) {
  const ms = HORIZON_MS[timeHorizon];
  if (!Number.isFinite(ms)) {
    throw new Error(`deriveDeadline: unrecognized horizon '${timeHorizon}' — not in HORIZON_MS`);
  }
  return generatedAt + ms;
}

// ── Resolution-feed allowlist (R4) ──────────────────────────────────────
//
// Every hard spec's `sourceFeed` must be a member of this set. Bare feed
// keys (not path expressions) — `metricKey` embeds the extraction path on
// top of one of these. The market entries are copied (string literals, not
// imported — seed-forecasts.mjs has top-level side effects) from
// MARKET_INPUT_KEYS (scripts/seed-forecasts.mjs :215) plus the market
// feed keys already read into `readInputKeys()` (:708-717).
export const RESOLUTION_FEED_KEYS = new Set([
  'conflict:ucdp-events:v1',
  'supply_chain:chokepoints:v4',
  'infra:outages:v1',
  'prediction:markets-bootstrap:v1',
  'intelligence:gpsjam:v2',
  // MARKET_INPUT_KEYS (scripts/seed-forecasts.mjs :215-227) — copied, not imported.
  'market:stocks-bootstrap:v1',
  'market:commodities-bootstrap:v1',
  'market:sectors:v2',
  'market:gulf-quotes:v1',
  'market:etf-flows:v1',
  'market:crypto:v1',
  'market:stablecoins:v1',
  'economic:bis:eer:v1',
  'economic:bis:policy:v1',
  'supply_chain:shipping:v2',
  'correlation:cards-bootstrap:v1',
]);

// ── Signal type -> hard family (D3) ──────────────────────────────────────
//
// The module's OWN table — deliberately NOT the seeder's SIGNAL_TO_SOURCE
// (scripts/seed-forecasts.mjs :4136), which has no entry for any market
// signal (market_transmission/market_divergence/market_calibration/
// commodity) and maps 'chokepoint' to the supply_chain source. Leaning on
// SIGNAL_TO_SOURCE would silently collapse the market family (a priority
// hard domain) to judged and mis-map chokepoint-bearing market forecasts to
// the supply_chain feed.
//
// Real detector signal-type vocabulary (read from seed-forecasts.mjs):
//  - detectMarketScenarios (:1086)      -> 'chokepoint', 'commodity', 'cii'
//  - buildStateDerivedForecast (:1425)  -> 'market_transmission' on EVERY
//    state-derived forecast (weight 0.24) — but origin-precedence (below)
//    intercepts state_derived before this table is ever consulted.
//  - caseFile-only (not pred.signals):  'market_divergence' (:4191),
//    'market_calibration' (:4466) — never appear in pred.signals today, but
//    mapped here defensively per the plan's dispatch instructions.
//  - detectSupplyChainScenarios (:1162) -> 'chokepoint', 'ais_gap', 'gps_jamming'
//  - detectUcdpConflictZones (:1892)    -> 'ucdp'
//  - detectGpsJammingScenarios (:1983)  -> 'gps_jamming'
//  - infrastructure detector            -> 'outage'
//  - detectConflictScenarios (:1001)    -> 'cii', 'conflict_events'
//  - Polymarket/prediction-market pool  -> 'prediction_market'
export const SIGNAL_TO_HARD_FAMILY = {
  market_transmission: 'market',
  market_divergence: 'market',
  market_calibration: 'market',
  commodity: 'market',
  prediction_market: 'prediction_market',
  ucdp: 'ucdp_zone',
  gps_jamming: 'gps',
  outage: 'infrastructure',
  conflict_events: 'conflict',
  cii: 'conflict',
  chokepoint: 'supply_chain',
  ais_gap: 'supply_chain',
};

// Domains whose forecasts are ALWAYS judged (R3), regardless of what signals
// they carry. Domain is the claim's SUBJECT; signals are only evidence. A
// political-domain forecast can carry a 'cii' signal (which
// SIGNAL_TO_HARD_FAMILY maps to the conflict family) — but resolving that
// political claim against a conflict event-count metric would mis-resolve the
// political claim. Military posture-transition and cyber-volume thresholds
// also need dedicated metric design (deferred, D3). This gate is checked
// AFTER the state_derived origin check and the prediction_market exemption,
// and BEFORE the general SIGNAL_TO_HARD_FAMILY lookup, so domain wins over any
// incidental hard-mapped evidence signal — EXCEPT a prediction_market signal,
// whose forecast's claim *is* the market question (see buildResolutionSpec).
export const JUDGED_DOMAINS = new Set(['political', 'military', 'cyber']);

// Which hard families a forecast's DOMAIN permits (R3, by-domain constraint).
// Domain is the claim's SUBJECT; signals are only evidence. A market-domain
// forecast carrying a 'cii' signal (evidence of instability driving a
// commodity move) must NOT resolve as a conflict spec scored against UCDP
// event counts — 'conflict' is simply not an allowed family for domain
// 'market'. When resolving the family from signals, any family not listed for
// pred.domain is skipped; a domain absent from this table (after the
// JUDGED_DOMAINS gate) yields no hard family -> judged.
//
// Domains verified from real makePrediction call sites (seed-forecasts.mjs):
// conflict, market, supply_chain (the GPS detector emits domain 'supply_chain'),
// infrastructure, political, military, cyber; detectFromPredictionMarkets emits
// conflict|market|political (the prediction_market exemption runs BEFORE this
// gate, so those forecasts never reach the table).
export const DOMAIN_TO_HARD_FAMILIES = {
  conflict: ['conflict', 'ucdp_zone'],
  market: ['market', 'prediction_market'],
  supply_chain: ['supply_chain', 'gps'],
  infrastructure: ['infrastructure'],
};

// The commodity price-MOVE threshold ratio (market family): threshold =
// emission baseline × this. A 10% move is the "material price impact" bar.
// Named + exported so it is discoverable and a future per-commodity
// volatility model has one obvious knob to replace.
export const MARKET_PRICE_MOVE_RATIO = 1.1;

// The conflict escalation ratio (conflict/ucdp_zone count threshold, #5010):
// the horizon-scoped confirming count is the country's base event rate
// projected over the forecast horizon, escalated by this factor — "events
// materially above trend". The emission-time signal tally is a 365-day
// trailing count (seed-ucdp-events.mjs TRAILING_WINDOW_MS), so
//   threshold = max(1, round(tally365 × horizonMs/365d × this))
// counted over NEW events dated within [emission, deadline]. Like
// MARKET_PRICE_MOVE_RATIO, this is a named Bet-2 tuning knob.
export const CONFLICT_ESCALATION_RATIO = 1.5;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// FAMILY_FEED / FAMILY_WINDOW map each hard family to its default sourceFeed
// + resolution window. The market family has no single fixed feed — it is
// resolved per-forecast (commodities feed for a commodity signal, or the
// calibration fallback feed).
const FAMILY_FEED = {
  conflict: 'conflict:ucdp-events:v1',
  ucdp_zone: 'conflict:ucdp-events:v1',
  supply_chain: 'supply_chain:chokepoints:v4',
  infrastructure: 'infra:outages:v1',
  prediction_market: 'prediction:markets-bootstrap:v1',
  gps: 'intelligence:gpsjam:v2',
  // market has no single fixed feed — resolved per-forecast below from
  // whichever MARKET_INPUT_KEYS-backed calibration source is available.
};

// Window vocabulary (#5010 amendment): every value must be establishable by
// the Bet-2 resolver from the feed it names. 'within-horizon' = the condition
// is checked over [emission, deadline] (dated-record feeds) or as a deadline
// point read (snapshot feeds); 'at-deadline' = a point read of the current-
// snapshot feed at the first resolver tick at/after the deadline;
// 'at-endDate' = the prediction market's own settlement. The previous
// sustained-window value for supply_chain/gps was removed (#5010) — a
// sustained condition is unestablishable from current-snapshot feeds without
// resolver-side sampling and forced permanent VOID.
const FAMILY_WINDOW = {
  conflict: 'within-horizon',
  ucdp_zone: 'within-horizon',
  supply_chain: 'at-deadline',
  infrastructure: 'within-horizon',
  prediction_market: 'at-endDate',
  gps: 'at-deadline',
  market: 'within-horizon',
};

// ── Commodity label -> future ticker (market family) ────────────────────
//
// The market:commodities-bootstrap:v1 feed is keyed by Yahoo-style future
// symbol (verified LIVE in the R12 walkthrough: `CL=F` WTI, `BZ=F` Brent,
// `TTF=F` EU gas, `NG=F` Henry Hub, `GC=F` gold, ZW=F wheat) — NOT by the
// human commodity label the forecast carries. A market forecast's `commodity`
// signal renders as "<label> sensitivity: <n>" (seed-forecasts.mjs :1113,
// :1155), where <label> is a CHOKEPOINT_COMMODITIES value (:165). The
// metricKey must encode the resolvable TICKER, so this map bridges the two.
//
// Labels with no clean single future ticker (Semiconductors, Trade goods,
// and the ambiguous compound Shipping/Oil, Gas/Oil) are deliberately absent:
// their market forecasts cannot derive a finite threshold and fall back to
// judged (R3 no-finite-threshold fallback — confirmed load-bearing on real
// Western Pacific / South China Sea regions by the walkthrough).
export const COMMODITY_LABEL_TO_SYMBOL = {
  Oil: 'CL=F',
  Gas: 'TTF=F',
  'Grain/Energy': 'ZW=F',
};

// Per-pass inputs index (FIX 7): findCommodityPrice + findPredictionMarketEndDate
// would otherwise linear-scan the feed arrays once per forecast. Build both
// lookup maps once and memoize them on the inputs object itself via a WeakMap,
// so buildResolutionSpec's signature stays (pred, inputs, generatedAt) and
// attachResolutionSpecs pays the scan cost once for the whole batch.
// Determinism is unaffected: the index is a pure function of inputs' content.
const _inputsIndexCache = new WeakMap();

function getInputsIndex(inputs) {
  if (!inputs || typeof inputs !== 'object') {
    return { priceBySymbol: new Map(), endDateByTitle: new Map() };
  }
  const cached = _inputsIndexCache.get(inputs);
  if (cached) return cached;

  // symbol -> emission price. Guard: require a finite price > 0 (a 0 price is
  // missing upstream data, not a baseline — FIX 3a). First writer wins.
  const priceBySymbol = new Map();
  const rawQuotes = inputs.commodityQuotes;
  const quotes = Array.isArray(rawQuotes) ? rawQuotes : (rawQuotes?.quotes || []);
  for (const q of quotes) {
    const symbol = q?.symbol;
    const p = Number(q?.price);
    if (symbol && Number.isFinite(p) && p > 0 && !priceBySymbol.has(symbol)) {
      priceBySymbol.set(symbol, p);
    }
  }

  // market title (truncated to the 100 chars the seeder stores as pred.title,
  // seed-forecasts.mjs :2240) -> settlement endDate epoch ms. Keying by the
  // truncated title lets the lookup be an exact Map.get on pred.title, which
  // subsumes the exact + prefix match cases (FIX 7). First writer wins.
  const endDateByTitle = new Map();
  const markets = inputs.predictionMarkets?.geopolitical || [];
  for (const m of markets) {
    const mt = String(m?.title ?? '');
    if (!mt) continue;
    const key = mt.slice(0, 100);
    const ms = Date.parse(m.endDate);
    if (Number.isFinite(ms) && !endDateByTitle.has(key)) {
      endDateByTitle.set(key, ms);
    }
  }

  const index = { priceBySymbol, endDateByTitle };
  _inputsIndexCache.set(inputs, index);
  return index;
}

// Emission-time price for a commodity future symbol (see getInputsIndex).
// Returns null when absent/zero/non-finite so the market builder falls back to
// judged rather than fabricating a baseline.
function findCommodityPrice(inputs, symbol) {
  return getInputsIndex(inputs).priceBySymbol.get(symbol) ?? null;
}

// The market's own settlement date is the ground truth for a prediction-market
// forecast (Polymarket resolves yesPrice to ~0/~100 at endDate). Exact lookup
// on pred.title (= m.title.slice(0,100)); null when unmatched so the builder
// falls back to the horizon deadline.
function findPredictionMarketEndDate(pred, inputs) {
  if (!pred.title) return null;
  return getInputsIndex(inputs).endDateByTitle.get(pred.title) ?? null;
}

// First numeric token in the value string of a matching signal — the generic
// count extractor (e.g. "14 UCDP conflict events" -> 14).
function firstFiniteSignalCount(pred, matchTypes) {
  for (const signal of pred.signals || []) {
    if (!matchTypes.has(signal.type)) continue;
    const match = /(-?\d+(?:\.\d+)?)/.exec(String(signal.value ?? ''));
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// Percent-anchored extractor for the prediction_market baseline (FIX 6): a
// source label can itself contain a digit (e.g. "Metaculus2: 62%"), so the
// generic first-number regex would grab 2. Prefer the number immediately
// before a '%'; fall back to the generic first number.
function firstPercentSignalValue(pred, matchTypes) {
  for (const signal of pred.signals || []) {
    if (!matchTypes.has(signal.type)) continue;
    const str = String(signal.value ?? '');
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(str);
    if (pct) {
      const n = Number(pct[1]);
      if (Number.isFinite(n)) return n;
    }
    const generic = /(-?\d+(?:\.\d+)?)/.exec(str);
    if (generic) {
      const n = Number(generic[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// Resolve the hard family for a forecast from its signals, constrained by the
// forecast's DOMAIN (DOMAIN_TO_HARD_FAMILIES). A signal maps to a family via
// SIGNAL_TO_HARD_FAMILY, but only families ALLOWED for pred.domain are eligible
// — so a market-domain forecast's 'cii' signal (-> conflict) or 'chokepoint'
// signal (-> supply_chain) is skipped, and it resolves to 'market' via its
// 'commodity' signal, never to a conflict/supply_chain feed. A market forecast
// with no eligible hard signal (no commodity) yields no hard family -> judged:
// there is no calibration.marketPrice fallback (a stocks feed cannot resolve a
// prediction-market title). A domain absent from the table yields no family.
function resolveHardFamily(pred) {
  const allowed = DOMAIN_TO_HARD_FAMILIES[pred.domain];
  if (!allowed) return null;

  for (const signal of pred.signals || []) {
    const family = SIGNAL_TO_HARD_FAMILY[signal.type];
    if (family && allowed.includes(family)) return family;
  }

  return null;
}

// Derive a finite threshold + operator + window (+ baselineValue for
// 'crosses') from the forecast's own scored signals. Pragmatic per-family
// extraction — pulls the first numeric token out of the matching signal's
// `value` string (the seeder already renders these as human-readable
// "N units" strings, e.g. "14 UCDP conflict events").
function deriveHardMetrics(pred, family, inputs) {
  switch (family) {
    case 'conflict':
    case 'ucdp_zone': {
      // Count threshold comes ONLY from an actual event-count signal
      // (ucdp / conflict_events). A 'cii' value is a 0-100 composite INDEX,
      // not an event count — using it would emit a semantically wrong
      // `count(country==X) >= <ciiScore>` ground truth, and since detectors
      // emit the cii signal first it would shadow a real count. A conflict
      // forecast with only cii signals has no clean count metric -> judged.
      const tally = firstFiniteSignalCount(pred, new Set(['ucdp', 'conflict_events']));
      if (!Number.isFinite(tally)) return null;
      // Horizon-commensurable threshold (#5010): the signal tally is a
      // 365-day trailing count, but the forecast is a ~horizon claim — a raw
      // tally threshold would systematically resolve NO over the horizon
      // window (biased Brier). Scale the base rate to the horizon and apply
      // the escalation bar; count() means NEW events dated within
      // [emission, deadline] (the 'within-horizon' window).
      const horizonMs = HORIZON_MS[pred.timeHorizon];
      if (!Number.isFinite(horizonMs)) return null; // deriveDeadline throws for the judged path too
      const threshold = Math.max(1, Math.round(tally * (horizonMs / YEAR_MS) * CONFLICT_ESCALATION_RATIO));
      return {
        metricKey: `conflict:ucdp-events:v1|count(country==${pred.region})`,
        operator: '>=',
        threshold,
        window: FAMILY_WINDOW[family],
      };
    }
    case 'supply_chain': {
      // Threshold is a boolean-shaped condition (disruption present),
      // represented as riskScore >= 60 (the detector's own "disrupted"
      // gate threshold, seed-forecasts.mjs detectSupplyChainScenarios).
      return {
        metricKey: `supply_chain:chokepoints:v4|riskScore(route==${pred.region})`,
        operator: '>=',
        threshold: 60,
        window: FAMILY_WINDOW[family],
      };
    }
    case 'infrastructure': {
      return {
        metricKey: `infra:outages:v1|present(country==${pred.region})`,
        operator: '>=',
        threshold: 1,
        window: FAMILY_WINDOW[family],
      };
    }
    case 'prediction_market': {
      // Percent-anchored so a digit-bearing source label doesn't skew the
      // baseline (FIX 6). Falls back to the emission probability.
      const baseline = firstPercentSignalValue(pred, new Set(['prediction_market']));
      // Deadline source (R5 amended): the market's own endDate is when the
      // metric becomes truth — the 30d detector horizon would read a still-
      // unsettled yesPrice and score a false NO. Fall back to the horizon
      // deadline when the market/endDate is not reachable.
      const endDate = findPredictionMarketEndDate(pred, inputs);
      return {
        metricKey: `prediction:markets-bootstrap:v1|yesPrice(market==${pred.title})`,
        operator: 'crosses',
        threshold: 50,
        baselineValue: Number.isFinite(baseline) ? baseline : (Number.isFinite(pred.probability) ? Math.round(pred.probability * 100) : null),
        window: FAMILY_WINDOW[family],
        deadlineOverride: Number.isFinite(endDate) ? endDate : null,
      };
    }
    case 'gps': {
      const hexes = firstFiniteSignalCount(pred, new Set(['gps_jamming']));
      if (!Number.isFinite(hexes)) return null;
      return {
        metricKey: `intelligence:gpsjam:v2|hexCount(region==${pred.region})`,
        operator: '>=',
        threshold: Math.max(1, Math.round(hexes)),
        window: FAMILY_WINDOW[family],
      };
    }
    case 'market': {
      // Production shape (R12 walkthrough): a market forecast carries a
      // `commodity` signal whose label maps to a future ticker priced in
      // market:commodities-bootstrap:v1. metricKey MUST encode the ticker
      // (the feed is symbol-keyed), and the spec is a price MOVE ("price
      // impact"), so operator 'crosses' + baselineValue = emission price.
      const commoditySignal = (pred.signals || []).find((s) => s.type === 'commodity');
      if (commoditySignal) {
        const label = String(commoditySignal.value ?? '').split(' sensitivity:')[0].trim();
        const symbol = COMMODITY_LABEL_TO_SYMBOL[label];
        if (symbol) {
          const price = findCommodityPrice(inputs, symbol); // finite & > 0 (guarded in the index)
          if (Number.isFinite(price)) {
            return {
              metricKey: `market:commodities-bootstrap:v1|price(symbol==${symbol})`,
              sourceFeed: 'market:commodities-bootstrap:v1',
              operator: 'crosses',
              threshold: +(price * MARKET_PRICE_MOVE_RATIO).toFixed(2),
              baselineValue: +price.toFixed(2),
              window: FAMILY_WINDOW[family],
            };
          }
        }
      }
      // No commodity-ticker hard path succeeded: an unmapped label
      // (Semiconductors, Trade goods, ambiguous compounds), no emission
      // price, or no commodity signal at all -> judged (R3). There is NO
      // calibration.marketPrice hard path: a stocks feed cannot resolve a
      // prediction-market title, and its threshold===baselineValue 'crosses'
      // spec was vacuous (fails the R12 sufficiency bar every other family
      // passed).
      return null;
    }
    default:
      return null;
  }
}

function buildQuestion(pred) {
  const title = pred.title || '(untitled forecast)';
  const region = pred.region || 'unspecified region';
  const domain = pred.domain || 'unspecified domain';
  const horizon = pred.timeHorizon || 'unspecified horizon';
  return `Will "${title}" (${domain}, ${region}) resolve YES within its ${horizon} horizon?`;
}

function buildJudgedSpec(pred, generatedAt) {
  return {
    kind: 'judged',
    metricKey: null,
    operator: null,
    threshold: null,
    baselineValue: null,
    window: null,
    deadline: deriveDeadline(generatedAt, pred.timeHorizon),
    sourceFeed: null,
    question: buildQuestion(pred),
  };
}

function buildHardSpec(pred, inputs, family, generatedAt) {
  const metrics = deriveHardMetrics(pred, family, inputs);
  if (!metrics || !Number.isFinite(metrics.threshold)) {
    // Threshold fallback (R3/plan step 3): a hard family that cannot derive
    // a finite threshold emits a judged spec rather than an unresolvable
    // hard spec with a missing/NaN threshold.
    return buildJudgedSpec(pred, generatedAt);
  }
  if (metrics.operator === 'crosses' && !Number.isFinite(metrics.baselineValue)) {
    return buildJudgedSpec(pred, generatedAt);
  }
  const sourceFeed = metrics.sourceFeed || FAMILY_FEED[family];
  if (!sourceFeed || !RESOLUTION_FEED_KEYS.has(sourceFeed)) {
    return buildJudgedSpec(pred, generatedAt);
  }
  // Always compute the horizon deadline (validates the horizon, preserving
  // deriveDeadline's throw semantics for every family), then let a family
  // override it with a truth-time source (prediction_market -> market endDate).
  const horizonDeadline = deriveDeadline(generatedAt, pred.timeHorizon);
  const deadline = Number.isFinite(metrics.deadlineOverride) ? metrics.deadlineOverride : horizonDeadline;
  return {
    kind: 'hard',
    metricKey: metrics.metricKey,
    operator: metrics.operator,
    threshold: metrics.threshold,
    baselineValue: metrics.operator === 'crosses' ? metrics.baselineValue : null,
    window: metrics.window,
    deadline,
    sourceFeed,
    question: null,
  };
}

// Build the resolution spec for one forecast. Deterministic: identical
// (pred, inputs, generatedAt) always yields an identical spec.
//
// Dispatch order (load-bearing — see plan D3 + Addendum + R12 walkthroughs):
//  1. state_derived origin -> ALWAYS judged, before any family lookup.
//     buildStateDerivedForecast attaches a 'market_transmission' signal
//     (weight 0.24) to every state-derived forecast, so a family-first
//     dispatch would misclassify all of them as hard/market.
//  2. prediction_market family -> hard, BEFORE the JUDGED_DOMAINS gate. A
//     detectFromPredictionMarkets forecast's CLAIM *is* the market question
//     (seed-forecasts.mjs :2228-2242), so the market's own resolution is the
//     claim's ground truth regardless of the domain the detector assigned
//     (which can be political/conflict/market). This is unlike a 'cii' signal
//     on a political claim (evidence, not the claim) — hence the exemption.
//  3. JUDGED_DOMAINS (political/military/cyber) -> ALWAYS judged. Domain is
//     the claim's subject; a political forecast carrying a hard-mapped
//     evidence signal (e.g. 'cii' -> conflict) must not be resolved against a
//     conflict metric (R3, by-domain assignment).
//  4. Other hard families resolved from pred.signals[].type via
//     SIGNAL_TO_HARD_FAMILY (with the market-domain chokepoint/ais_gap
//     exclusion + a calibration.marketPrice fallback for market-domain
//     forecasts with no direct market-signal match).
//  5. If a hard family is found but yields no finite threshold (or, for
//     'crosses', no finite baselineValue, or an unmapped sourceFeed) -> judged.
//  6. Otherwise (no-signal-match/unrecognized domain) -> judged.
// deriveDeadline is the only call that can throw (an unrecognized horizon);
// buildResolutionSpec itself never throws.
export function buildResolutionSpec(pred, inputs, generatedAt) {
  if (pred.generationOrigin === 'state_derived') {
    return buildJudgedSpec(pred, generatedAt);
  }

  // prediction_market exemption (before the JUDGED_DOMAINS gate).
  const hasPredictionMarketSignal = (pred.signals || []).some(
    (s) => SIGNAL_TO_HARD_FAMILY[s.type] === 'prediction_market',
  );
  if (hasPredictionMarketSignal) {
    return buildHardSpec(pred, inputs, 'prediction_market', generatedAt);
  }

  if (JUDGED_DOMAINS.has(pred.domain)) {
    return buildJudgedSpec(pred, generatedAt);
  }

  const family = resolveHardFamily(pred);
  if (!family) {
    return buildJudgedSpec(pred, generatedAt);
  }

  return buildHardSpec(pred, inputs, family, generatedAt);
}

// The seam pass (D1): sets pred.resolution on every prediction in place and
// returns the (same) array for chaining, mirroring the existing
// calibrateWithMarkets / computeProjections enrichment-pass convention.
export function attachResolutionSpecs(predictions, inputs, generatedAt) {
  for (const pred of predictions) {
    pred.resolution = buildResolutionSpec(pred, inputs, generatedAt);
  }
  return predictions;
}
