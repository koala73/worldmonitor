/**
 * Market-alert ledger (#8867): the pure steps behind
 * scripts/seed-market-alert-ledger.mjs. A market alert that is new under the
 * recency rule in ingestSignals, or a prediction alert whose question names a
 * topic keyword, opens a six-hour window keyed `${type}:${entity}@${deadline}`; a
 * closed window is resolved against the English digest archive under
 * MARKET_ALERT_RESOLUTION_RULE, and a control window 24 hours earlier under
 * MARKET_ALERT_BASE_RATE_RULE.
 * Redis never appears here: the archive is injected, so tests run on fixtures.
 */

import { MARKET_ALERT_TYPES, TOPIC_MAPPINGS, predictionMarketKey } from './shared/market-alert-core.js';
import { findEntitiesInText, getEntityIndex, lookupEntityByAlias } from './shared/entity-extraction-core.js';
import { SUPPRESSED_TRENDING_TERMS, TOPIC_KEYWORDS, containsTopicKeyword, escapeRegex } from './shared/text-analysis-core.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const MARKET_ALERT_LEDGER_KEY = 'correlation:market-alerts:ledger:v1';
export const MARKET_ALERT_SCORECARD_KEY = 'correlation:market-alerts:scorecard:v1';
export const MARKET_ALERT_SNAPSHOT_KEY = 'correlation:market-alerts:snapshot:v1';
export const MARKET_ALERT_SEED_META_KEY = 'seed-meta:correlation:market-alerts';
export const MARKET_ALERT_SCORECARD_META_KEY = 'seed-meta:correlation:market-alerts-scorecard';
export const MARKET_ALERT_SNAPSHOT_META_KEY = 'seed-meta:correlation:market-alerts-snapshot';
export const MARKET_ALERT_ACTIVATION_KEY = 'seed-activated:correlation:market-alerts';
export const MARKET_ALERT_COMPLETION_META_KEY = 'seed-completion:correlation:market-alerts';

export const MARKET_ALERT_WINDOW_MS = 6 * HOUR_MS;
export const MARKET_ALERT_CONTROL_OFFSET_MS = DAY_MS;
export const MARKET_ALERT_EVIDENCE_EXPIRY_MS = 6 * DAY_MS;
export const MARKET_ALERT_ROLLING_WINDOW_DAYS = 30;
export const MARKET_ALERT_LEDGER_RETENTION_MS = MARKET_ALERT_ROLLING_WINDOW_DAYS * DAY_MS;
export const MARKET_ALERT_TICK_MS = 5 * 60 * 1000;
// Holds this close together, in observed time, are one run of activity. The
// seeder's SNAPSHOT_MAX_AGE_MS is the same 15 minutes by design: a snapshot
// too old to be a baseline holds every alert still emitted.
export const MARKET_ALERT_ACTIVITY_GAP_MS = 3 * MARKET_ALERT_TICK_MS;
// The cap drops the oldest run even when it is still inside retention, so
// more than eight separate held runs in the retention window lose the
// earliest.
export const MARKET_ALERT_ACTIVITY_MAX_RUNS = 8;
// A due row may wait the evidence expiry before it resolves, and its control
// window starts an offset plus a window before that.
export const MARKET_ALERT_ACTIVITY_RETENTION_MS = MARKET_ALERT_CONTROL_OFFSET_MS + MARKET_ALERT_WINDOW_MS + MARKET_ALERT_EVIDENCE_EXPIRY_MS;
export const MARKET_ALERT_CONFIDENCE_GATE = 0.6;
export const MARKET_ALERT_HIT_MAX_TIER = 2;
export const MARKET_ALERT_MAX_DESCRIPTION_CHARS = 200;
export const MARKET_ALERT_LEDGER_SOURCE_VERSION = 'market-alert-ledger-v1';
export const MARKET_ALERT_LEDGER_SCHEMA_VERSION = 1;

export const MARKET_ALERT_RESOLUTION_RULE = 'An emission resolves HIT when a story first tracked by the English news digest within six hours after the emission has at least one Tier 1 or Tier 2 source and its title names the same entity: for a market, an alias match for the symbol\'s registry entity or a whole-word match of the market name of four or more characters; for a prediction market, a topic keyword that appears in the question itself. It resolves MISS when six hours pass with no such story. It resolves VOID, and is not counted, when the story archive for its window expired before the resolver read it. Lead time is the gap between emission and the matching story\'s first tracking.';
export const MARKET_ALERT_BASE_RATE_RULE = 'The base rate applies the same rule to a control window of the same length for the same entity that starts 24 hours before each scored emission, counted only when the archive covers the control window, no alert for that entity was open during it, and the emission and the control fall on the same side of a weekend in UTC.';

const ALERT_TYPES = new Set(MARKET_ALERT_TYPES);

const PREDICTION_TOPIC_KEYWORDS = [...new Set([
  ...TOPIC_KEYWORDS.filter((keyword) => !SUPPRESSED_TRENDING_TERMS.has(keyword)),
  ...Object.keys(TOPIC_MAPPINGS),
])];

function pruneUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

export function sortLedger(ledger) {
  return Object.fromEntries(Object.entries(ledger).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function entityForMarket(market) {
  const index = getEntityIndex();
  const entityId = index.byId.has(market.symbol)
    ? market.symbol
    : (lookupEntityByAlias(market.symbol.toLowerCase(), index)?.id ?? null);
  return { kind: 'market', symbol: market.symbol, name: market.name, entityId };
}

export function entityForPrediction(prediction) {
  const titleLower = prediction.title.toLowerCase();
  const relatedTopics = PREDICTION_TOPIC_KEYWORDS.filter((keyword) => containsTopicKeyword(titleLower, keyword));
  return pruneUndefined({ kind: 'prediction', title: prediction.title, url: prediction.url || undefined, relatedTopics });
}

function entityKeyOf(id) {
  return id.slice(id.indexOf(':') + 1);
}

function findOpenWindow(ledger, id, nowMs) {
  return Object.values(ledger).find((entry) => entry.status === 'pending' && entry.id === id && nowMs < entry.deadline);
}

function latestRow(rows, id) {
  return rows
    .filter((entry) => entry.id === id)
    .reduce((latest, entry) => (latest === null || entry.emittedAt > latest.emittedAt ? entry : latest), null);
}

const withinGap = (sinceMs, nowMs) => nowMs - sinceMs <= MARKET_ALERT_ACTIVITY_GAP_MS;
const lastSeen = (row) => Math.max(row.deadline, row.lastSeenAt ?? 0);
// A row is held activity too: its window, and every hold that bumped it.
const spanOf = (row) => ({ since: row.emittedAt, until: lastSeen(row), types: [row.type] });
const unionTypes = (a, b) => [...new Set([...a, ...b])].sort();

// Spans of held activity no more than the gap apart are one stretch, and the
// stretch that reaches the gap before nowMs is the move still under way.
function currentStretch(spans, nowMs) {
  let stretch = null;
  for (const span of [...spans].sort((a, b) => a.since - b.since)) {
    stretch = stretch !== null && span.since <= stretch.until + MARKET_ALERT_ACTIVITY_GAP_MS
      ? { since: stretch.since, until: Math.max(stretch.until, span.until), types: unionTypes(stretch.types, span.types) }
      : span;
  }
  return stretch !== null && withinGap(stretch.until, nowMs) ? stretch : null;
}

// The detector flips a move between explained and silent as the digest
// changes. Each market type says whether the move under way holds a new row.
// A quiet-market alert is held by any move under way, so neither the flip
// itself nor a dropout inside another type's window reopens the move. An
// explained alert is held only by a move that has already held or rowed
// explained, so a move that was silent and then found its news still gets
// its explained row.
const HOLD_RULES = {
  explained_market_move: (stretch) => stretch.types.includes('explained_market_move'),
  silent_divergence: () => true,
  flow_price_divergence: () => true,
};

function extendRuns(runs = [], nowMs, type) {
  const last = runs.at(-1);
  if (last && withinGap(last.until, nowMs)) return [...runs.slice(0, -1), { since: last.since, until: nowMs, types: unionTypes(last.types, [type]) }];
  return [...runs, { since: nowMs, until: nowMs, types: [type] }].slice(-MARKET_ALERT_ACTIVITY_MAX_RUNS);
}

// Ticks the seeder skipped observed nothing, so the interval since the last
// snapshot counts for one tick: every row and every symbol's last run that
// was fresh at the snapshot moves forward by the unobserved remainder, never
// past nowMs. A move fresh at the snapshot is one tick older now whatever
// the outage lasted, and one already stale stays stale, so a move that ended
// before the outage can open a new row afterwards.
function carryAcrossGap(ledger, runs, observedAt, nowMs) {
  const unobserved = observedAt === null ? 0 : Math.max(0, nowMs - observedAt - MARKET_ALERT_TICK_MS);
  if (unobserved === 0) return { runs, carried: 0 };
  const carry = (seenMs) => Math.min(nowMs, seenMs + unobserved);
  let carried = 0;
  for (const row of Object.values(ledger)) {
    if (!withinGap(lastSeen(row), observedAt) || lastSeen(row) >= nowMs) continue;
    ledger[row.key] = { ...row, lastSeenAt: carry(lastSeen(row)) };
    carried += 1;
  }
  const activity = Object.fromEntries(Object.entries(runs).map(([symbol, symbolRuns]) => {
    const last = symbolRuns.at(-1);
    if (!withinGap(last.until, observedAt)) return [symbol, symbolRuns];
    carried += 1;
    return [symbol, [...symbolRuns.slice(0, -1), { ...last, until: carry(last.until) }]];
  }));
  return { runs: activity, carried };
}

function createEntry(signal, entity, nowMs, runtimeMode) {
  const id = `${signal.type}:${signal.data.correlatedEntities[0]}`;
  const deadline = nowMs + MARKET_ALERT_WINDOW_MS;
  return pruneUndefined({
    id,
    key: `${id}@${deadline}`,
    type: signal.type,
    entity,
    emittedAt: nowMs,
    deadline,
    observedChange: signal.data.marketChange ?? signal.data.predictionShift,
    newsVelocity: signal.data.newsVelocity,
    confidence: signal.confidence,
    runtimeMode,
    description: String(signal.description ?? '').slice(0, MARKET_ALERT_MAX_DESCRIPTION_CHARS),
    lastSeenAt: nowMs,
    samples: 0,
    status: 'pending',
  });
}

/**
 * A market signal opens a row only under the recency rule: no stretch of
 * held activity for the symbol reaches the gap before this tick, or the one
 * that does fails to hold the type under HOLD_RULES. A stretch is built from
 * the symbol's runs in `activity` and every row of the symbol, whatever its
 * status, each a span from its emission to its deadline or `lastSeenAt`,
 * whichever is later, with spans no more than MARKET_ALERT_ACTIVITY_GAP_MS
 * apart merged and their types pooled, so a move that stays elevated opens
 * one row per type however the detector flips it between explained and
 * silent, and a move that was silent and then found its news gets its
 * explained row. A symbol without a baseline (`baseline` null, or the symbol
 * absent from `baseline.marketChanges` because its feed skipped the previous
 * tick) is held, so every alert still emitted after a seeder gap or a cold
 * start stays held. Every hold records its sighting: one whose same-type row
 * is still fresh bumps that row's `lastSeenAt`, whatever its status, so a
 * closed window whose alert keeps firing still blocks a later control window;
 * every other hold extends or starts a run naming the type, so the move
 * cannot reopen inside the gap however the hold came about. `activity` maps a
 * symbol to its newest MARKET_ALERT_ACTIVITY_MAX_RUNS runs
 * `{ since, until, types }` in ms, oldest first, where holds no more than the
 * gap apart share a run; it is carried forward pruned to runs that ended
 * inside MARKET_ALERT_ACTIVITY_RETENTION_MS, long enough for the control
 * window of an emission that resolves at its deadline. `observedAt` is when
 * `activity` was observed; the ticks skipped since then observed nothing and
 * count as one, so a seeder outage does not age a move. `emitted` in the
 * result is this tick's gated market ids, sorted, for the snapshot.
 */
export function ingestSignals(existing, signals, { nowMs, runtimeMode, markets, predictions, baseline, activity: previousActivity = baseline?.activity ?? {}, observedAt = null }) {
  const ledger = { ...existing };
  const marketsBySymbol = new Map(markets.map((market) => [market.symbol, market]));
  const predictionsByKey = new Map(predictions.map((prediction) => [predictionMarketKey(prediction), prediction]));
  const retained = Object.fromEntries(Object.entries(previousActivity)
    .map(([symbol, symbolRuns]) => [symbol, symbolRuns.filter((run) => run.until >= nowMs - MARKET_ALERT_ACTIVITY_RETENTION_MS)])
    .filter(([, symbolRuns]) => symbolRuns.length > 0));
  const { runs, carried } = carryAcrossGap(ledger, retained, observedAt, nowMs);
  // Holds read the runs and rows as the tick began, so a symbol's outcome
  // does not depend on the order of its signals within the tick.
  const rows = Object.values(ledger);
  const activity = { ...runs };
  const emitted = new Set();
  let created = 0;
  let updated = 0;
  let gated = 0;
  let held = 0;
  let touched = carried;
  for (const signal of signals) {
    const entityKey = signal.data?.correlatedEntities?.[0];
    if (!ALERT_TYPES.has(signal.type) || !(signal.confidence >= MARKET_ALERT_CONFIDENCE_GATE) || !entityKey) {
      gated += 1;
      continue;
    }
    const id = `${signal.type}:${entityKey}`;
    if (signal.type !== 'prediction_leads_news') emitted.add(id);
    const open = findOpenWindow(ledger, id, nowMs);
    if (open) {
      ledger[open.key] = { ...open, lastSeenAt: nowMs, samples: open.samples + 1 };
      updated += 1;
      continue;
    }
    let entity;
    if (signal.type === 'prediction_leads_news') {
      entity = entityForPrediction(predictionsByKey.get(entityKey));
      if (entity.relatedTopics.length === 0) {
        gated += 1;
        continue;
      }
    } else {
      const quoted = baseline !== null && Object.hasOwn(baseline.marketChanges, entityKey);
      const symbolRows = rows.filter((entry) => entityKeyOf(entry.id) === entityKey);
      const latest = latestRow(symbolRows, id);
      const stretch = currentStretch([...(runs[entityKey] ?? []), ...symbolRows.map(spanOf)], nowMs);
      if (!quoted || (stretch !== null && HOLD_RULES[signal.type](stretch))) {
        held += 1;
        touched += 1;
        if (latest !== null && withinGap(lastSeen(latest), nowMs)) ledger[latest.key] = { ...latest, lastSeenAt: nowMs };
        else activity[entityKey] = extendRuns(activity[entityKey], nowMs, signal.type);
        continue;
      }
      entity = entityForMarket(marketsBySymbol.get(entityKey));
    }
    const entry = createEntry(signal, entity, nowMs, runtimeMode);
    ledger[entry.key] = entry;
    created += 1;
  }
  return { ledger: sortLedger(ledger), created, updated, gated, held, touched, emitted: [...emitted].sort(), activity };
}

export function storyMatchesEntity(title, entity, entityMatches) {
  if (entity.kind === 'prediction') {
    const titleLower = title.toLowerCase();
    return entity.relatedTopics.some((topic) => containsTopicKeyword(titleLower, topic));
  }
  if (entity.entityId) {
    const matches = entityMatches ?? findEntitiesInText(title);
    if (matches.some((match) => match.matchType === 'alias' && match.entityId === entity.entityId)) return true;
  }
  return entity.name.length >= 4 && new RegExp(`\\b${escapeRegex(entity.name)}\\b`, 'i').test(title);
}

function resolveEntry(entry, outcome, nowMs, evidence, control) {
  return pruneUndefined({ ...entry, status: 'resolved', outcome, resolvedAt: nowMs, evidence, control });
}

function scoreControl(control, qualifying) {
  if (control.outcome === 'skipped') return control;
  const { start, end, candidates } = control;
  const story = qualifying(candidates);
  return story ? { start, end, outcome: 'HIT', storyHash: story.hash } : { start, end, outcome: 'MISS' };
}

function countPending(ledger) {
  return Object.values(ledger).filter((entry) => entry.status === 'pending').length;
}

const NO_ARCHIVE_READ = { read: false, readFailed: false, truncated: false, coveredFromMs: null, readAt: null };

function resolution(ledger, counts, archiveStatus) {
  return { ledger: sortLedger(ledger), ...counts, pending: countPending(ledger), ...archiveStatus };
}

function isWeekend(ms) {
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * VOID is a clock verdict and needs no archive read. Everything else fails
 * closed: a null story or source read leaves the due entries pending for the
 * next tick rather than scoring them against a partial archive. A window is
 * scored only when the archive still holds a story last seen at or before the
 * window opened, because an accumulator that expired and was rebuilt cannot
 * prove absence. A truncated read keeps the newest stories, so `coveredFromMs`
 * rises and the oldest due rows stay unproven until they void; the newest
 * rows resolve first.
 *
 * Each HIT or MISS also scores a control window of the same length that
 * starts 24 hours before the emission, under the same matching and tier
 * rule, so the scorecard can publish a base rate beside the hit rate. The
 * control is skipped when its start is older than the evidence expiry, when
 * the emission and the control start fall on different sides of a weekend
 * in UTC, when the archive does not cover its start, or when any alert for
 * the same entity was open, still re-emitting while held, or held with no
 * fresh row of its type as a run in `activity` (see ingestSignals), during it.
 *
 * `read` says whether the archive was read this pass (a tick with nothing
 * due reads nothing) and `readAt` is when; a failed read leaves every
 * resolvable entry unproven.
 */
export async function resolveDueEntries(existing, { nowMs, archive, activity = {} }) {
  const ledger = { ...existing };
  const counts = { hit: 0, miss: 0, void: 0, unproven: 0 };
  const resolvable = [];
  for (const entry of Object.values(ledger)) {
    if (entry.status !== 'pending' || entry.deadline >= nowMs) continue;
    if (entry.deadline < nowMs - MARKET_ALERT_EVIDENCE_EXPIRY_MS) {
      ledger[entry.key] = resolveEntry(entry, 'VOID', nowMs, { reason: 'evidence_expired' });
      counts.void += 1;
    } else {
      resolvable.push(entry);
    }
  }
  if (resolvable.length === 0) return resolution(ledger, counts, NO_ARCHIVE_READ);

  const readStatus = { ...NO_ARCHIVE_READ, read: true, readAt: nowMs };
  const failedRead = (status) => resolution(ledger, { ...counts, unproven: resolvable.length }, { ...status, readFailed: true });
  const archived = await archive.readStories(Math.min(...resolvable.map((entry) => entry.emittedAt)) - MARKET_ALERT_CONTROL_OFFSET_MS);
  if (!Array.isArray(archived?.stories)) return failedRead(readStatus);
  const { coveredFromMs, truncated, stories } = archived;
  const archiveStatus = { ...readStatus, truncated, coveredFromMs };
  const proven = resolvable.filter((entry) => coveredFromMs != null && entry.emittedAt >= coveredFromMs);
  counts.unproven = resolvable.length - proven.length;

  const entityMatchCache = new Map();
  const entityMatchesFor = (title) => {
    if (!entityMatchCache.has(title)) entityMatchCache.set(title, findEntitiesInText(title));
    return entityMatchCache.get(title);
  };
  const matching = (entry, fromMs, toMs) => stories
    .filter((story) => story.firstSeen >= fromMs && story.firstSeen <= toMs)
    .filter((story) => storyMatchesEntity(
      story.title,
      entry.entity,
      entry.entity.kind === 'market' && entry.entity.entityId ? entityMatchesFor(story.title) : undefined,
    ))
    .sort((a, b) => a.firstSeen - b.firstSeen);
  const controlWindow = (entry) => {
    const start = entry.emittedAt - MARKET_ALERT_CONTROL_OFFSET_MS;
    const end = start + MARKET_ALERT_WINDOW_MS;
    // A story:track row outlives its first sighting by seven days, so a start
    // older than six days can be claimed covered after its stories are gone.
    if (start < nowMs - MARKET_ALERT_EVIDENCE_EXPIRY_MS) return { start, end, outcome: 'skipped', reason: 'expired' };
    if (isWeekend(entry.emittedAt) !== isWeekend(start)) return { start, end, outcome: 'skipped', reason: 'weekend' };
    if (coveredFromMs > start) return { start, end, outcome: 'skipped', reason: 'uncovered' };
    const entityKey = entityKeyOf(entry.id);
    const open = Object.values(ledger).some((other) => entityKeyOf(other.id) === entityKey
      && other.emittedAt <= end && Math.max(other.deadline, other.lastSeenAt ?? 0) >= start)
      || (activity[entityKey] ?? []).some((run) => run.since <= end && run.until >= start);
    if (open) return { start, end, outcome: 'skipped', reason: 'overlap' };
    return { start, end, candidates: matching(entry, start, end) };
  };
  const windows = proven.map((entry) => ({ entry, live: matching(entry, entry.emittedAt, entry.deadline), control: controlWindow(entry) }));

  const hashes = [...new Set(windows.flatMap(({ live, control }) => [...live, ...(control.candidates ?? [])].map((story) => story.hash)))];
  const sourceTierByHash = hashes.length > 0 ? await archive.readSourceTiers(hashes) : new Map();
  if (!(sourceTierByHash instanceof Map)) return failedRead(archiveStatus);

  const qualifying = (candidates) => candidates.find((story) => (sourceTierByHash.get(story.hash)?.tier ?? 4) <= MARKET_ALERT_HIT_MAX_TIER);
  for (const { entry, live, control } of windows) {
    const evidence = qualifying(live);
    const scoredControl = scoreControl(control, qualifying);
    if (evidence) {
      const { tier, source } = sourceTierByHash.get(evidence.hash);
      ledger[entry.key] = resolveEntry(entry, 'HIT', nowMs, {
        storyHash: evidence.hash,
        title: evidence.title,
        source,
        tier,
        firstSeen: evidence.firstSeen,
        leadTimeMs: evidence.firstSeen - entry.emittedAt,
      }, scoredControl);
      counts.hit += 1;
    } else {
      ledger[entry.key] = resolveEntry(entry, 'MISS', nowMs, { reason: 'no_matching_story', candidates: live.length }, scoredControl);
      counts.miss += 1;
    }
  }
  return resolution(ledger, counts, archiveStatus);
}

export function pruneLedger(ledger, nowMs) {
  const cutoff = nowMs - MARKET_ALERT_LEDGER_RETENTION_MS;
  return Object.fromEntries(Object.entries(ledger).filter(([, entry]) => entry.status !== 'resolved' || entry.resolvedAt >= cutoff));
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * `archive` is the status of the latest resolution pass that read the
 * archive, from resolveDueEntries or carried over from the previous
 * scorecard; only its published fields are copied. `pairedHitRate` is the
 * live hit rate over the rows whose control scored, so it is the like-for-like
 * comparison with `baseHitRate`.
 */
export function buildScorecard(ledger, nowMs, { archive }) {
  const entries = Object.values(ledger);
  const since = nowMs - MARKET_ALERT_LEDGER_RETENTION_MS;
  const scored = entries.filter((entry) => entry.status === 'resolved' && entry.resolvedAt >= since);
  const rowFor = (type) => {
    const pending = entries.filter((entry) => entry.status === 'pending' && (type === null || entry.type === type)).length;
    const resolved = scored.filter((entry) => type === null || entry.type === type);
    const count = (outcome) => resolved.filter((entry) => entry.outcome === outcome).length;
    const hit = count('HIT');
    const miss = count('MISS');
    const paired = resolved.filter((entry) => entry.control?.outcome === 'HIT' || entry.control?.outcome === 'MISS');
    const pairedHit = paired.filter((entry) => entry.outcome === 'HIT').length;
    const baseHit = paired.filter((entry) => entry.control.outcome === 'HIT').length;
    return {
      pending,
      resolved: resolved.length,
      hit,
      miss,
      void: count('VOID'),
      n: hit + miss,
      hitRate: hit + miss > 0 ? hit / (hit + miss) : null,
      pairedHitRate: paired.length > 0 ? pairedHit / paired.length : null,
      baseN: paired.length,
      baseHitRate: paired.length > 0 ? baseHit / paired.length : null,
      medianLeadTimeMs: median(resolved.filter((entry) => entry.outcome === 'HIT').map((entry) => entry.evidence.leadTimeMs)),
    };
  };
  const totals = rowFor(null);
  return {
    schemaVersion: 1,
    generatedAt: nowMs,
    windowHours: MARKET_ALERT_WINDOW_MS / HOUR_MS,
    rollingWindowDays: MARKET_ALERT_ROLLING_WINDOW_DAYS,
    methodology: `${MARKET_ALERT_RESOLUTION_RULE} ${MARKET_ALERT_BASE_RATE_RULE}`,
    totals: { entries: entries.length, pending: totals.pending, resolved: totals.resolved, hit: totals.hit, miss: totals.miss, void: totals.void },
    archive: { readFailed: archive.readFailed, truncated: archive.truncated, unproven: archive.unproven, coveredFromMs: archive.coveredFromMs, readAt: archive.readAt ?? null },
    byType: MARKET_ALERT_TYPES.map((type) => ({ type, ...rowFor(type) })),
  };
}
