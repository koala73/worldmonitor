#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_HEALTH_URL = 'https://api.worldmonitor.app/api/health?compact=1';
const BASELINE_URL = new URL('./seed-freshness-baseline.json', import.meta.url);
// api/health.js only serves a cached verdict for 60 seconds. Allow its maximum
// 20-second request timeout too, so a valid snapshot cannot be rejected solely
// because the response arrived at the end of the monitor's fetch window.
export const MAX_HEALTH_OBSERVATION_AGE_MS = 80 * 1000;

export function validateCompactHealthPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Compact health payload must be an object');
  }
  // Compact health omits `problems` entirely when every check is healthy.
  if (payload.problems == null && payload.status === 'HEALTHY') return payload;
  if (!payload.problems || typeof payload.problems !== 'object' || Array.isArray(payload.problems)) {
    throw new Error('Compact health payload must contain a problems object');
  }
  return payload;
}

// The ONLY states being on-demand actually explains: nothing has requested the
// key yet, or the producer has not run for the first time. Absence is expected
// for an RPC-populated cache or a deployment-order bridge, so it must not page.
//
// Everything else must stay strict even for an on-demand source. `SEED_ERROR`
// means the producer ran and failed; a long `STALE_SEED` means it stopped
// running. Neither is explained by "nobody asked for it yet", and softening
// them is a known-bad trade: api/health.js's ON_DEMAND_KEYS policy block
// records `marketImplications` sitting at 8.2x its staleness budget for 16+
// hours undetected for exactly this reason, which is why that key was removed
// from the set. Do not widen this list to cover fault statuses — a genuinely
// accepted degradation belongs in seed-freshness-baseline.json, where it
// carries an owner issue and an expiry.
const ON_DEMAND_SOFT_STATUSES = new Set(['EMPTY_ON_DEMAND', 'EMPTY', 'EMPTY_DATA']);

// `/api/health` marks on-demand sources with `onDemand: true` on every status
// (api/health.js classifyKey). The status-suffix test is retained as a fallback
// for compact snapshots cached before that marker shipped, and is self-limiting:
// `EMPTY_ON_DEMAND` is the only `_ON_DEMAND` status, so it covers only the
// absent/zero-record branches — the same set the marker path allows.
export function isOnDemandProblem(problem) {
  if (typeof problem?.status === 'string' && problem.status.endsWith('_ON_DEMAND')) return true;
  return problem?.onDemand === true && ON_DEMAND_SOFT_STATUSES.has(problem?.status);
}

// #6059 — a schema whose producer has not reached its first scheduled run yet.
// Softened for the SAME reason as on-demand (absence is explained, not a
// fault), but on strictly tighter terms: /api/health emits the deadline it
// compiled into the payload, and this gate re-checks it against the wall clock
// rather than trusting the status string. So it fails CLOSED three ways —
// a missing/unparseable deadline, an already-expired one, and a compact
// snapshot cached from before the deadline all report the problem normally.
// That is why this does not need a baseline entry with an owner and expiry:
// the expiry is in the payload and this function enforces it.
// One complete daily scrape/aggregate/publish window, the longest rollout the
// health registry is allowed to declare. Bounding it HERE too is deliberate
// defence in depth: this gate consumes a payload over the network, so it must
// not accept an arbitrarily distant deadline as a licence to stay quiet. Without
// this, a single bad `rolloutPendingUntil` — a registry bug, a bad merge, a
// tampered response — would silence these keys in CI effectively forever.
export const MAX_ROLLOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isRolloutPendingProblem(problem, now = Date.now()) {
  if (problem?.status !== 'ROLLOUT_PENDING') return false;
  const until = Date.parse(problem?.rolloutPendingUntil ?? '');
  if (!Number.isFinite(until)) return false;
  if (until - now > MAX_ROLLOUT_WINDOW_MS) return false;
  return now < until;
}

export function findOperationalProblems(payload, now = Date.now()) {
  validateCompactHealthPayload(payload);
  return Object.entries(payload.problems ?? {})
    .filter(([, problem]) => !isOnDemandProblem(problem) && !isRolloutPendingProblem(problem, now))
    .map(([name, problem]) => ({
      name,
      status: problem?.status ?? 'UNKNOWN',
      records: problem?.records,
      ...(Number.isFinite(problem?.seedAgeMin)
        ? { seedAgeMin: problem.seedAgeMin }
        : {}),
      ...(Number.isFinite(problem?.maxStaleMin)
        ? { maxStaleMin: problem.maxStaleMin }
        : {}),
      // The content clock, carried so the report can name the pair that
      // actually fired. Without these a STALE_CONTENT line could only print
      // the SEED pair, which is by definition inside budget for that status —
      // the reader sees `age=1200m max=5760m` on a problem row and reasonably
      // concludes the monitor is broken.
      ...(Number.isFinite(problem?.contentAgeMin)
        ? { contentAgeMin: problem.contentAgeMin }
        : {}),
      ...(Number.isFinite(problem?.maxContentAgeMin)
        ? { maxContentAgeMin: problem.maxContentAgeMin }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return true for a real ISO calendar instant with an explicit Z or numeric timezone.
 * Date.parse alone is insufficient because it normalizes impossible dates such as February 30.
 */
export function isUtcIsoInstant(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (
    zone !== 'Z'
    && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)
  ) return false;
  return Number.isFinite(Date.parse(value));
}

export function validateAcceptanceBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('Acceptance baseline must be an object');
  }
  if (typeof baseline.expiresAt !== 'string' || Number.isNaN(Date.parse(baseline.expiresAt))) {
    throw new Error('Acceptance baseline must carry an ISO expiresAt date');
  }
  if (!Array.isArray(baseline.acknowledged)) {
    throw new Error('Acceptance baseline must contain an acknowledged array');
  }
  const seen = new Set();
  for (const entry of baseline.acknowledged) {
    if (!entry?.name || !entry?.status) {
      throw new Error('Each acknowledged baseline entry needs name and status');
    }
    const key = `${entry.name}:${entry.status}`;
    if (seen.has(key)) {
      throw new Error(`Acceptance baseline contains duplicate entry ${key}`);
    }
    seen.add(key);
    if (!Number.isInteger(entry.issue)) {
      throw new Error(`Acknowledged baseline entry ${entry.name} needs an owner issue number`);
    }
    if (
      Object.hasOwn(entry, 'expiresAt')
      && !isUtcIsoInstant(entry.expiresAt)
    ) {
      throw new Error(`Acknowledged baseline entry ${entry.name} needs a valid UTC ISO expiresAt instant`);
    }
    // Optional rejection cohort: when present it must be a non-empty list of
    // non-empty strings, or the cohort guard in applyAcceptanceBaseline would
    // silently scope the acknowledgment to nothing.
    if (Object.hasOwn(entry, 'rejectedShas')
      && (!Array.isArray(entry.rejectedShas)
        || entry.rejectedShas.length === 0
        || entry.rejectedShas.some((sha) => typeof sha !== 'string' || sha.length === 0))) {
      throw new Error(`Acknowledged baseline entry ${entry.name} needs rejectedShas to be a non-empty array of commit SHAs`);
    }
    if (Object.hasOwn(entry, 'cutover')) {
      if (!entry.cutover || typeof entry.cutover !== 'object' || Array.isArray(entry.cutover)) {
        throw new Error(`Acknowledged baseline entry ${entry.name} needs a cutover object`);
      }
      if (typeof entry.expiresAt !== 'string') {
        throw new Error(`Cutover acknowledgement ${entry.name} needs an entry-level expiresAt`);
      }
      if (typeof entry.cutover.probeKey !== 'string' || entry.cutover.probeKey.length === 0) {
        throw new Error(`Cutover acknowledgement ${entry.name} needs a probeKey`);
      }
      if (!isUtcIsoInstant(entry.cutover.activatedAt)) {
        throw new Error(`Cutover acknowledgement ${entry.name} needs a valid UTC ISO activatedAt instant`);
      }
      if (!isUtcIsoInstant(entry.cutover.firstScheduledRunAt)) {
        throw new Error(`Cutover acknowledgement ${entry.name} needs a valid UTC ISO firstScheduledRunAt instant`);
      }
      const activatedAt = Date.parse(entry.cutover.activatedAt);
      const firstScheduledRunAt = Date.parse(entry.cutover.firstScheduledRunAt);
      const expiresAt = Date.parse(entry.expiresAt);
      if (firstScheduledRunAt <= activatedAt) {
        throw new Error(`Cutover acknowledgement ${entry.name} first scheduled run must follow activation`);
      }
      if (firstScheduledRunAt - activatedAt > MAX_ROLLOUT_WINDOW_MS) {
        throw new Error(`Cutover acknowledgement ${entry.name} first scheduled run must be within 24 hours`);
      }
      if (expiresAt <= activatedAt) {
        throw new Error(`Cutover acknowledgement ${entry.name} must expire after activation`);
      }
      if (expiresAt > firstScheduledRunAt) {
        throw new Error(`Cutover acknowledgement ${entry.name} must expire by its first scheduled run`);
      }
    }
  }
  return baseline;
}

/**
 * Split live problems against the acknowledged baseline.
 *
 * `blocking` fails the gate. `acknowledged` is a known-degraded source with an
 * owner issue, reported but not fatal. `cleared` is a baseline entry that no
 * longer appears in health at all — reported as a prompt to prune, but
 * deliberately NOT fatal, because several of these sources flap between polls
 * and a clear-on-recovery failure would make the monitor red on exactly the
 * runs that prove things improved. The root `expiresAt` is the baseline-wide
 * anti-rot mechanism: the whole baseline must be re-reviewed on a date, or the
 * gate fails. An entry may carry its own tighter `expiresAt`; its exact live
 * problem returns to `blocking` at that instant without expiring other entries.
 *
 * The expiry governs SUPPRESSIONS, so a baseline that acknowledges nothing
 * cannot expire — there is no suppression left to outlive its cause, and a
 * date-triggered failure over an empty list is a red monitor with nothing to
 * review. That case is reachable: pruning the last recovered entry empties the
 * file, and this repository has already watched a permanently-red monitor hide
 * live drift (#6087).
 *
 * `escalated` is the third case, and it exists because the other two are not
 * exhaustive. Acknowledgment is keyed on `name:status`, so a source that gets
 * WORSE stops matching its entry exactly like one that recovers — and folding
 * both into `cleared` told the operator to delete a suppression for a source
 * that is still broken, in the same run that failed the gate on its new status.
 * #6263 made that reachable fleet-wide: a faulting key whose data key also
 * expires now moves SEED_ERROR -> EMPTY. The worse status still lands in
 * `blocking` (an escalation is never suppressed); this bucket only stops the
 * report from calling it a recovery.
 */
export function applyAcceptanceBaseline(problems, baseline, now = Date.now()) {
  validateAcceptanceBaseline(baseline);
  const accepted = new Map(
    baseline.acknowledged.map((entry) => [`${entry.name}:${entry.status}`, entry]),
  );
  const observedByName = new Map(problems.map((problem) => [problem.name, problem.status]));
  const seen = new Set();
  const blocking = [];
  const acknowledged = [];
  for (const problem of problems) {
    const key = `${problem.name}:${problem.status}`;
    const entry = accepted.get(key);
    if (entry) {
      seen.add(key);
      // An entry may scope its acknowledgment to an explicit rejection cohort
      // (entry.rejectedShas). A problem carrying any SHA outside that cohort
      // is NEW information wearing the acknowledged name:status — the exact
      // shape a recovered service's next, unrelated rejection takes — and must
      // block (#6483 cross-model review, verified by execution). Additive:
      // callers whose problems or entries carry no rejectedShas are unchanged.
      const novelRejections = Array.isArray(entry.rejectedShas) && Array.isArray(problem.rejectedShas)
        ? problem.rejectedShas.filter((sha) => !entry.rejectedShas.includes(sha))
        : [];
      if (novelRejections.length > 0) {
        blocking.push({ ...problem, novelRejections, issue: entry.issue });
      } else if (!Object.hasOwn(entry, 'expiresAt') || now < Date.parse(entry.expiresAt)) {
        acknowledged.push({ ...problem, issue: entry.issue });
      } else {
        // Carry the expired entry's identity so the report can attribute the
        // red line to a scheduled re-page instead of a fresh outage.
        blocking.push({ ...problem, expiredEntry: entry.expiresAt, issue: entry.issue });
      }
    } else {
      blocking.push(problem);
    }
  }
  const unmatched = baseline.acknowledged.filter((entry) => !seen.has(`${entry.name}:${entry.status}`));
  const cleared = unmatched
    .filter((entry) => !observedByName.has(entry.name))
    .map((entry) => ({ name: entry.name, status: entry.status, issue: entry.issue }));
  const escalated = unmatched
    .filter((entry) => observedByName.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      status: entry.status,
      observedStatus: observedByName.get(entry.name),
      issue: entry.issue,
    }));
  const expired = baseline.acknowledged.length > 0 && Date.parse(baseline.expiresAt) < now;
  return { blocking, acknowledged, cleared, escalated, expired, expiresAt: baseline.expiresAt };
}

function readAcceptanceBaseline() {
  return JSON.parse(readFileSync(BASELINE_URL, 'utf8'));
}

/**
 * Health decides STALE_CONTENT on a different clock from STALE_SEED, and this
 * line has to print the one that actually fired.
 *
 *   seed     seedAgeMin vs maxStaleMin         "is the seeder running"  -> STALE_SEED
 *   content  contentAgeMin vs maxContentAgeMin "is the data advancing"  -> STALE_CONTENT
 *
 * This printed the seed pair unconditionally, so every STALE_CONTENT line read
 * as a contradiction: euFsi showed `age=1200m max=5760m` — comfortably inside
 * budget — while the breach was contentAgeMin 19230 against maxContentAgeMin
 * 14400. A reader can only conclude the monitor is wrong.
 *
 * The seed pair is by definition INSIDE budget on a STALE_CONTENT row, so it is
 * never the reason and must never be printed as though it were. That holds even
 * when the content numbers are missing, which happens two different ways:
 *
 *   contentAgeMin === null   health fail-closes on an unreadable content clock,
 *                            so the source is stale because nothing in the
 *                            payload carries a date (jodiGas).
 *   no content fields at all health also reaches STALE_CONTENT via
 *                            requireContentFreshness — a per-country verdict
 *                            (portwatchPortActivity). That detail names WHICH
 *                            country is stale, so api/health.js strips it from
 *                            the public compact shape (#6060) that this monitor
 *                            reads. The numbers are operator-only by design and
 *                            are not coming; say so and point at where they live.
 */
function describeProblem(problem) {
  const seedClock = Number.isFinite(problem.seedAgeMin)
    ? ` age=${problem.seedAgeMin}m max=${problem.maxStaleMin ?? 'unknown'}m`
    : '';

  if (problem.status !== 'STALE_CONTENT') {
    return `${problem.name}: status=${problem.status} records=${problem.records ?? 'unknown'}${seedClock}`;
  }

  // Marked `ok` so the healthy clock is never mistaken for the failing one.
  const seedAside = Number.isFinite(problem.seedAgeMin)
    ? ` (seed age=${problem.seedAgeMin}m ok)`
    : '';
  const contentClock = Number.isFinite(problem.maxContentAgeMin)
    ? ` contentAge=${Number.isFinite(problem.contentAgeMin)
      ? `${problem.contentAgeMin}m`
      : 'unknown (no dated item; scored stale)'} maxContentAge=${problem.maxContentAgeMin}m`
    : ' contentAge=operator-only (per-country freshness; see detailed /api/health)';

  return `${problem.name}: status=${problem.status} records=${problem.records ?? 'unknown'}${contentClock}${seedAside}`;
}

/**
 * Pure renderer for one acceptance run. Kept separate from main() so the
 * ORDER of the report is testable without a network round trip — the bug this
 * shape closes was an early `return` on expiry that suppressed the blocking
 * list, and no assertion over the pure split functions could have seen it.
 */
export function formatAcceptanceReport(
  { blocking, acknowledged, cleared, escalated = [], expired, expiresAt },
  checkedAt,
) {
  const info = [
    ...acknowledged.map((problem) => `- acknowledged (#${problem.issue}): ${describeProblem(problem)}`),
    // Deliberately carries NO pruning advice. The suppression is still live —
    // its source got worse, not better — and the new status is already in
    // `blocking` above. Telling an operator to delete the entry here would
    // retire the owner record for an active fault.
    ...escalated.map((entry) =>
      `- escalated (#${entry.issue}): ${entry.name} ${entry.status} -> ${entry.observedStatus}; the baselined status is no longer what this source reports. Re-review the suppression against the worse state before changing it.`),
    ...cleared.map((entry) =>
      `- recovered: ${entry.name}:${entry.status} no longer reported; remove it from scripts/seed-freshness-baseline.json (#${entry.issue}).`),
  ];
  const errors = [];

  // The actionable list comes BEFORE any terminal condition. Expiry is the run
  // where an operator most needs to see what is actually broken.
  if (blocking.length > 0) {
    errors.push(`Ingestion operational acceptance failed: ${blocking.length} unacknowledged problem(s).`);
    errors.push(...blocking.map((problem) => `- ${describeProblem(problem)}`));
  }
  if (expired) {
    errors.push(
      `Ingestion operational acceptance failed: the accepted-problem baseline expired on ${expiresAt}. Re-review scripts/seed-freshness-baseline.json and set a new expiresAt.`,
    );
  }
  if (errors.length === 0) {
    info.push(
      `Ingestion operational acceptance passed at ${checkedAt || 'unknown time'}: no unacknowledged health problems (${acknowledged.length} acknowledged).`,
    );
  }
  return { info, errors, failed: errors.length > 0 };
}

export function normalizeCheckedAt(checkedAt, now = Date.now()) {
  if (!isUtcIsoInstant(checkedAt)) {
    throw new Error('Compact health payload checkedAt must be a valid UTC ISO instant');
  }
  const checkedAtMs = Date.parse(checkedAt);
  const ageMs = now - checkedAtMs;
  if (ageMs < 0 || ageMs > MAX_HEALTH_OBSERVATION_AGE_MS) {
    throw new Error('Compact health payload checkedAt is outside the accepted observation window');
  }
  return new Date(checkedAtMs).toISOString();
}

/**
 * One machine-readable observation, built from the exact same fail-closed split
 * and report as the human log. The workflow status publisher consumes this;
 * keeping it here prevents the text and machine verdicts from drifting apart.
 */
export function buildAcceptanceObservation(payload, baseline, now = Date.now()) {
  const checkedAt = normalizeCheckedAt(payload?.checkedAt, now);
  const acceptance = applyAcceptanceBaseline(findOperationalProblems(payload, now), baseline, now);
  return {
    version: 1,
    checkedAt,
    acceptance,
    report: formatAcceptanceReport(acceptance, checkedAt),
  };
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { 'json-output': { type: 'string' } },
    strict: true,
  });
  const healthUrl = process.env.HEALTH_URL || DEFAULT_HEALTH_URL;
  const response = await fetch(healthUrl, {
    headers: { 'User-Agent': 'worldmonitor-seed-freshness-monitor/1.0' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Compact health request failed: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const observation = buildAcceptanceObservation(payload, readAcceptanceBaseline());
  const outputPath = values['json-output'];
  if (outputPath) writeFileSync(outputPath, `${JSON.stringify(observation, null, 2)}\n`);
  const { report } = observation;
  for (const line of report.info) console.log(line);
  for (const line of report.errors) console.error(line);
  if (report.failed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
