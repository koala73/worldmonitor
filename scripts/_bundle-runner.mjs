#!/usr/bin/env node
/**
 * Bundle orchestrator: spawns multiple seed scripts sequentially via
 * child_process.spawn, with line-streamed stdio, SIGTERM→SIGKILL escalation on
 * timeout, and freshness-gated skipping. Streaming matters because a hanging
 * section would otherwise buffer its logs until exit and look like a silent
 * container crash (see PR that replaced execFile).
 *
 * Usage from a bundle script:
 *   import { runBundle } from './_bundle-runner.mjs';
 *   await runBundle('ecb-eu', [ { label, script, seedMetaKey, freshnessMetaKey, completionMetaKey, intervalMs, timeoutMs } ]);
 *
 * Budget (opt-in): Railway cron services SIGKILL the container at 10min. If
 * the sum of timeoutMs for sections that happen to be due exceeds ~9min, we
 * risk losing the in-flight section's logs AND marking the job as crashed.
 * Callers on Railway cron can pass `{ maxBundleMs }` to enforce a wall-time
 * budget — sections whose worst-case timeout wouldn't fit in the remaining
 * budget are deferred to the next tick. Default is Infinity (no budget) so
 * existing bundles whose individual sections already exceed 9min (e.g.
 * 600_000-1 timeouts in imf-extended, energy-sources) are not silently
 * broken by adopting the runner.
 *
 * Deferral is only ever meant to shed load under pressure, so two guards keep
 * it from turning into a silent outage (#6556, where seed-bundle-resilience
 * deferred all three sections on every tick and exited 0 for six hours):
 *   1. A section whose worst case does not fit the WHOLE budget can never be
 *      admitted on any tick. That is a static config error, not pressure, so
 *      runBundle throws before spawning anything.
 *   2. A tick that admitted work yet completed none of it while deferring a
 *      due section exits non-zero. `ran:0 deferred:>0` is otherwise
 *      indistinguishable from a healthy no-op in Railway's badge.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_COMPLETION_META_KEY_ENV,
  GRACEFUL_FETCH_FAILURE_EXIT_CODE,
  loadEnvFile,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 604_800_000;
// 7d TTL outlives the 48h (2× daily) static-ref health gate so a late tick
// reports STALE_SEED while the heartbeat is still readable, not EMPTY.
export const BUNDLE_HEARTBEAT_TTL_SECONDS = 7 * 24 * 60 * 60;

export function bundleHeartbeatKey(label) {
  return `bundle:heartbeat:${label}`;
}

loadEnvFile(import.meta.url);

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Per-read bound on the freshness gate's Redis lookups. Exported because the
// admission headroom below is derived from it: those reads run BEFORE a section
// can be admitted, so they are budget the section will never get.
export const REDIS_READ_TIMEOUT_MS = 5_000;

async function readRedisKey(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const resp = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(REDIS_READ_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    return body.result ? JSON.parse(body.result) : null;
  } catch {
    return null;
  }
}

/**
 * Record that the scheduler actually started this container.
 *
 * Member seed-meta only advances when a section runs. Daily crons with
 * weekly/monthly members therefore look healthy across many missed ticks
 * (#6691). This heartbeat is written on every tick, including skip-all.
 * Missing Redis must not crash the bundle — writeSeedMeta exits(1).
 */
async function writeBundleHeartbeat(label) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const fetchedAt = Date.now();
  const meta = { fetchedAt, recordCount: 1, lastBundleRunAt: fetchedAt };
  try {
    const resp = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-bundle-runner/1.0',
      },
      body: JSON.stringify([
        'SET',
        bundleHeartbeatKey(label),
        JSON.stringify(meta),
        'EX',
        BUNDLE_HEARTBEAT_TTL_SECONDS,
      ]),
      signal: AbortSignal.timeout(REDIS_READ_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[Bundle:${label}] tick heartbeat write failed: HTTP ${resp.status}`);
      return false;
    }
    const body = await resp.json().catch(() => null);
    if (!body || typeof body !== 'object' || body.result !== 'OK') {
      const detail = body && typeof body === 'object' && body.error ? body.error : 'missing OK result';
      console.warn(`[Bundle:${label}] tick heartbeat write failed: ${detail}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[Bundle:${label}] tick heartbeat write failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Read section freshness for the interval gate.
 *
 * Returns `{ fetchedAt }` or null. A declared `freshnessMetaKey` is authoritative
 * for sources whose canonical envelope may be republished from retained
 * last-good data. When `completionMetaKey` is also declared, its timestamp must
 * be at or after source transport success; an older completion belongs to a
 * prior run and cannot attest a newer pre-publication heartbeat. Otherwise
 * prefer envelope-form data when `canonicalKey` is declared, then fall back to
 * the legacy `seed-meta:<key>` read.
 *
 * `completionMetaKey` applies the same rule to the canonical clock (#6960).
 * The bundle passes a dedicated marker key to runSeed, which writes it only
 * after the canonical envelope, every extra key, post-publish hooks, and
 * freshness bookkeeping finish. Its fetchedAt must equal the canonical
 * envelope timestamp, binding the proof to one exact run.
 *
 * Only sections that declare it are affected. Most canonical-clock members
 * publish no seed-meta at all, and requiring an attestation from them would
 * mark them due on every tick — the #6806 failure this must not reintroduce.
 */
export async function readSectionFreshness(section, readKey = readRedisKey) {
  if (section.freshnessMetaKey) {
    if (section.requireCanonical && section.canonicalKey) {
      const canonical = await readKey(section.canonicalKey);
      if (!unwrapEnvelope(canonical)._seed?.fetchedAt) return null;
    }
    const raw = await readKey(section.freshnessMetaKey);
    const meta = unwrapEnvelope(raw).data;
    if (!Number.isFinite(meta?.fetchedAt)) return null;
    if (!section.completionMetaKey) return { fetchedAt: meta.fetchedAt };
    const completionRaw = await readKey(section.completionMetaKey);
    const completion = unwrapEnvelope(completionRaw).data;
    if (!Number.isFinite(completion?.fetchedAt)) return null;
    if (completion.fetchedAt < meta.fetchedAt) return null;
    return { fetchedAt: meta.fetchedAt };
  }
  // Try the envelope path first when a canonicalKey is declared. If the canonical
  // key isn't yet written as an envelope (PR 2 writer migration lagging reader
  // migration, or a legacy payload still present), fall through to the legacy
  // seed-meta read so the bundle doesn't over-run during the transition.
  if (section.canonicalKey) {
    const raw = await readKey(section.canonicalKey);
    const { _seed } = unwrapEnvelope(raw);
    if (_seed?.fetchedAt) {
      if (!section.completionMetaKey) return { fetchedAt: _seed.fetchedAt };
      const completionRaw = await readKey(section.completionMetaKey);
      const completion = unwrapEnvelope(completionRaw).data;
      // Absent is due, not fresh: runSeed writes this marker with
      // max(7d, ttlSeconds), so it cannot expire before the canonical key after
      // a completed run. Missing means the run never reached the final write.
      if (!Number.isFinite(completion?.fetchedAt)) return null;
      if (completion.fetchedAt !== _seed.fetchedAt) return null;
      return { fetchedAt: _seed.fetchedAt };
    }
    // Version migrations can opt out of the legacy seed-meta fallback. A
    // fresh meta entry for the old version must never suppress the first
    // publish of a newly required canonical envelope.
    if (section.requireCanonical) return null;
  }
  if (section.seedMetaKey) {
    const raw = await readKey(`seed-meta:${section.seedMetaKey}`);
    // Legacy seed-meta is `{ fetchedAt, recordCount, sourceVersion }` at top
    // level. It has no `_seed` wrapper so unwrapEnvelope returns it as data.
    const meta = unwrapEnvelope(raw).data;
    if (meta?.fetchedAt) return { fetchedAt: meta.fetchedAt };
  }
  return null;
}

// Stream child stdio line-by-line so hung sections surface progress instead of
// looking like a silent crash. Escalate SIGTERM → SIGKILL on timeout so child
// processes with in-flight HTTPS sockets can't outlive the deadline.
//
// Exported because a section's worst-case wall time is `timeoutMs +
// KILL_GRACE_MS`, and both the startup admission check below and the
// repo-wide gate in tests/bundle-budget-admission.test.mjs must compute it
// from the same constant rather than a copied literal.
export const KILL_GRACE_MS = 10_000;
export const DEFAULT_SECTION_TIMEOUT_MS = 300_000;

/**
 * Worst-case wall time a section can occupy: its own timeout plus the grace
 * window the runner allows between SIGTERM and SIGKILL.
 */
export function sectionWorstCaseMs(section) {
  return (section.timeoutMs || DEFAULT_SECTION_TIMEOUT_MS) + KILL_GRACE_MS;
}

/**
 * Slack a section must leave on top of its own worst case to be admittable in
 * practice. The runtime test is `elapsed + worstCase <= maxBundleMs` and
 * `elapsed` is never 0: before the first section is admitted the runner has
 * already run its freshness gate, which makes up to three Redis reads
 * (canonicalKey, freshnessMetaKey, completionMetaKey), each bounded by
 * REDIS_READ_TIMEOUT_MS.
 *
 * Without this, a section sized at exactly maxBundleMs - KILL_GRACE_MS passes a
 * naive `worstCase > maxBundleMs` check and is still deferred on every tick
 * forever — #6556 surviving its own fix. Sizing the headroom off the read
 * timeout keeps the two numbers linked instead of drifting apart.
 */
export const ADMISSION_HEADROOM_MS = 3 * REDIS_READ_TIMEOUT_MS;
// The heartbeat uses one bounded Redis request. With `prefetchFreshness`,
// section freshness can use up to three reads but the slowest section, not the
// section count, controls this preflight budget.
export const BUNDLE_PREFLIGHT_HEADROOM_MS = REDIS_READ_TIMEOUT_MS + ADMISSION_HEADROOM_MS;

/**
 * Age multiple at which a deferral stops reading as ordinary budget pressure
 * and starts reading as a stall (#6562 item 4). starvedTick only fires when a
 * tick publishes nothing; a section can instead be squeezed out on every tick
 * while healthy siblings keep the bundle green — `ran > 0`, exit 0, and the
 * deferral is indistinguishable from pressure. At deferral time the runner
 * already holds the section's seed-meta age, so a deferral whose data is older
 * than this multiple of the section's own interval is reported loudly
 * regardless of what else ran. The multiple must clear the 0.8x freshness
 * floor that makes an ordinary due section deferrable; 2x means at least one
 * full interval was missed while the section kept losing the budget race. A
 * single transient blip cannot reach it, so this does not reintroduce the
 * alert fatigue the GRACEFUL_FAIL exemption exists to prevent.
 */
export const STALL_AGE_INTERVAL_MULTIPLE = 2;

/**
 * Sections that can never be admitted, whatever else the tick does. A section
 * whose worst case plus ADMISSION_HEADROOM_MS exceeds the budget fails the
 * runtime admission test even as the first section of an otherwise empty tick.
 * Returns [] when unbudgeted.
 */
export function findUnadmittableSections(sections, maxBundleMs) {
  if (!Number.isFinite(maxBundleMs)) return [];
  return sections.filter(
    (section) => sectionWorstCaseMs(section) + ADMISSION_HEADROOM_MS > maxBundleMs,
  );
}

function streamLines(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => { if (buf) onLine(buf); });
  // Child-stdio `error` is rare (SIGKILL emits `end`), but Node throws on an
  // unhandled `error` event. Log it instead of crashing the runner.
  stream.on('error', (err) => onLine(`<stdio error: ${err.message}>`));
}

function spawnSeed(scriptPath, { timeoutMs, label, bundleStartedAtMs, completionMetaKey }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Capture the child's structured `seed_complete` event if emitted, so
    // the parent can re-emit the key fields on a single bundle-level line.
    // Railway log ingestion drops child-stdout lines when many seeders log
    // at similar timestamps (observed across Storage-Facilities /
    // Energy-Disruptions / Pipelines-Gas in PR #3294 launch run: each
    // dropped a different subset of Run ID / Mode / seed_complete lines
    // despite identical code paths). Bundle-level lines survive reliably.
    let lastSeedComplete = null;
    // BUNDLE_RUN_STARTED_AT_MS lets consumer seeders detect when a cohort
    // peer's seed-meta predates the current bundle run and fall back to a
    // hard default instead of reading a stale peer key. See plan
    // 2026-04-24-003 §"Phase 2 — SWF seeder" bundle-freshness guard.
    const child = spawn(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        BUNDLE_RUN_STARTED_AT_MS: String(bundleStartedAtMs ?? Date.now()),
        [BUNDLE_COMPLETION_META_KEY_ENV]: completionMetaKey || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    streamLines(child.stdout, (line) => {
      console.log(`  [${label}] ${line}`);
      const idx = line.indexOf('{"event":"seed_complete"');
      if (idx >= 0) {
        try {
          lastSeedComplete = JSON.parse(line.slice(idx));
        } catch { /* malformed JSON — keep previous */ }
      }
    });
    streamLines(child.stderr, (line) => console.warn(`  [${label}] ${line}`));

    let settled = false;
    let timedOut = false;
    let killTimer = null;
    // Fire the terminal "Failed ... timeout" log the moment we decide to kill,
    // BEFORE the SIGTERM→SIGKILL grace window. This guarantees the reason
    // reaches the log stream even if the container itself is killed during
    // the grace period (Railway's ~10min cap can land inside the grace for
    // sections whose timeoutMs is close to 10min).
    const softKill = setTimeout(() => {
      timedOut = true;
      const elapsedAtTimeout = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`  [${label}] Failed after ${elapsedAtTimeout}s: timeout after ${Math.round(timeoutMs / 1000)}s — sending SIGTERM`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        console.warn(`  [${label}] Did not exit on SIGTERM within ${KILL_GRACE_MS / 1000}s — sending SIGKILL`);
        child.kill('SIGKILL');
      }, KILL_GRACE_MS);
    }, timeoutMs);
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(softKill);
      if (killTimer) clearTimeout(killTimer);
      resolve(value);
    };

    child.on('error', (err) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`  [${label}] Failed after ${elapsed}s: spawn error: ${err.message}`);
      settle({ elapsed, ok: false, reason: `spawn error: ${err.message}`, alreadyLogged: true });
    });

    child.on('close', (code, signal) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (timedOut) {
        // Terminal reason already logged by softKill — just record the outcome.
        settle({ elapsed, ok: false, reason: `timeout after ${Math.round(timeoutMs / 1000)}s (signal ${signal || 'SIGTERM'})`, alreadyLogged: true });
      } else if (code === 0) {
        settle({ elapsed, ok: true, seedComplete: lastSeedComplete });
      } else if (code === GRACEFUL_FETCH_FAILURE_EXIT_CODE) {
        settle({
          elapsed,
          ok: false,
          status: 'GRACEFUL_FAIL',
          reason: `graceful fetch failure (exit ${GRACEFUL_FETCH_FAILURE_EXIT_CODE})`,
        });
      } else {
        settle({ elapsed, ok: false, reason: `exit ${code ?? 'null'}${signal ? ` (signal ${signal})` : ''}` });
      }
    });
  });
}

/**
 * @param {string} label - Bundle name for logging
 * @param {Array<{
 *   label: string,
 *   script: string,
 *   seedMetaKey?: string,    // legacy (pre-contract); reads `seed-meta:<key>`
 *   freshnessMetaKey?: string, // authoritative explicit seed-meta key
 *   canonicalKey?: string,   // PR 2+: reads envelope from the canonical data key
 *   completionMetaKey?: string, // full key written LAST by the run; must not
 *                               // predate the clock it attests (#6960)
 *   requireCanonical?: boolean, // do not fall back to legacy meta when canonical is absent
 *   intervalMs: number,
 *   timeoutMs?: number,
 *   dependsOn?: string[],    // labels that MUST run earlier in the array
 *   requiredEnv?: string[],  // deployment config required before any section runs
 * }>} sections
 * @param {{ maxBundleMs?: number, prefetchFreshness?: boolean }} [opts]
 */
/**
 * Env var carrying the per-member kill switch for a bundle, e.g.
 * WM_BUNDLE_CANADA_DISABLED_MEMBERS. Per bundle, so disabling a member of one
 * cannot silently disable a same-named member of another.
 */
export function bundleDisableEnvVar(label) {
  return `WM_BUNDLE_${String(label).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_DISABLED_MEMBERS`;
}

/** Section labels disabled for `label`, parsed from the env. */
export function disabledMembersFromEnv(label, env = process.env) {
  const raw = env[bundleDisableEnvVar(label)];
  if (typeof raw !== 'string' || raw.trim() === '') return new Set();
  return new Set(raw.split(',').map((name) => name.trim()).filter(Boolean));
}

export async function runBundle(label, sections, opts = {}) {
  for (const section of sections) {
    if (
      section.canonicalKey
      && !section.freshnessMetaKey
      && section.completionMetaKey
      && !section.completionMetaKey.startsWith('seed-completion:')
    ) {
      throw new Error(
        `[Bundle:${label}] section '${section.label}' canonical completionMetaKey must use `
        + `the dedicated seed-completion: namespace, got '${section.completionMetaKey}'`,
      );
    }
  }
  const missingEnvBySection = new Map();
  for (const section of sections) {
    if (section.requiredEnv == null) continue;
    if (!Array.isArray(section.requiredEnv)) {
      throw new Error(`[Bundle:${label}] section '${section.label}' requiredEnv must be an array`);
    }
    const missing = [];
    for (const requirement of section.requiredEnv) {
      // A nested array is an any-of group: the section needs at least one of
      // those variables, not all of them. Sources that resolve a routing value
      // as `SOURCE_SPECIFIC || SHARED` must declare it that way, or the gate is
      // stricter than the runtime it guards and hard-fails a section the seeder
      // would have run.
      const alternatives = Array.isArray(requirement) ? requirement : [requirement];
      if (alternatives.length === 0) {
        throw new Error(`[Bundle:${label}] section '${section.label}' has an empty requiredEnv group`);
      }
      for (const name of alternatives) {
        if (typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
          throw new Error(`[Bundle:${label}] section '${section.label}' has invalid requiredEnv name '${name}'`);
        }
      }
      const satisfied = alternatives.some(
        (name) => String(process.env[name] ?? '').trim(),
      );
      if (!satisfied) missing.push(alternatives.join(' or '));
    }
    if (missing.length > 0) missingEnvBySection.set(section.label, missing);
  }

  // Topological-order assertion. A consumer seeder reading a peer's
  // Redis output in-bundle depends on the peer running first; if a
  // future edit (e.g. alphabetizing sections) reorders them, the
  // consumer reads last-bundle's stale output. The freshness-guard in
  // the consumer is a safety net; this assertion is the contract.
  // Throws on violation so misconfiguration surfaces before any cron
  // tick runs.
  const labelIndex = new Map(sections.map((s, i) => [s.label, i]));
  for (let i = 0; i < sections.length; i++) {
    const deps = sections[i].dependsOn;
    if (!Array.isArray(deps)) continue;
    for (const depLabel of deps) {
      const depIdx = labelIndex.get(depLabel);
      if (depIdx == null) {
        throw new Error(`[Bundle:${label}] section '${sections[i].label}' dependsOn unknown label '${depLabel}'`);
      }
      if (depIdx >= i) {
        throw new Error(`[Bundle:${label}] section '${sections[i].label}' dependsOn '${depLabel}' but '${depLabel}' is at index ${depIdx} (must be < ${i})`);
      }
    }
  }

  const maxBundleMs = opts.maxBundleMs ?? Infinity;

  // A declared-but-unusable budget must not read as "no budget". Every guard
  // below is gated on Number.isFinite(maxBundleMs), so `maxBundleMs: '570000'`
  // or a NaN from `Number(process.env.X)` would silently disable the admission
  // check AND the per-tick deferral, restoring the exact #6556 shape by a
  // different route. Only an omitted budget means unbudgeted.
  if (opts.maxBundleMs != null && !(Number.isFinite(maxBundleMs) && maxBundleMs > 0)) {
    throw new Error(
      `[Bundle:${label}] maxBundleMs must be a positive finite number, got ${JSON.stringify(opts.maxBundleMs)}. `
      + 'Omit the option entirely for an unbudgeted bundle.',
    );
  }

  // Admission arithmetic assertion. The per-tick budget check below defers a
  // section whose worst case does not fit the REMAINING budget — a load-shed
  // that assumes the section fits the budget at all. When it does not, the
  // section is deferred on every tick forever and the bundle still exits 0:
  // #6556 shipped maxBundleMs 570s against a cheapest section of 610s, so
  // seed-bundle-resilience ran nothing for six hours under a green Railway
  // badge. Throw instead, alongside the dependsOn contract above, so the
  // misconfiguration surfaces on the first tick rather than as data ageing
  // out half a day later.
  //
  // Sections already failing the requiredEnv gate are excluded. They cannot run
  // this tick regardless of their timeout, so throwing on their arithmetic
  // would take the bundle's HEALTHY members down as collateral during an
  // environment outage — the per-section CONFIG_ERROR path deliberately fails
  // only the affected section. Nothing is hidden by deferring the question:
  // tests/bundle-budget-admission.test.mjs checks every section's arithmetic
  // statically, with no knowledge of the environment, so an oversized timeout
  // still cannot reach production behind a missing secret.
  const envGated = new Set(missingEnvBySection.keys());
  const unadmittable = findUnadmittableSections(
    sections.filter((section) => !envGated.has(section.label)),
    maxBundleMs,
  );
  if (unadmittable.length > 0) {
    const detail = unadmittable
      .map((s) => `'${s.label}' needs ${sectionWorstCaseMs(s) + ADMISSION_HEADROOM_MS}ms (timeoutMs ${s.timeoutMs || DEFAULT_SECTION_TIMEOUT_MS} + ${KILL_GRACE_MS}ms kill grace + ${ADMISSION_HEADROOM_MS}ms admission headroom)`)
      .join('; ');
    const largestFittingTimeoutMs = maxBundleMs - KILL_GRACE_MS - ADMISSION_HEADROOM_MS;
    const remedy = largestFittingTimeoutMs > 0
      ? `Lower those section timeouts to at most ${largestFittingTimeoutMs}ms, or raise maxBundleMs (it must stay under the Railway container cap).`
      : `No section timeout can fit this budget at all — ${KILL_GRACE_MS}ms kill grace plus ${ADMISSION_HEADROOM_MS}ms admission headroom already exceed it. Raise maxBundleMs (it must stay under the Railway container cap).`;
    throw new Error(
      `[Bundle:${label}] maxBundleMs=${maxBundleMs} is below the worst case of ${unadmittable.length} section(s), which can therefore never be admitted on any tick: ${detail}. `
      + remedy,
    );
  }

  // PER-MEMBER KILL SWITCH. A bundle collapses N services into one, which also
  // collapses N deploy controls into one: before this, taking a single
  // misbehaving member out of rotation meant editing the section list and
  // redeploying the whole bundle, stopping its siblings too.
  //
  // Fail-closed on the control itself: an unrecognised label is a CONFIGURATION
  // ERROR, not an ignored string. A typo'd kill switch that silently disables
  // nothing is the worst outcome here — an operator believes a source is off
  // while it keeps running.
  const disabledMembers = disabledMembersFromEnv(label);
  const knownLabels = new Set(sections.map((section) => section.label));
  const unknownDisabled = [...disabledMembers].filter((name) => !knownLabels.has(name));
  if (unknownDisabled.length > 0) {
    throw new Error(
      `[Bundle:${label}] ${bundleDisableEnvVar(label)} names unknown section(s): ${unknownDisabled.join(', ')}. `
      + `Known sections: ${[...knownLabels].join(', ')}. `
      + 'Refusing to start: a kill switch that matches nothing would report success while the source it names keeps running.',
    );
  }

  const t0 = Date.now();
  const budgetLabel = Number.isFinite(maxBundleMs) ? `, budget ${Math.round(maxBundleMs / 1000)}s` : '';
  console.log(`[Bundle:${label}] Starting (${sections.length} sections${budgetLabel})`);
  if (disabledMembers.size > 0) {
    console.warn(
      `[Bundle:${label}] ${disabledMembers.size} member(s) disabled by ${bundleDisableEnvVar(label)}: `
      + `${[...disabledMembers].join(', ')} — their seed-meta will age out and health will report them stale, which is intended.`,
    );
  }
  // Write before any section so a skip-all tick still proves the scheduler fired.
  const wroteHeartbeat = await writeBundleHeartbeat(label);
  if (wroteHeartbeat) {
    console.log(`[Bundle:${label}] tick heartbeat ${bundleHeartbeatKey(label)}`);
  }

  // Bundles with a simultaneous-fit invariant can opt into a bounded preflight:
  // all interval clocks start together so member count cannot consume the wall
  // budget before the first child. Keep the default sequential behavior for
  // large bundles, where an unbounded fan-out would create a Redis burst.
  const freshnessByLabel = opts.prefetchFreshness
    ? new Map(await Promise.all(sections.map(async (section) => (
      [section.label, await readSectionFreshness(section)]
    ))))
    : null;

  let ran = 0, skipped = 0, deferred = 0, failed = 0, gracefulFailed = 0, stalled = 0;

  let disabled = 0;
  for (const section of sections) {
    if (disabledMembers.has(section.label)) {
      // Counted and logged, never silent. A disabled member stops writing
      // seed-meta, so /api/health ages it into STALE_SEED on its own — the
      // source disappearing from the product stays visible rather than being
      // suppressed along with the fetch.
      console.warn(`  [${section.label}] DISABLED by ${bundleDisableEnvVar(label)} — not run this tick`);
      console.warn(`[Bundle:${label}] section=${section.label} status=DISABLED reason=kill-switch`);
      disabled++;
      continue;
    }
    const missingEnv = missingEnvBySection.get(section.label);
    if (missingEnv) {
      const reason = `missing required environment configuration: ${missingEnv.join(', ')}`;
      console.error(`  [${section.label}] Failed configuration: ${reason}`);
      console.error(`[Bundle:${label}] section=${section.label} status=CONFIG_ERROR reason=${reason}`);
      failed++;
      continue;
    }

    const scriptPath = join(__dirname, section.script);
    const timeout = section.timeoutMs || DEFAULT_SECTION_TIMEOUT_MS;

    const freshness = freshnessByLabel
      ? freshnessByLabel.get(section.label) || null
      : await readSectionFreshness(section);
    if (freshness?.fetchedAt) {
      const elapsed = Date.now() - freshness.fetchedAt;
      if (elapsed < section.intervalMs * 0.8) {
        const agoMin = Math.round(elapsed / 60_000);
        const intervalMin = Math.round(section.intervalMs / 60_000);
        console.log(`  [${section.label}] Skipped, last seeded ${agoMin}min ago (interval: ${intervalMin}min)`);
        skipped++;
        continue;
      }
    }

    const elapsedBundle = Date.now() - t0;
    // Worst-case runtime is timeoutMs + KILL_GRACE_MS (child may ignore SIGTERM
    // and need SIGKILL after grace). Admit only when the full worst-case fits.
    // Shared with the startup check so the two can never disagree about which
    // sections are admittable.
    const worstCase = sectionWorstCaseMs(section);
    if (elapsedBundle + worstCase > maxBundleMs) {
      const remainingSec = Math.max(0, Math.round((maxBundleMs - elapsedBundle) / 1000));
      const needSec = Math.round(worstCase / 1000);
      console.log(`  [${section.label}] Deferred, needs ${needSec}s (timeout+grace) but only ${remainingSec}s left in bundle budget`);
      deferred++;
      // #6562 item 4: a deferral is only pressure while the data can still
      // afford to wait for a later tick. Once the section's seed-meta age
      // exceeds STALL_AGE_INTERVAL_MULTIPLE of its own interval, it has been
      // losing the budget race across whole intervals — a stall, and it must
      // be loud regardless of what else ran (see the exit gate below).
      if (freshness?.fetchedAt != null && Date.now() - freshness.fetchedAt > section.intervalMs * STALL_AGE_INTERVAL_MULTIPLE) {
        const ageMin = Math.round((Date.now() - freshness.fetchedAt) / 60_000);
        const intervalMin = Math.round(section.intervalMs / 60_000);
        console.error(
          `  [${section.label}] Deferred, but its data is ${ageMin}min old — over ${STALL_AGE_INTERVAL_MULTIPLE}x its ${intervalMin}min interval. `
          + 'This is starvation, not pressure: the section keeps losing the budget race while the bundle stays green.',
        );
        stalled++;
      }
      continue;
    }

    const result = await spawnSeed(scriptPath, {
      timeoutMs: timeout,
      label: section.label,
      bundleStartedAtMs: t0,
      completionMetaKey: section.freshnessMetaKey ? '' : section.completionMetaKey,
    });
    if (result.ok) {
      console.log(`  [${section.label}] Done (${result.elapsed}s)`);
      // Bundle-level per-section summary — emitted from parent stdout so
      // Railway log ingestion captures it reliably even when child lines
      // drop. Observability tools should key off this line, not per-section
      // Run ID / Mode / seed_complete lines which are best-effort only.
      const sc = result.seedComplete;
      if (sc && typeof sc === 'object') {
        console.log(`[Bundle:${label}] section=${section.label} status=OK durationMs=${sc.durationMs ?? ''} records=${sc.recordCount ?? ''} state=${sc.state || 'OK'}`);
      } else {
        // Seeder didn't emit seed_complete (legacy non-contract seeders, or
        // the child's event line was dropped before parsing).
        console.log(`[Bundle:${label}] section=${section.label} status=OK elapsed=${result.elapsed}s`);
      }
      ran++;
    } else {
      if (!result.alreadyLogged) {
        console.error(`  [${section.label}] Failed after ${result.elapsed}s: ${result.reason}`);
      }
      // Emit the FAILED summary to stderr (same stream as the Failed line
      // and SIGKILL escalation log) so chronological ordering in combined
      // output is preserved. If we went to stdout here, the line would
      // appear before those stderr lines when consumers concatenate
      // stdout+stderr, breaking tests (and log readers) that rely on
      // signal-escalation ordering.
      const status = result.status || 'FAILED';
      console.error(`[Bundle:${label}] section=${section.label} status=${status} elapsed=${result.elapsed}s reason=${(result.reason || 'unknown').replace(/\s+/g, ' ')}`);
      // A GRACEFUL_FAIL (child exit 75) extended the last-good TTL and lost no
      // data — a transient upstream blip (e.g. a rate-limited source). Counting
      // it as a hard failure would crash the whole bundle (exit 1 → Railway
      // "Deploy Crashed!") over a benign per-member skip. Track it separately so
      // only HARD failures gate the exit code; the skip stays fully logged above.
      if (status === 'GRACEFUL_FAIL') gracefulFailed++;
      else failed++;
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  // `disabled:` is appended ONLY when non-zero. This line is the documented
  // observability contract for bundle ticks — tools key off it — so the shape
  // stays byte-identical when no kill switch is set. `stalled:` (this PR)
  // rides along at the tail for the same reason: it is the starvation signal
  // #6562 item 4 exists to surface.
  const disabledField = disabled > 0 ? ` disabled:${disabled}` : '';
  console.log(`[Bundle:${label}] Finished in ${totalSec}s, ran:${ran} skipped:${skipped} deferred:${deferred}${disabledField} failed:${failed} graceful:${gracefulFailed} stalled:${stalled}`);
  // A tick that completed no section while deferring a due one accomplished
  // nothing AND shed work. Deferral only pays for itself if the deferred
  // section runs on a later tick, so this state repeating is a stalled
  // service — the shape that made #6556 invisible for six hours. Report it as
  // a failure; `ran:0 deferred:0` (everything fresh) stays a healthy no-op.
  // This used to carry `&& gracefulFailed === 0`, exempting a tick whose only
  // admitted section hit a transient blip (child exit 75, last-good TTL
  // extended, no data lost) so one flaky source would not fire "Deploy
  // Crashed!". That premise holds for the FAILING section and not for the ones
  // it shed — those published nothing and extended no TTL.
  //
  // seed-bundle-static-ref is the counter-example that removed it:
  // Arms-Suppliers burns its full 390s fetch deadline (SIPRI answers in ~10.6s
  // and it issues ~200 requests at concurrency 4) and exits 75, leaving 179s of
  // a 570s budget. All four remaining due sections need >=190s, so every one
  // defers and `ran:0`. gracefulFailed was 1, so this stayed false and the
  // bundle reported success for weeks while mineralProduction and
  // submarineCables had no key in Redis at all (#6799).
  //
  // The exemption below still covers the case it was written for — `ran > 0`
  // with a graceful skip, where real work published and one source blipped. A
  // tick that published NOTHING has no successful work to vouch for it.
  const starvedTick = ran === 0 && deferred > 0;
  if (starvedTick) {
    console.error(
      `[Bundle:${label}] ran:0 while ${deferred} due section(s) were deferred — this tick published nothing and shed work. `
      + 'Exiting non-zero: a fully-deferred tick is indistinguishable from a healthy no-op, so it must not report success.',
    );
  } else if (stalled > 0) {
    // #6562 item 4: partial starvation. starvedTick above stays scoped to the
    // published-nothing tick; this branch covers the section that fits the
    // budget on its own but never beside its siblings. The GRACEFUL_FAIL
    // exemption does not soften this: a 2x-interval-old deferral cannot be
    // produced by a single transient blip, so exiting non-zero here pages on
    // a genuinely stalled member, not on alert fatigue.
    console.error(
      `[Bundle:${label}] ${stalled} deferred section(s) are older than ${STALL_AGE_INTERVAL_MULTIPLE}x their interval — starvation while the bundle reported progress. Exiting non-zero.`,
    );
  } else if (failed === 0 && gracefulFailed > 0) {
    // Graceful-only run (transient skips, no hard failures): exit 0 so Railway
    // does not paint CRASHED and fire a spurious alert. Real staleness is caught
    // independently by the /api/health freshness monitor keyed on seed-meta TTL.
    console.log(`[Bundle:${label}] ${gracefulFailed} graceful fetch skip(s), no hard failures — no data lost, exiting 0 (not a crash)`);
  }
  process.exit(failed > 0 || starvedTick || stalled > 0 ? 1 : 0);
}
