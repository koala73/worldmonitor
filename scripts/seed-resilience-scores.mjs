#!/usr/bin/env node
import {
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  writeFreshnessMetadata,
} from './_seed-utils.mjs';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { isInRankableUniverse } from './shared/rankable-universe.mjs';
import {
  DRAWS,
  RESILIENCE_INTERVAL_KEY_PREFIX as INTERVAL_KEY_PREFIX,
  buildScoreIntervalPayload,
  computeIntervals,
  createIntervalDiagnostics,
} from './_resilience-intervals.mjs';

loadEnvFile(import.meta.url);

const API_BASE = process.env.API_BASE_URL || 'https://api.worldmonitor.app';
// Normal premium reads/warmups use the standard API key allowlist.
const WM_KEY = process.env.WORLDMONITOR_API_KEY
  || (process.env.WORLDMONITOR_VALID_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)[0]
  || '';
// Ranking ?refresh=1 is intentionally stronger than a normal premium read:
// only this seed-only secret can force the expensive recompute path.
const WM_REFRESH_KEY = process.env.WORLDMONITOR_SEED_REFRESH_KEY?.trim() || '';
const SEED_UA = 'Mozilla/5.0 (compatible; WorldMonitor-Seed/1.0)';
const NEG_SENTINEL = '__WM_NEG__';

function requireSeedRefreshKey() {
  if (WM_REFRESH_KEY) return;
  throw new Error('WORLDMONITOR_SEED_REFRESH_KEY is required for resilience ranking refresh');
}

// Bumped v13 → v14 in lockstep with server/worldmonitor/resilience/v1/
// _shared.ts for plan 2026-04-25-004 Phase 2 (Ship 2) — adds the new
// `financialSystemExposure` dim to the headline score; v13 entries lack
// the new dim's contribution so caching them post-deploy would surface
// stale partial-shape payloads.
// Earlier: v12 → v13 for plan 2026-04-25-004 Phase 1 (tradeSanctions →
// tradePolicy rename + dropped OFAC component + reweighted formula).
// Earlier: v11 → v12 for PR 3A §net-imports denominator (plan
// 2026-04-24-002). Seeder and server MUST agree on the prefix or the
// seeder writes scores the handler will never read.
// v17 → v18 for plan 2026-04-26-002 §U8.1 (net-imports denominator
// extended from sovereignFiscalBuffer to liquidReserveAdequacy). Same
// reasoning as PR 3A's v11→v12: the `_formula` tag does not detect
// intra-'d6' scorer changes, so v17 entries would serve gross-imports
// AE/PA scores until TTL expires post-deploy.
// v18 → v19 for issue #3971: cyberDigital caps per-snapshot cyber-feed
// severity weight, so seeder-written scores and rankings must agree with
// server readers.
// v19 → v20 for country-resilience audit P1-3: stale observed data now
// derates confidence coverage and headline eligibility, so seeder-written
// payloads must not share keys with pre-derate confidence metadata.
// v20 → v21 for the P1-1 CRI contract fix: pillar member domains now use
// domain.weight * average dimension coverage inside the active `pc` formula.
// v20 is reserved for the parallel staleness-derate rollout.
// v21 → v22 for country-resilience audit round 2 P2-N2/P2-N3: currencyExternal
// inflation stability and NaN-safe blend math change published score values, so
// seeder-written scores and rankings must share the server reader namespace.
// v22 → v23 batches three same-tag `pc` scorer changes: import-HHI stale /
// missing source years now derate certainty coverage (#4088), observed
// zero-outage feeds score as observed-quiet in infrastructure (P3-8), and WTO
// tradePolicy restriction/barrier rows score one-row-per-reporter severity
// instead of stale count anchors (P2-1). Seeder-written scores and rankings must
// share the server reader namespace for the full batch.
// v23 → v24 for country-resilience audit round 5 R5-2 / PR #4101: governance
// WGI indicator slot semantics changed under the same `pc` formula tag, so the
// seeder-written score/ranking namespace must match the server reader bump.
export const RESILIENCE_SCORE_CACHE_PREFIX = 'resilience:score:v24:';
export const RESILIENCE_RANKING_CACHE_KEY = 'resilience:ranking:v24';
// Must match the server-side RESILIENCE_RANKING_CACHE_TTL_SECONDS. Extended
// to 12h (2x the cron interval) so a missed/slow cron can't create an
// EMPTY_ON_DEMAND gap before the next successful rebuild.
export const RESILIENCE_RANKING_CACHE_TTL_SECONDS = 12 * 60 * 60;
// Scores section health is independent from ranking-cache freshness. Keep this
// at 6x the 2h cron cadence even if ranking cache TTL is tuned separately.
export const RESILIENCE_SCORE_SECTION_META_TTL_SECONDS = 12 * 60 * 60;
export const RESILIENCE_STATIC_INDEX_KEY = 'resilience:static:index:v1';

const INTERVAL_TTL_SECONDS = 7 * 24 * 60 * 60;
export { computeIntervals };

function isKnownScoreFormulaTag(value) {
  return value === 'pc' || value === 'd6';
}

function recordDiagnosticSample(diagnostics, sampleKey, countryCode, details = {}) {
  const samples = diagnostics?.[sampleKey];
  if (!Array.isArray(samples) || samples.length >= 5) return;
  samples.push({ countryCode, ...details });
}

function recordDiagnosticCount(diagnostics, countKey, sampleKey, countryCode, details = {}) {
  diagnostics[countKey] = (Number(diagnostics[countKey]) || 0) + 1;
  recordDiagnosticSample(diagnostics, sampleKey, countryCode, details);
}

async function redisGetJson(url, token, key) {
  const resp = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (!data?.result) return null;
  try { return unwrapEnvelope(JSON.parse(data.result)).data; } catch { return null; }
}

async function redisPipeline(url, token, commands) {
  const resp = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Redis pipeline HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function fetchRuntimeFormulaTag() {
  try {
    const resp = await fetch(`${API_BASE}/api/resilience/v1/get-runtime-manifest`, {
      headers: { 'User-Agent': SEED_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[resilience-scores] Runtime manifest returned ${resp.status}; accepting any valid score formula tag`);
      return null;
    }

    const data = await resp.json();
    if (isKnownScoreFormulaTag(data?.formulaTag)) return data.formulaTag;
    console.warn(`[resilience-scores] Runtime manifest formulaTag=${String(data?.formulaTag)} is not recognized; accepting any valid score formula tag`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[resilience-scores] Runtime manifest formula lookup failed (${message}); accepting any valid score formula tag`);
  }
  return null;
}

export function parseCachedScorePayload(raw, options = {}) {
  if (typeof raw !== 'string' || raw.length === 0 || raw === 'null') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === NEG_SENTINEL) return null;
    const payload = unwrapEnvelope(parsed).data;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    // Require a valid formula tag, but DO NOT re-derive that formula from this
    // process's env. Production is the source of truth for the formula it
    // actually served; callers may pass the live runtime formula when they need
    // to reject stale cache entries from a prior formula.
    const formula = payload._formula;
    if (!isKnownScoreFormulaTag(formula)) return null;
    const expectedFormula = options?.expectedFormula;
    if (isKnownScoreFormulaTag(expectedFormula) && formula !== expectedFormula) return null;
    const overallScore = Number(payload.overallScore);
    if (!Number.isFinite(overallScore) || overallScore <= 0) return null;
    return payload;
  } catch {
    return null;
  }
}

function countCachedFromPipeline(results, expectedFormula = null) {
  let count = 0;
  for (const entry of results) {
    if (parseCachedScorePayload(entry?.result, { expectedFormula }) != null) count++;
  }
  return count;
}

export function buildIntervalPayloadFromCachedScore(raw, countryCode, diagnostics, options = {}) {
  if (!raw || raw === 'null') {
    recordDiagnosticCount(diagnostics, 'missingScorePayloadCount', 'missingScorePayloadSamples', countryCode);
    return null;
  }

  try {
    const score = unwrapEnvelope(JSON.parse(raw)).data;
    if (!score || typeof score !== 'object' || Array.isArray(score)) {
      recordDiagnosticCount(diagnostics, 'invalidScorePayloadCount', 'invalidScorePayloadSamples', countryCode);
      return null;
    }

    const formula = typeof score?._formula === 'string' ? score._formula : undefined;
    if (!isKnownScoreFormulaTag(formula)) {
      // buildScoreIntervalPayload records formula skip diagnostics for ambiguous cached scores.
      buildScoreIntervalPayload(score, { draws: DRAWS, diagnostics });
      return null;
    }

    const expectedFormula = options?.expectedFormula;
    if (isKnownScoreFormulaTag(expectedFormula) && formula !== expectedFormula) {
      recordDiagnosticCount(diagnostics, 'staleScorePayloadCount', 'staleScorePayloadSamples', countryCode, {
        formula,
        expectedFormula,
      });
      return null;
    }

    // The payload carries a valid 'pc'|'d6' tag. Build the interval that
    // matches THAT tag, but only after checking the live runtime formula when
    // the manifest lookup succeeded. We deliberately do not gate on a formula
    // re-derived from this process's env: that drift left production
    // interval-less while the ranking stayed fresh.
    const currentScore = parseCachedScorePayload(raw, { expectedFormula });
    if (!currentScore) {
      recordDiagnosticCount(diagnostics, 'invalidScorePayloadCount', 'invalidScorePayloadSamples', countryCode, { formula });
      return null;
    }

    const payload = buildScoreIntervalPayload(currentScore, { draws: DRAWS, diagnostics });
    if (!payload) {
      recordDiagnosticCount(diagnostics, 'intervalPayloadSkipCount', 'intervalPayloadSkipSamples', countryCode, {
        formula: typeof currentScore?._formula === 'string' ? currentScore._formula : undefined,
      });
      return null;
    }
    return payload;
  } catch (err) {
    recordDiagnosticCount(diagnostics, 'malformedScorePayloadCount', 'malformedScorePayloadSamples', countryCode, {
      error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    });
    return null;
  }
}

async function computeAndWriteIntervals(url, token, countryCodes, pipelineResults, options = {}) {
  const commands = [];
  const diagnostics = createIntervalDiagnostics();

  for (let i = 0; i < countryCodes.length; i++) {
    const raw = pipelineResults[i]?.result ?? null;
    const countryCode = countryCodes[i];
    const payload = buildIntervalPayloadFromCachedScore(raw, countryCode, diagnostics, options);
    if (payload) {
      commands.push(['SET', `${INTERVAL_KEY_PREFIX}${countryCode}`, JSON.stringify(payload), 'EX', INTERVAL_TTL_SECONDS]);
    }
  }

  if (diagnostics.formulaSkipCount > 0) {
    console.warn(
      `[resilience-scores] Skipped ${diagnostics.formulaSkipCount} interval payloads with missing/ambiguous formula tags ` +
      `(samples=${JSON.stringify(diagnostics.formulaSkipSamples)})`,
    );
  }

  if (commands.length === 0) {
    console.warn(
      `[resilience-scores] No interval keys written for ${countryCodes.length} countries ` +
      `(missingScorePayloads=${diagnostics.missingScorePayloadCount}, ` +
      `staleScorePayloads=${diagnostics.staleScorePayloadCount}, ` +
      `invalidScorePayloads=${diagnostics.invalidScorePayloadCount}, ` +
      `malformedScorePayloads=${diagnostics.malformedScorePayloadCount}, ` +
      `intervalPayloadSkips=${diagnostics.intervalPayloadSkipCount}, ` +
      `formulaSkips=${diagnostics.formulaSkipCount})`,
    );
    return { recordCount: 0, diagnostics };
  }

  const PIPE_BATCH = 50;
  for (let i = 0; i < commands.length; i += PIPE_BATCH) {
    await redisPipeline(url, token, commands.slice(i, i + PIPE_BATCH));
  }
  console.log(`[resilience-scores] Wrote ${commands.length} interval keys`);
  if (diagnostics.activeScoreClampCount > 0) {
    console.warn(
      `[resilience-scores] Clamped ${diagnostics.activeScoreClampCount} interval bands to contain the active score ` +
      `(maxDelta=${diagnostics.activeScoreClampMaxDelta}; samples=${JSON.stringify(diagnostics.activeScoreClampSamples)})`,
    );
  }

  await writeFreshnessMetadata('resilience', 'intervals', commands.length, '', INTERVAL_TTL_SECONDS);
  return { recordCount: commands.length, diagnostics };
}

export function getIntervalWriteFailure(result) {
  if (result?.skipped) return null;
  const total = Number(result?.total ?? 0);
  const intervalsWritten = Number(result?.intervalsWritten ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (Number.isFinite(intervalsWritten) && intervalsWritten > 0) return null;

  const scoreCount = Number(result?.recordCount ?? 0);
  const formulaSkipCount = Number(result?.intervalFormulaSkipCount ?? 0);
  const missingScorePayloadCount = Number(result?.intervalMissingScorePayloadCount ?? 0);
  const staleScorePayloadCount = Number(result?.intervalStaleScorePayloadCount ?? 0);
  const invalidScorePayloadCount = Number(result?.intervalInvalidScorePayloadCount ?? 0);
  const malformedScorePayloadCount = Number(result?.intervalMalformedScorePayloadCount ?? 0);
  const intervalPayloadSkipCount = Number(result?.intervalPayloadSkipCount ?? 0);
  let reason = 'empty_interval_writes';
  if (staleScorePayloadCount > 0) reason = 'stale_score_cache';
  else if (missingScorePayloadCount >= total || (scoreCount <= 0 && missingScorePayloadCount > 0)) reason = 'missing_score_cache';
  else if (malformedScorePayloadCount > 0) reason = 'malformed_score_cache';
  else if (invalidScorePayloadCount > 0) reason = 'invalid_score_cache';
  else if (formulaSkipCount > 0) reason = 'unusable_score_formula';
  else if (intervalPayloadSkipCount > 0) reason = 'unusable_score_payload';

  return {
    reason,
    message:
      `resilience interval seed wrote 0 interval keys for ${total} rankable countries ` +
      `(cachedScores=${Number.isFinite(scoreCount) ? scoreCount : 0}, ` +
      `missingScorePayloads=${Number.isFinite(missingScorePayloadCount) ? missingScorePayloadCount : 0}, ` +
      `staleScorePayloads=${Number.isFinite(staleScorePayloadCount) ? staleScorePayloadCount : 0}, ` +
      `invalidScorePayloads=${Number.isFinite(invalidScorePayloadCount) ? invalidScorePayloadCount : 0}, ` +
      `malformedScorePayloads=${Number.isFinite(malformedScorePayloadCount) ? malformedScorePayloadCount : 0}, ` +
      `formulaSkips=${Number.isFinite(formulaSkipCount) ? formulaSkipCount : 0}, ` +
      `intervalPayloadSkips=${Number.isFinite(intervalPayloadSkipCount) ? intervalPayloadSkipCount : 0})`,
  };
}

export function buildSeedResultLogExtra(result) {
  const intervalFailure = getIntervalWriteFailure(result);
  return {
    extra: {
      skipped: Boolean(result.skipped),
      ...(result.total != null && { total: result.total }),
      ...(result.reason != null && { reason: result.reason }),
      ...(result.intervalsWritten != null && { intervalsWritten: result.intervalsWritten }),
      ...(result.intervalClampCount != null && { intervalClampCount: result.intervalClampCount }),
      ...(result.intervalClampMaxDelta != null && { intervalClampMaxDelta: result.intervalClampMaxDelta }),
      ...(result.intervalFormulaSkipCount != null && { intervalFormulaSkipCount: result.intervalFormulaSkipCount }),
      ...(result.intervalFormulaSkipSamples?.length ? { intervalFormulaSkipSamples: result.intervalFormulaSkipSamples } : {}),
      ...(result.intervalMissingScorePayloadCount != null && { intervalMissingScorePayloadCount: result.intervalMissingScorePayloadCount }),
      ...(result.intervalMissingScorePayloadSamples?.length ? { intervalMissingScorePayloadSamples: result.intervalMissingScorePayloadSamples } : {}),
      ...(result.intervalStaleScorePayloadCount != null && { intervalStaleScorePayloadCount: result.intervalStaleScorePayloadCount }),
      ...(result.intervalStaleScorePayloadSamples?.length ? { intervalStaleScorePayloadSamples: result.intervalStaleScorePayloadSamples } : {}),
      ...(result.intervalInvalidScorePayloadCount != null && { intervalInvalidScorePayloadCount: result.intervalInvalidScorePayloadCount }),
      ...(result.intervalInvalidScorePayloadSamples?.length ? { intervalInvalidScorePayloadSamples: result.intervalInvalidScorePayloadSamples } : {}),
      ...(result.intervalMalformedScorePayloadCount != null && { intervalMalformedScorePayloadCount: result.intervalMalformedScorePayloadCount }),
      ...(result.intervalMalformedScorePayloadSamples?.length ? { intervalMalformedScorePayloadSamples: result.intervalMalformedScorePayloadSamples } : {}),
      ...(result.intervalPayloadSkipCount != null && { intervalPayloadSkipCount: result.intervalPayloadSkipCount }),
      ...(result.intervalPayloadSkipSamples?.length ? { intervalPayloadSkipSamples: result.intervalPayloadSkipSamples } : {}),
      ...(intervalFailure && { status: 'ERROR', error: intervalFailure.message, intervalFailureReason: intervalFailure.reason }),
    },
    intervalFailure,
    exitCode: intervalFailure ? 1 : 0,
  };
}

async function seedResilienceScores() {
  const { url, token } = getRedisCredentials();

  const index = await redisGetJson(url, token, RESILIENCE_STATIC_INDEX_KEY);
  // Plan 2026-04-26-002 §U2 (PR 1): defense-in-depth — filter to the
  // rankable universe (193 UN members + 3 SARs) here too, in case the
  // static index was seeded by an older version of seed-resilience-static
  // that hadn't yet applied the same filter. Both seeders consume the
  // same `isInRankableUniverse` helper to ensure their universes match;
  // this defensive filter prevents transient mismatch during deploys.
  const allCountries = (index?.countries ?? [])
    .map((c) => String(c || '').trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  const countryCodes = allCountries.filter(isInRankableUniverse);
  const droppedCount = allCountries.length - countryCodes.length;
  if (droppedCount > 0) {
    console.log(`[resilience-scores] Filtered ${droppedCount} non-rankable territories from static index (transitional — seed-resilience-static will catch up on next cron tick)`);
  }

  if (countryCodes.length === 0) {
    console.warn('[resilience-scores] Static index is empty — has seed-resilience-static run this year?');
    return { skipped: true, reason: 'no_index' };
  }

  const expectedFormula = await fetchRuntimeFormulaTag();
  if (expectedFormula) {
    console.log(`[resilience-scores] Runtime formula tag: ${expectedFormula}`);
  }

  console.log(`[resilience-scores] Reading cached scores for ${countryCodes.length} countries...`);

  const getCommands = countryCodes.map((c) => ['GET', `${RESILIENCE_SCORE_CACHE_PREFIX}${c}`]);
  const preResults = await redisPipeline(url, token, getCommands);
  const preWarmed = countCachedFromPipeline(preResults, expectedFormula);

  console.log(`[resilience-scores] ${preWarmed}/${countryCodes.length} scores pre-warmed`);

  const missing = countryCodes.length - preWarmed;
  if (missing > 0) {
    console.log(`[resilience-scores] Warming ${missing} missing via ranking endpoint...`);
    try {
      // ?refresh=1 MUST be set here. The ranking aggregate (12h TTL) routinely
      // outlives the per-country score keys (6h TTL), so in the post-6h /
      // pre-12h window the handler's cache-hit early-return would fire and
      // skip the whole warm path — scores would stay missing, coverage would
      // degrade, and only the per-country laggard fallback (or nothing, if
      // WM_KEY is absent) would recover. Forcing a recompute routes the call
      // through warmMissingResilienceScores and its chunked pipeline SET.
      const headers = { 'User-Agent': SEED_UA, 'Accept': 'application/json' };
      if (WM_REFRESH_KEY) headers['X-WorldMonitor-Key'] = WM_REFRESH_KEY;
      const resp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking?refresh=1`, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const ranked = data.items?.length ?? 0;
        const greyed = data.greyedOut?.length ?? 0;
        console.log(`[resilience-scores] Ranking: ${ranked} ranked, ${greyed} greyed out`);
      } else {
        console.warn(`[resilience-scores] Ranking endpoint returned ${resp.status}`);
      }
    } catch (err) {
      console.warn(`[resilience-scores] Ranking warmup failed (best-effort): ${err.message}`);
    }

    // Re-check which countries are still missing after bulk warmup
    const postResults = await redisPipeline(url, token, getCommands);
    const stillMissing = [];
    for (let i = 0; i < countryCodes.length; i++) {
      const raw = postResults[i]?.result ?? null;
      if (parseCachedScorePayload(raw, { expectedFormula }) == null) stillMissing.push(countryCodes[i]);
    }

    // Warm laggards individually (countries the bulk ranking timed out on)
    if (stillMissing.length > 0 && !WM_KEY) {
      console.warn(`[resilience-scores] ${stillMissing.length} laggards found but neither WORLDMONITOR_API_KEY nor WORLDMONITOR_VALID_KEYS is set — skipping individual warmup`);
    }
    let laggardsWarmed = 0;
    if (stillMissing.length > 0 && WM_KEY) {
      console.log(`[resilience-scores] Warming ${stillMissing.length} laggards individually...`);
      const BATCH = 5;
      for (let i = 0; i < stillMissing.length; i += BATCH) {
        const batch = stillMissing.slice(i, i + BATCH);
        const results = await Promise.allSettled(batch.map(async (cc) => {
          const scoreUrl = `${API_BASE}/api/resilience/v1/get-resilience-score?countryCode=${cc}`;
          const resp = await fetch(scoreUrl, {
            headers: { 'User-Agent': SEED_UA, 'Accept': 'application/json', 'X-WorldMonitor-Key': WM_KEY },
            signal: AbortSignal.timeout(30_000),
          });
          if (!resp.ok) throw new Error(`${cc}: HTTP ${resp.status}`);
          return cc;
        }));
        laggardsWarmed += results.filter(r => r.status === 'fulfilled').length;
      }
      console.log(`[resilience-scores] Laggards warmed: ${laggardsWarmed}/${stillMissing.length}`);
    }

    const finalResults = await redisPipeline(url, token, getCommands);
    const finalWarmed = countCachedFromPipeline(finalResults, expectedFormula);
    console.log(`[resilience-scores] Final: ${finalWarmed}/${countryCodes.length} cached`);

    const intervalResult = await computeAndWriteIntervals(url, token, countryCodes, finalResults, { expectedFormula });
    const rankingPresent = await refreshRankingAggregate({ url, token, laggardsWarmed });
    return {
      skipped: false,
      recordCount: finalWarmed,
      total: countryCodes.length,
      intervalsWritten: intervalResult.recordCount,
      intervalClampCount: intervalResult.diagnostics.activeScoreClampCount,
      intervalClampMaxDelta: intervalResult.diagnostics.activeScoreClampMaxDelta,
      intervalFormulaSkipCount: intervalResult.diagnostics.formulaSkipCount,
      intervalFormulaSkipSamples: intervalResult.diagnostics.formulaSkipSamples,
      intervalMissingScorePayloadCount: intervalResult.diagnostics.missingScorePayloadCount,
      intervalMissingScorePayloadSamples: intervalResult.diagnostics.missingScorePayloadSamples,
      intervalStaleScorePayloadCount: intervalResult.diagnostics.staleScorePayloadCount,
      intervalStaleScorePayloadSamples: intervalResult.diagnostics.staleScorePayloadSamples,
      intervalInvalidScorePayloadCount: intervalResult.diagnostics.invalidScorePayloadCount,
      intervalInvalidScorePayloadSamples: intervalResult.diagnostics.invalidScorePayloadSamples,
      intervalMalformedScorePayloadCount: intervalResult.diagnostics.malformedScorePayloadCount,
      intervalMalformedScorePayloadSamples: intervalResult.diagnostics.malformedScorePayloadSamples,
      intervalPayloadSkipCount: intervalResult.diagnostics.intervalPayloadSkipCount,
      intervalPayloadSkipSamples: intervalResult.diagnostics.intervalPayloadSkipSamples,
      rankingPresent,
    };
  }

  const intervalResult = await computeAndWriteIntervals(url, token, countryCodes, preResults, { expectedFormula });
  // Refresh the ranking aggregate on every cron, even when per-country
  // scores are still warm from the previous tick. Ranking has a 12h TTL vs
  // a 6h cron cadence — skipping the refresh when the key is still alive
  // would let it drift toward expiry without a rebuild, and a single missed
  // cron would then produce an EMPTY_ON_DEMAND gap before the next one runs.
  const rankingPresent = await refreshRankingAggregate({ url, token, laggardsWarmed: 0 });
  return {
    skipped: false,
    recordCount: preWarmed,
    total: countryCodes.length,
    intervalsWritten: intervalResult.recordCount,
    intervalClampCount: intervalResult.diagnostics.activeScoreClampCount,
    intervalClampMaxDelta: intervalResult.diagnostics.activeScoreClampMaxDelta,
    intervalFormulaSkipCount: intervalResult.diagnostics.formulaSkipCount,
    intervalFormulaSkipSamples: intervalResult.diagnostics.formulaSkipSamples,
    intervalMissingScorePayloadCount: intervalResult.diagnostics.missingScorePayloadCount,
    intervalMissingScorePayloadSamples: intervalResult.diagnostics.missingScorePayloadSamples,
    intervalStaleScorePayloadCount: intervalResult.diagnostics.staleScorePayloadCount,
    intervalStaleScorePayloadSamples: intervalResult.diagnostics.staleScorePayloadSamples,
    intervalInvalidScorePayloadCount: intervalResult.diagnostics.invalidScorePayloadCount,
    intervalInvalidScorePayloadSamples: intervalResult.diagnostics.invalidScorePayloadSamples,
    intervalMalformedScorePayloadCount: intervalResult.diagnostics.malformedScorePayloadCount,
    intervalMalformedScorePayloadSamples: intervalResult.diagnostics.malformedScorePayloadSamples,
    intervalPayloadSkipCount: intervalResult.diagnostics.intervalPayloadSkipCount,
    intervalPayloadSkipSamples: intervalResult.diagnostics.intervalPayloadSkipSamples,
    rankingPresent,
  };
}

// Trigger a ranking rebuild via the public endpoint EVERY cron, regardless of
// whether the current resilience:ranking key is still live at probe time. Short-circuiting
// on "key present" left a timing hole: if the key was written late in a prior
// run and the next cron fires early, the key is still alive at probe time →
// rebuild skipped → key expires a short while later and stays absent until a
// cron eventually runs when it's missing. One cheap HTTP per cron keeps both
// the ranking AND its sibling seed-meta rolling forward, and self-heals the
// partial-pipeline case where ranking was written but meta wasn't — handler
// retries the atomic pair on every cron.
//
// Returns whether the ranking key is present in Redis after the rebuild
// attempt (observability only — no caller gates on this).
async function refreshRankingAggregate({ url, token, laggardsWarmed }) {
  const reason = laggardsWarmed > 0 ? `${laggardsWarmed} laggard warms` : 'scheduled cron refresh';
  try {
    // ?refresh=1 tells the handler to skip its cache-hit early-return and
    // recompute-then-SET atomically. Avoids the earlier "DEL then rebuild"
    // flow where a failed rebuild would leave the ranking absent instead of
    // stale-but-present.
    const rebuildHeaders = { 'User-Agent': SEED_UA, 'Accept': 'application/json' };
    if (WM_REFRESH_KEY) rebuildHeaders['X-WorldMonitor-Key'] = WM_REFRESH_KEY;
    const rebuildResp = await fetch(`${API_BASE}/api/resilience/v1/get-resilience-ranking?refresh=1`, {
      headers: rebuildHeaders,
      signal: AbortSignal.timeout(60_000),
    });
    if (rebuildResp.ok) {
      const rebuilt = await rebuildResp.json();
      const total = (rebuilt.items?.length ?? 0) + (rebuilt.greyedOut?.length ?? 0);
      console.log(`[resilience-scores] Refreshed ${RESILIENCE_RANKING_CACHE_KEY} with ${total} countries (${reason})`);
    } else {
      console.warn(`[resilience-scores] Refresh ranking HTTP ${rebuildResp.status} — ranking cache stays at its prior state until next cron`);
    }
  } catch (err) {
    console.warn(`[resilience-scores] Failed to refresh ranking cache: ${err.message}`);
  }

  // Verify BOTH the ranking data key AND the seed-meta key. Upstash REST
  // pipeline is non-transactional: the handler's atomic SET could land the
  // ranking but miss the meta, leaving /api/health reading stale meta over a
  // fresh ranking. If the meta didn't land within ~5 minutes, log a warning
  // so ops can grep for it — next cron will retry (ranking SET is
  // idempotent).
  const [rankingLen, metaFresh] = await Promise.all([
    fetch(`${url}/strlen/${encodeURIComponent(RESILIENCE_RANKING_CACHE_KEY)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.ok ? r.json() : null).then((d) => Number(d?.result || 0)).catch(() => 0),
    fetch(`${url}/get/seed-meta:resilience:ranking`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.ok ? r.json() : null).then((d) => {
      if (!d?.result) return false;
      try {
        const meta = JSON.parse(d.result);
        return typeof meta?.fetchedAt === 'number' && (Date.now() - meta.fetchedAt) < 5 * 60 * 1000;
      } catch { return false; }
    }).catch(() => false),
  ]);
  const rankingPresent = rankingLen > 0;
  if (rankingPresent && !metaFresh) {
    console.warn(`[resilience-scores] Partial publish: ${RESILIENCE_RANKING_CACHE_KEY} present but seed-meta not fresh — next cron will retry (handler SET is idempotent)`);
  }
  return rankingPresent;
}

// The seeder does NOT write seed-meta:resilience:ranking. Previously it did,
// as a "heartbeat" when Pro traffic was quiet — but it could only attest to
// "recordCount of per-country scores", not to whether the current ranking key
// was actually published this cron. The ranking handler gates its SET on a
// 90% coverage threshold and skips both the ranking and its meta when the
// gate fails; a stale-but-present ranking key combined with a fresh seeder
// meta write was exactly the "meta says fresh, data is stale" failure mode
// this PR exists to eliminate. The handler is now the sole writer of meta,
// and it writes both keys atomically via the same pipeline only when coverage
// passes. refreshRankingAggregate() triggers the handler every cron so meta
// never goes silently stale during quiet Pro usage — which was the original
// reason the seeder meta write existed.

async function writeScoreSectionHeartbeat(result) {
  if (result?.skipped && result.reason === 'no_index') {
    console.warn('[resilience-scores] Skipping seed-meta:resilience:scores heartbeat because static index is empty');
    return;
  }

  try {
    await writeFreshnessMetadata(
      'resilience',
      'scores',
      result.recordCount ?? 0,
      '',
      RESILIENCE_SCORE_SECTION_META_TTL_SECONDS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[resilience-scores] Failed to write seed-meta:resilience:scores heartbeat: ${message}`);
  }
}

async function main() {
  const startedAt = Date.now();
  try {
    requireSeedRefreshKey();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logSeedResult('resilience:scores', 0, Date.now() - startedAt, {
      skipped: true,
      reason: 'missing_seed_refresh_key',
      error: message,
    });
    throw err;
  }

  const result = await seedResilienceScores();
  await writeScoreSectionHeartbeat(result);
  const { extra, intervalFailure, exitCode } = buildSeedResultLogExtra(result);
  logSeedResult('resilience:scores', result.recordCount ?? 0, Date.now() - startedAt, extra);
  if (intervalFailure) {
    console.error(`[resilience-scores] ${intervalFailure.message}`);
    process.exitCode = exitCode;
  }
  if (!result.skipped && (result.recordCount ?? 0) > 0 && !result.rankingPresent) {
    // Observability only — seeder never writes seed-meta. Health will flag the
    // stale meta on its own if this persists across multiple cron ticks.
    console.warn(`[resilience-scores] ${RESILIENCE_RANKING_CACHE_KEY} absent after rebuild attempt; handler-side coverage gate likely tripped. Next cron will retry.`);
  }
}

if (process.argv[1]?.endsWith('seed-resilience-scores.mjs')) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`FATAL: ${message}`);
    process.exit(1);
  });
}
