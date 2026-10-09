// Frozen evaluation cohorts (#7066).
//
// A cohort is the set of resolution windows (`id@deadline` ledger keys) opened
// by forecasts emitted inside a fixed time range, recorded once with their
// origin, domain, lane and code version, and then reconciled entry by entry
// against the live ledger. Freezing the keys first means no later change to the
// resolver, the scorecard filters or the rolling window can drop an entry from
// the denominator: every frozen key is reported, including keys the ledger no
// longer holds.
//
// Pure: callers pass the ledger, history and trace reads and the clock.

import { createHash } from 'node:crypto';

import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { scoredHorizonKeys } from './_forecast-resolution.mjs';
import {
  DEFAULT_JUDGED_SLA_MS,
  JUDGED_EVIDENCE_GRACE_MS,
  RESOLVER_CYCLE_MS,
  generationOriginOf,
  hardSlaMs,
  isDuplicateWindow,
  isHorizonEntry,
  isPlaceholderBet,
  isPublishedOriginEntry,
  isWithheldEntry,
  slaDueAt,
} from './_forecast-scorecard.mjs';
import {
  REGISTRATION_GAP_REASONS,
  collectHistoryEmissions,
  emissionCandidate,
  indexQuestionWindows,
  ingestHistory,
  registrationGapReason,
  windowQuestionKey,
} from './seed-forecast-resolutions.mjs';

// 3: each entry carries its own service level, which the whole-manifest hash
// covers.
export const COHORT_SCHEMA_VERSION = 3;

// The resolver reads history when its run starts and writes the ledger minutes
// later, so a ledger write shortly after an emission does not show the
// resolver read it. A key counts as missing only after a ledger write at least
// one resolver cycle (RESOLVER_CYCLE_MS, the scorecard's) after the emitting
// run, or once its SLA has ended.
export { RESOLVER_CYCLE_MS };

// Reconciliation classes. Every frozen entry gets exactly one.
export const COHORT_CLASSES = Object.freeze([
  'immature',
  'pending_in_sla',
  'pending_breach',
  'terminal_in_sla',
  'terminal_late',
  'sla_unmeasurable',
  'awaiting_registration',
  'missing_from_ledger',
]);
const BREACH_CLASSES = new Set(['pending_breach', 'terminal_late', 'missing_from_ledger', 'sla_unmeasurable']);

function ledgerMap(raw) {
  const data = unwrapEnvelope(raw).data;
  if (!data) return {};
  if (Array.isArray(data)) return Object.fromEntries(data.filter(Boolean).map((entry) => [entry.key || `${entry.id}@${entry.deadline}`, entry]));
  return typeof data === 'object' ? data : {};
}

export function cohortLane(entry) {
  if (isHorizonEntry(entry)) return 'horizon';
  return entry?.spec?.kind === 'judged' || entry?.evidence?.kind === 'judged' ? 'judged' : 'hard';
}

// The run that emitted a window is the snapshot whose generatedAt the window
// records as firstSeenAt. In order: a stamp on the ledger row; a codeVersion on
// that snapshot (forecast or bet history); the forecast trace pointer of the
// same run, whose triggerContext records the deploy SHA (the pointer list
// keeps 50 entries, about 25 runs); a prior manifest of the same windows.
function codeVersionIndex(snapshots, traceRuns, priorManifest) {
  const bySnapshot = new Map();
  for (const snapshot of snapshots) {
    if (snapshot?.codeVersion) bySnapshot.set(Number(snapshot.generatedAt), String(snapshot.codeVersion));
  }
  const byRun = new Map();
  for (const pointer of traceRuns || []) {
    const sha = pointer?.triggerContext?.deployRevision;
    if (sha) byRun.set(Number(pointer.generatedAt), String(sha));
  }
  const byPriorKey = new Map();
  for (const entry of priorManifest?.entries || []) {
    if (entry?.codeVersion && entry.codeVersionSource !== 'unknown') byPriorKey.set(entry.key, entry.codeVersion);
  }
  return (key, entry, liveEntry) => {
    if (typeof liveEntry?.codeVersion === 'string' && liveEntry.codeVersion) return { codeVersion: liveEntry.codeVersion, codeVersionSource: 'ledger' };
    // A projected row takes its snapshot's stamp through ingest.
    if (typeof entry.codeVersion === 'string' && entry.codeVersion) return { codeVersion: entry.codeVersion, codeVersionSource: 'history' };
    const runAt = Number(entry.firstSeenAt);
    if (bySnapshot.has(runAt)) return { codeVersion: bySnapshot.get(runAt), codeVersionSource: 'history' };
    if (byRun.has(runAt)) return { codeVersion: byRun.get(runAt), codeVersionSource: 'trace_run' };
    if (byPriorKey.has(key)) return { codeVersion: byPriorKey.get(key), codeVersionSource: 'prior_manifest' };
    return { codeVersion: '', codeVersionSource: 'unknown' };
  };
}

// The service level a window is held to: the one the resolver stamped on the
// row when it opened (#7072), else its lane's level from the spec, as the
// scorecard's slaDueAt falls back. Horizon windows are hard windows here.
export function cohortSla(entry) {
  const lane = cohortLane(entry) === 'judged' ? 'judged' : 'hard';
  const stamped = entry?.sla?.lane === lane ? Number(entry.sla.ms) : NaN;
  if (Number.isFinite(stamped)) return { lane, ms: stamped, source: 'stamp' };
  return { lane, ms: lane === 'judged' ? DEFAULT_JUDGED_SLA_MS : hardSlaMs(entry?.spec), source: 'spec' };
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const value = row[field] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Everything but the hash itself, so editing the SLA, range, filters or any
// entry is detected.
export function hashCohortManifest(manifest) {
  const { manifestSha256: _hash, ...rest } = manifest;
  return sha256(rest);
}

function refuseUncoveredHistory(name, list, startMs) {
  const times = (list || []).map((row) => Number(row?.generatedAt)).filter(Number.isFinite);
  if (!times.length) throw new Error(`${name} is empty or expired; cannot account for its emissions`);
  // The list is capped and LPUSH-prepended. A surviving snapshot older than
  // the range proves no run inside the range was trimmed.
  if (Math.min(...times) >= startMs) {
    throw new Error(`${name} starts at ${new Date(Math.min(...times)).toISOString()}, not before the range start; emissions at the start may be trimmed`);
  }
}

/**
 * Freeze the windows opened by emissions in [startMs, endMs).
 *
 * The ledger is projected through the resolver's own ingestHistory, so a
 * window the next resolver run will open from history already read is frozen
 * under the key it will get; `registeredAtFreeze` says whether the live ledger
 * already held it. An emission that maps to no window (for example, its
 * deadline passed before a resolver run saw it) is frozen too, as a window the
 * ledger lacks, so whether it counts never depends on when the freeze ran.
 * Missing horizon windows of a cohort window are frozen the same way.
 */
export function freezeCohort({
  cohortId,
  startMs,
  endMs,
  nowMs,
  ledger,
  historySnapshots = [],
  betsSnapshots = [],
  traceRuns = [],
  origins = null,
  domains = null,
  note = '',
  sources = {},
  priorManifest = null,
}) {
  if (!cohortId || !/^[a-z0-9][a-z0-9-]*$/.test(cohortId)) throw new Error('cohortId must be lowercase letters, digits and dashes');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error('the emission window needs start < end');
  if (!Number.isFinite(nowMs) || nowMs < endMs) throw new Error('a cohort is frozen only after its emission window closes');
  refuseUncoveredHistory('forecast history', historySnapshots, startMs);
  refuseUncoveredHistory('bet history', betsSnapshots, startMs);

  const live = ledgerMap(ledger);
  const snapshots = [...historySnapshots, ...betsSnapshots].filter(Boolean);
  const projected = ingestHistory(ledger || {}, snapshots, nowMs);
  const codeVersionOf = codeVersionIndex(snapshots, traceRuns, priorManifest);
  const originSet = origins?.length ? new Set(origins) : null;
  const domainSet = domains?.length ? new Set(domains) : null;
  const inRange = (ms) => ms >= startMs && ms < endMs;
  const passesFilters = (entry) => (!originSet || originSet.has(generationOriginOf(entry)))
    && (!domainSet || domainSet.has(entry.domain || 'unknown'));

  const entries = new Map();
  const freeze = (key, entry, extra) => {
    entries.set(key, {
      key,
      id: entry.id,
      title: String(entry.title || '').slice(0, 160),
      domain: entry.domain || 'unknown',
      region: entry.region || '',
      origin: generationOriginOf(entry),
      lane: cohortLane(entry),
      ...(isHorizonEntry(entry) && { horizon: entry.spec.horizon, parentKey: entry.parentKey }),
      generatedAt: Number(entry.generatedAt),
      firstSeenAt: Number(entry.firstSeenAt),
      deadline: Number(entry.deadline),
      ...codeVersionOf(key, entry, live[key]),
      sla: cohortSla(entry),
      ...(typeof entry.emissionHash === 'string' && { emissionHash: entry.emissionHash }),
      publishedOrigin: isPublishedOriginEntry(entry) && !isWithheldEntry(entry),
      ...extra,
    });
  };
  for (const [key, entry] of Object.entries(projected)) {
    if (!entry || !inRange(Number(entry.generatedAt)) || !passesFilters(entry)) continue;
    freeze(key, entry, {
      registeredAtFreeze: Object.hasOwn(live, key),
      statusAtFreeze: entry.status,
      ...(isDuplicateWindow(entry) && { duplicateOf: entry.duplicateOf }),
    });
  }

  // Emission accounting, with the resolver's own emission list and window
  // index, so it cannot drift from ingest.
  const windows = indexQuestionWindows(projected);
  const emissions = { total: 0, inCohortWindow: 0, joinedPreCohortWindow: 0, filteredOut: 0, skipped: {}, unregistered: {} };
  // Gap reasons are the resolver's registration vocabulary (#7072).
  const bump = (bucket, reason) => {
    if (!REGISTRATION_GAP_REASONS.includes(reason)) throw new Error(`unknown registration gap reason ${reason}`);
    bucket[reason] = (bucket[reason] || 0) + 1;
  };
  const unregisteredWindows = new Map();
  const freezeUnregistered = (key, entry, reason) => {
    freeze(key, entry, { registeredAtFreeze: false, statusAtFreeze: 'unregistered', unregisteredReason: reason });
    bump(emissions.unregistered, reason);
  };

  const skipped = (reason, forecast, generatedAt) => {
    if (!forecast?.id || !inRange(generatedAt)) return;
    emissions.total += 1;
    bump(emissions.skipped, reason);
  };
  for (const emission of collectHistoryEmissions(snapshots, nowMs, skipped)) {
    const { forecast, id, deadline, generatedAt, snapshotAt } = emission;
    if (!inRange(generatedAt)) continue;
    emissions.total += 1;
    const candidate = emissionCandidate(emission);
    const questionKey = windowQuestionKey(candidate);
    let parentKey = windows.covering(id, { entry: candidate, questionKey }, generatedAt);
    if (parentKey && !entries.has(parentKey)) {
      if (Number(projected[parentKey].generatedAt) < startMs) emissions.joinedPreCohortWindow += 1;
      else emissions.filteredOut += 1;
      continue;
    }
    if (!parentKey) {
      // Ingest opens no window for a bet on the base-rate placeholder (#8990).
      if (isPlaceholderBet(candidate)) { bump(emissions.skipped, 'base_rate_placeholder'); continue; }
      if (!passesFilters(candidate)) { emissions.filteredOut += 1; continue; }
      const group = `${id}\u0000${questionKey}`;
      const open = (unregisteredWindows.get(group) || []).find((window) => generatedAt < window.deadline);
      if (open) {
        parentKey = open.key;
      } else {
        const plain = `${id}@${deadline}`;
        parentKey = projected[plain] || entries.has(plain)
          ? `${plain}~${createHash('sha256').update(questionKey).digest('hex').slice(0, 12)}`
          : plain;
        freezeUnregistered(parentKey, { ...candidate, key: parentKey }, registrationGapReason(deadline, snapshotAt, nowMs));
        unregisteredWindows.set(group, [...(unregisteredWindows.get(group) || []), { key: parentKey, deadline }]);
      }
    }
    emissions.inCohortWindow += 1;
    for (const horizon of scoredHorizonKeys(forecast)) {
      const key = `${parentKey}@${horizon}`;
      if (projected[key] || entries.has(key)) continue;
      const spec = forecast.horizonResolutions[horizon];
      const horizonEntry = { ...candidate, spec, deadline: Number(spec.deadline), parentKey, key };
      delete horizonEntry.sla;
      delete horizonEntry.emissionHash;
      freezeUnregistered(key, horizonEntry, registrationGapReason(Number(spec.deadline), snapshotAt, nowMs));
    }
  }

  const frozen = [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
  const historyTimes = historySnapshots.map((snapshot) => Number(snapshot?.generatedAt)).filter(Number.isFinite);
  const manifest = {
    schemaVersion: COHORT_SCHEMA_VERSION,
    cohortId,
    note,
    frozenAt: new Date(nowMs).toISOString(),
    window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), field: 'generatedAt', endExclusive: true },
    filters: { origins: originSet ? [...originSet].sort() : null, domains: domainSet ? [...domainSet].sort() : null },
    sla: { perEntry: true, judgedGraceMs: JUDGED_EVIDENCE_GRACE_MS, resolverCycleMs: RESOLVER_CYCLE_MS },
    sources: {
      ...sources,
      historySnapshots: historySnapshots.length,
      historyFrom: new Date(Math.min(...historyTimes)).toISOString(),
      historyTo: new Date(Math.max(...historyTimes)).toISOString(),
      betsSnapshots: betsSnapshots.length,
      traceRuns: traceRuns.length,
      ...(priorManifest && { priorManifest: priorManifest.cohortId }),
    },
    counts: {
      entries: frozen.length,
      registeredAtFreeze: frozen.filter((entry) => entry.registeredAtFreeze).length,
      publishedOrigin: frozen.filter((entry) => entry.publishedOrigin).length,
      byLane: countBy(frozen, 'lane'),
      byOrigin: countBy(frozen, 'origin'),
      byDomain: countBy(frozen, 'domain'),
      byCodeVersion: countBy(frozen, 'codeVersion'),
      codeVersionSource: countBy(frozen, 'codeVersionSource'),
      slaSource: countBy(frozen.map((entry) => ({ source: entry.sla.source })), 'source'),
      emissions,
    },
    entries: frozen,
  };
  return { ...manifest, manifestSha256: hashCohortManifest(manifest) };
}

// The frozen service level, applied to the deadline the ledger holds now (a
// market-settlement window's deadline follows the venue).
function dueAtFor(frozen, deadline) {
  return slaDueAt({ deadline, sla: frozen.sla }, frozen.sla?.lane === 'judged' ? 'judged' : 'hard');
}

function classifyEntry(frozen, entry, nowMs, ledgerWrittenAt) {
  if (!entry) {
    const dueAt = dueAtFor(frozen, frozen.deadline);
    const hadChance = (Number.isFinite(ledgerWrittenAt) && ledgerWrittenAt >= frozen.firstSeenAt + RESOLVER_CYCLE_MS)
      || !(nowMs <= dueAt);
    return {
      class: hadChance ? 'missing_from_ledger' : 'awaiting_registration',
      lane: frozen.lane,
      deadline: frozen.deadline,
      dueAt,
      matured: !(frozen.deadline > nowMs),
    };
  }
  const lane = cohortLane(entry);
  const deadline = Number(entry.deadline ?? entry.spec?.deadline);
  const dueAt = dueAtFor(frozen, deadline);
  const base = { lane, deadline, dueAt, ...(deadline !== frozen.deadline && { frozenDeadline: frozen.deadline }) };
  if (entry.status === 'resolved') {
    const resolvedAt = Number(entry.resolvedAt);
    const outcome = entry.outcome || 'unknown';
    const terminal = {
      ...base,
      matured: true,
      resolvedAt,
      outcome,
      ...(outcome === 'VOID' && { voidReason: entry.evidence?.reason || 'unknown' }),
    };
    if (!Number.isFinite(dueAt) || !Number.isFinite(resolvedAt)) return { ...terminal, class: 'sla_unmeasurable' };
    return { ...terminal, class: resolvedAt <= dueAt ? 'terminal_in_sla' : 'terminal_late' };
  }
  if (!Number.isFinite(deadline)) return { ...base, matured: false, status: entry.status, class: 'sla_unmeasurable' };
  if (deadline > nowMs) return { ...base, matured: false, status: entry.status, class: 'immature' };
  return { ...base, matured: true, status: entry.status, class: nowMs > dueAt ? 'pending_breach' : 'pending_in_sla' };
}

function emptyTally() {
  return Object.fromEntries([...COHORT_CLASSES.map((name) => [name, 0]), ['entries', 0], ['matured', 0], ['scored', 0], ['void', 0]]);
}

function tally(row, result) {
  row.entries += 1;
  row[result.class] += 1;
  if (result.matured) row.matured += 1;
  if (result.outcome === 'YES' || result.outcome === 'NO') row.scored += 1;
  if (result.outcome === 'VOID') row.void += 1;
}

function breachCountOf(row) {
  return row.terminal_late + row.pending_breach + row.missing_from_ledger + row.sla_unmeasurable;
}

function verdictOf(row) {
  if (breachCountOf(row)) return 'breached';
  return row.immature || row.pending_in_sla || row.awaiting_registration ? 'open' : 'met';
}

function verifyManifest(manifest) {
  if (manifest?.schemaVersion !== COHORT_SCHEMA_VERSION) throw new Error(`unsupported cohort schemaVersion ${manifest?.schemaVersion}`);
  if (hashCohortManifest(manifest) !== manifest.manifestSha256) throw new Error(`cohort ${manifest.cohortId}: manifest does not match manifestSha256`);
}

/**
 * Walk every frozen entry and classify it against the ledger at nowMs. The
 * service level is the one each entry recorded when it was frozen. The verdict covers published-origin
 * entries, the population the epic's acceptance names; shadow and synthetic
 * origins are reported beside it.
 */
export function reconcileCohort(manifest, ledger, nowMs) {
  verifyManifest(manifest);
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const live = ledgerMap(ledger);
  const ledgerWrittenAt = Number(unwrapEnvelope(ledger)._seed?.fetchedAt);

  const totals = emptyTally();
  const published = emptyTally();
  const unpublished = emptyTally();
  const byLane = {};
  const byOrigin = {};
  const byCodeVersion = {};
  const voidByReason = {};
  const breaches = [];
  for (const frozen of entries) {
    const entry = Object.hasOwn(live, frozen.key) ? live[frozen.key] : null;
    const result = classifyEntry(frozen, entry, nowMs, ledgerWrittenAt);
    tally(totals, result);
    tally(frozen.publishedOrigin ? published : unpublished, result);
    tally(byLane[result.lane] ||= emptyTally(), result);
    tally(byOrigin[frozen.origin] ||= emptyTally(), result);
    tally(byCodeVersion[frozen.codeVersion || 'unknown'] ||= emptyTally(), result);
    if (result.voidReason) voidByReason[result.voidReason] = (voidByReason[result.voidReason] || 0) + 1;
    if (BREACH_CLASSES.has(result.class)) {
      breaches.push({
        key: frozen.key,
        class: result.class,
        lane: result.lane,
        origin: frozen.origin,
        publishedOrigin: Boolean(frozen.publishedOrigin),
        domain: frozen.domain,
        deadline: isoOrNull(result.deadline),
        dueAt: isoOrNull(result.dueAt),
        ...(result.resolvedAt != null && { resolvedAt: isoOrNull(result.resolvedAt) }),
        ...(result.outcome && { outcome: result.outcome }),
        ...(result.voidReason && { voidReason: result.voidReason }),
        ...(result.status && { status: result.status }),
      });
    }
  }
  breaches.sort((a, b) => Number(b.publishedOrigin) - Number(a.publishedOrigin) || a.class.localeCompare(b.class) || a.key.localeCompare(b.key));
  return {
    cohortId: manifest.cohortId,
    reconciledAt: new Date(nowMs).toISOString(),
    ledgerWrittenAt: isoOrNull(ledgerWrittenAt),
    window: manifest.window,
    // The epic's acceptance reading, over published-origin entries: every
    // matured entry is terminal within the SLA or listed in `breaches`.
    slaVerdict: verdictOf(published),
    breachCount: breachCountOf(published),
    unpublishedVerdict: verdictOf(unpublished),
    unpublishedBreachCount: breachCountOf(unpublished),
    published,
    unpublished,
    totals,
    voidByReason: Object.fromEntries(Object.entries(voidByReason).sort(([a, x], [b, y]) => y - x || a.localeCompare(b))),
    byLane: sortKeys(byLane),
    byOrigin: sortKeys(byOrigin),
    byCodeVersion: sortKeys(byCodeVersion),
    breaches,
  };
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const CLASS_LABELS = {
  immature: 'Immature (deadline ahead)',
  pending_in_sla: 'Pending, inside SLA',
  pending_breach: 'Pending past SLA (breach)',
  terminal_in_sla: 'Terminal within SLA',
  terminal_late: 'Terminal late (breach)',
  sla_unmeasurable: 'SLA unmeasurable (breach)',
  awaiting_registration: 'Awaiting registration',
  missing_from_ledger: 'Missing from ledger (breach)',
};

export function formatReconciliationMarkdown(report, { maxBreaches = 50 } = {}) {
  const columns = [['Published', report.published], ['Shadow and synthetic', report.unpublished],
    ...Object.entries(report.byLane).map(([lane, row]) => [`${lane} (all)`, row])];
  const header = `| Class | ${columns.map(([name]) => name).join(' | ')} | All |`;
  const rule = `|---|${columns.map(() => '---:').join('|')}|---:|`;
  const line = (label, name) => `| ${label} | ${columns.map(([, row]) => row[name]).join(' | ')} | ${report.totals[name]} |`;
  const rows = [...COHORT_CLASSES.map((name) => line(CLASS_LABELS[name], name)),
    ...['entries', 'matured', 'scored', 'void'].map((name) => line(name, name))];
  const group = (object) => Object.entries(object)
    .map(([name, row]) => `| ${name} | ${row.entries} | ${row.matured} | ${row.terminal_in_sla} | ${breachCountOf(row)} |`);
  const versions = Object.entries(report.byCodeVersion)
    .map(([sha, row]) => `| \`${sha.slice(0, 10)}\` | ${row.entries} | ${row.matured} | ${row.terminal_in_sla} | ${breachCountOf(row)} |`);
  const voids = Object.entries(report.voidByReason).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none';
  const shown = report.breaches.slice(0, maxBreaches)
    .map((row) => `| \`${row.key}\` | ${row.publishedOrigin ? 'yes' : 'no'} | ${row.class} | ${row.lane} | ${row.deadline ?? ''} | ${row.dueAt ?? ''} | ${row.resolvedAt ?? row.status ?? ''} |`);
  return [
    `Cohort \`${report.cohortId}\`, emissions ${report.window.start} to ${report.window.end}, reconciled ${report.reconciledAt} against the ledger written ${report.ledgerWrittenAt ?? 'at an unknown time'}.`,
    'SLA: each entry\'s own level, frozen from the ledger row\'s stamp or its spec (hardSlaMs; judged windows after the 18 h grace).',
    '',
    header, rule, ...rows,
    '',
    `VOID by reason: ${voids}.`,
    `SLA verdict (published origin): ${report.slaVerdict}, ${report.breachCount} breaches. Shadow and synthetic: ${report.unpublishedVerdict}, ${report.unpublishedBreachCount} breaches. Open means some entries are not yet due.`,
    '',
    '| Code version | Entries | Matured | Terminal in SLA | Breaches |',
    '|---|---:|---:|---:|---:|',
    ...versions,
    '',
    '| Origin | Entries | Matured | Terminal in SLA | Breaches |',
    '|---|---:|---:|---:|---:|',
    ...group(report.byOrigin),
    '',
    report.breaches.length
      ? [`Breaches (${report.breaches.length}${report.breaches.length > maxBreaches ? `, first ${maxBreaches}` : ''}):`, '', '| Key | Published | Class | Lane | Deadline | SLA due | Resolved / status |', '|---|---|---|---|---|---|---|', ...shown].join('\n')
      : 'Breaches: none.',
  ].join('\n');
}
