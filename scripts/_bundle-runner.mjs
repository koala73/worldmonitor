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
import { GRACEFUL_FETCH_FAILURE_EXIT_CODE, loadEnvFile } from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 604_800_000;

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
 * Read section freshness for the interval gate.
 *
 * Returns `{ fetchedAt }` or null. A declared `freshnessMetaKey` is authoritative
 * for sources whose canonical envelope may be republished from retained
 * last-good data. When `completionMetaKey` is also declared, its timestamp must
 * be at or after source transport success; an older completion belongs to a
 * prior run and cannot attest a newer pre-publication heartbeat. Otherwise
 * prefer envelope-form data when `canonicalKey` is declared, then fall back to
 * the legacy `seed-meta:<key>` read.
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
    if (_seed?.fetchedAt) return { fetchedAt: _seed.fetchedAt };
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

function spawnSeed(scriptPath, { timeoutMs, label, bundleStartedAtMs }) {
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
 *   completionMetaKey?: string, // optional completed-run key paired with freshnessMetaKey
 *   canonicalKey?: string,   // PR 2+: reads envelope from the canonical data key
 *   requireCanonical?: boolean, // do not fall back to legacy meta when canonical is absent
 *   intervalMs: number,
 *   timeoutMs?: number,
 *   dependsOn?: string[],    // labels that MUST run earlier in the array
 *   requiredEnv?: string[],  // deployment config required before any section runs
 * }>} sections
 * @param {{ maxBundleMs?: number }} [opts]
 */
export async function runBundle(label, sections, opts = {}) {
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
  const unadmittable = findUnadmittableSections(sections, maxBundleMs);
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

  const t0 = Date.now();
  const budgetLabel = Number.isFinite(maxBundleMs) ? `, budget ${Math.round(maxBundleMs / 1000)}s` : '';
  console.log(`[Bundle:${label}] Starting (${sections.length} sections${budgetLabel})`);

  let ran = 0, skipped = 0, deferred = 0, failed = 0, gracefulFailed = 0;

  for (const section of sections) {
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

    const freshness = await readSectionFreshness(section);
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
      continue;
    }

    const result = await spawnSeed(scriptPath, { timeoutMs: timeout, label: section.label, bundleStartedAtMs: t0 });
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
  console.log(`[Bundle:${label}] Finished in ${totalSec}s, ran:${ran} skipped:${skipped} deferred:${deferred} failed:${failed} graceful:${gracefulFailed}`);
  // A tick that completed no section while deferring a due one accomplished
  // nothing AND shed work. Deferral only pays for itself if the deferred
  // section runs on a later tick, so this state repeating is a stalled
  // service — the shape that made #6556 invisible for six hours. Report it as
  // a failure; `ran:0 deferred:0` (everything fresh) stays a healthy no-op.
  // `gracefulFailed === 0` is load-bearing: a tick whose only admitted section
  // hit a transient upstream blip (child exit 75, last-good TTL extended, no
  // data lost) already has an exit-0 exemption precisely so one flaky source
  // does not fire "Deploy Crashed!". Without this clause a benign 429 that
  // happened to also push a sibling past the budget would page — alert fatigue
  // on the exact alarm this change exists to make trustworthy.
  const starvedTick = ran === 0 && deferred > 0 && gracefulFailed === 0;
  if (starvedTick) {
    console.error(
      `[Bundle:${label}] ran:0 while ${deferred} due section(s) were deferred — this tick published nothing and shed work. `
      + 'Exiting non-zero: a fully-deferred tick is indistinguishable from a healthy no-op, so it must not report success.',
    );
  } else if (failed === 0 && gracefulFailed > 0) {
    // Graceful-only run (transient skips, no hard failures): exit 0 so Railway
    // does not paint CRASHED and fire a spurious alert. Real staleness is caught
    // independently by the /api/health freshness monitor keyed on seed-meta TTL.
    console.log(`[Bundle:${label}] ${gracefulFailed} graceful fetch skip(s), no hard failures — no data lost, exiting 0 (not a crash)`);
  }
  process.exit(failed > 0 || starvedTick ? 1 : 0);
}
