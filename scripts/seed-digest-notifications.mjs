#!/usr/bin/env node
/**
 * Digest notification cron — Railway scheduled job, runs every 30 minutes.
 *
 * For each enabled alert rule with digestMode != "realtime":
 *   1. Checks isDue() against digest:last-sent:v1:${userId}:${variant}
 *   2. ZRANGEBYSCORE digest:accumulator:v1:${variant} to get stories in window
 *   3. Batch HGETALL story:track:v1:${hash} for metadata
 *   4. Derives phase, filters fading/non-matching severity, sorts by currentScore
 *   5. SMEMBERS story:sources:v1:${hash} for source attribution
 *   6. Formats and dispatches to each configured channel
 *   7. Updates digest:last-sent:v1:${userId}:${variant}
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import {
  escapeHtml,
  escapeTelegramHtml,
  escapeSlackMrkdwn,
  markdownToTelegramHtml,
  markdownToSlackMrkdwn,
  markdownToDiscord,
} from './_digest-markdown.mjs';

const require = createRequire(import.meta.url);
const { decrypt } = require('./lib/crypto.cjs');
const { callLLM } = require('./lib/llm-chain.cjs');
const { fetchUserPreferences, extractUserContext, formatUserProfile } = require('./lib/user-context.cjs');
const { Resend } = require('resend');
const { normalizeResendSender } = require('./lib/resend-from.cjs');
import { readRawJsonFromUpstash, redisPipeline } from '../api/_upstash-json.js';
import {
  composeBriefFromDigestStories,
  compareRules,
  extractInsights,
  groupEligibleRulesByUser,
  MAX_STORIES_PER_USER,
  shouldExitNonZero as shouldExitOnBriefFailures,
} from './lib/brief-compose.mjs';
import {
  digestWindowStartMs,
  pickWinningCandidateWithPool,
  readTimeAgeCutoffMs,
  runSynthesisWithFallback,
  selectCanonicalSendRule,
  shouldDropTrackByAge,
  subjectForBrief,
} from './lib/digest-orchestration-helpers.mjs';
import { injectEmailSummary } from './lib/email-summary-html.mjs';
import { issueSlotInTz } from '../shared/brief-filter.js';
import {
  enrichBriefEnvelopeWithLLM,
  generateDigestProse,
  generateDigestProsePublic,
  greetingBucket,
} from './lib/brief-llm.mjs';
import { parseDigestOnlyUser } from './lib/digest-only-user.mjs';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';
import { signBriefUrl, BriefUrlError } from './lib/brief-url-sign.mjs';
import {
  deduplicateStories,
  groupTopicsPostDedup,
  readOrchestratorConfig,
} from './lib/brief-dedup.mjs';
import { stripSourceSuffix } from './lib/brief-dedup-jaccard.mjs';
import { writeReplayLog } from './lib/brief-dedup-replay-log.mjs';
import { readStoryTracksChunked } from './lib/story-track-batch-reader.mjs';
import {
  aggregateResults as aggregateDeliveredResults,
  writeDeliveredEntry,
} from './lib/digest-delivered-log.mjs';
import { readCooldownConfig } from './lib/digest-cooldown-config.mjs';
import { evaluateCooldown } from './lib/digest-cooldown-decision.mjs';
import { emitCooldownShadowLog } from './lib/digest-cooldown-shadow-log.mjs';

// ── Config ────────────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
// Brief/digest is an editorial daily read, not an incident alarm — route it
// off the `alerts@` mailbox so recipients don't see a scary "alert" from-name
// in their inbox. normalizeResendSender coerces a bare email address into a
// "Name <addr>" wrapper at runtime (with a loud warning), so a Railway env
// like `RESEND_FROM_BRIEF=brief@worldmonitor.app` can't re-introduce the bug
// that `.env.example` documents.
const RESEND_FROM =
  normalizeResendSender(
    process.env.RESEND_FROM_BRIEF ?? process.env.RESEND_FROM_EMAIL,
    'WorldMonitor Brief',
  ) ?? 'WorldMonitor Brief <brief@worldmonitor.app>';

if (process.env.DIGEST_CRON_ENABLED === '0') {
  console.log('[digest] DIGEST_CRON_ENABLED=0 — skipping run');
  process.exit(0);
}

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('[digest] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set');
  process.exit(1);
}
if (!CONVEX_SITE_URL || !RELAY_SECRET) {
  console.error('[digest] CONVEX_SITE_URL / RELAY_SHARED_SECRET not set');
  process.exit(1);
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

const DIGEST_MAX_ITEMS = 30;
const DIGEST_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24h default lookback on first send
const DIGEST_CRITICAL_LIMIT = Infinity;
const DIGEST_HIGH_LIMIT = 15;
const DIGEST_MEDIUM_LIMIT = 10;
const AI_DIGEST_ENABLED = process.env.AI_DIGEST_ENABLED !== '0';
const ENTITLEMENT_CACHE_TTL = 900; // 15 min

// Absolute importance-score floor applied to the digest AFTER dedup.
// Mirrors the realtime notification-relay gate (IMPORTANCE_SCORE_MIN)
// but lives on the brief/digest side so operators can tune them
// independently — e.g. let realtime page at score>=63 while the brief
// digest drops anything <50. Default 0 = no filtering; ship disabled
// so this PR is a no-op until Railway flips the env. Setting the var
// to any positive integer drops every cluster whose representative
// currentScore is below it.
function getDigestScoreMin() {
  const raw = Number.parseInt(process.env.DIGEST_SCORE_MIN ?? '0', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

// ── Brief composer (consolidation of the retired seed-brief-composer) ──────

const BRIEF_URL_SIGNING_SECRET = process.env.BRIEF_URL_SIGNING_SECRET ?? '';
const WORLDMONITOR_PUBLIC_BASE_URL =
  process.env.WORLDMONITOR_PUBLIC_BASE_URL ?? 'https://worldmonitor.app';
const BRIEF_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
// Brief story window: derived per-rule from the rule's lastSentAt via
// digestWindowStartMs, identical to the send-loop window. The previous
// fixed-24h constant decoupled the canonical brief lead from the
// stories the email/Slack body actually shipped, reintroducing the
// cross-surface divergence the canonical-brain refactor is designed to
// eliminate (especially severe for weekly users — 7d email body vs 24h
// lead).
const INSIGHTS_KEY = 'news:insights:v1';

// Operator kill switch — used to intentionally silence brief compose
// without surfacing a Railway red flag. Distinguished from "secret
// missing in a production rollout" which IS worth flagging.
const BRIEF_COMPOSE_DISABLED_BY_OPERATOR = process.env.BRIEF_COMPOSE_ENABLED === '0';
const BRIEF_COMPOSE_ENABLED =
  !BRIEF_COMPOSE_DISABLED_BY_OPERATOR && BRIEF_URL_SIGNING_SECRET !== '';
const BRIEF_SIGNING_SECRET_MISSING =
  !BRIEF_COMPOSE_DISABLED_BY_OPERATOR && BRIEF_URL_SIGNING_SECRET === '';

// Phase 3b LLM enrichment. Kept separate from AI_DIGEST_ENABLED so
// the email-digest AI summary and the brief editorial prose can be
// toggled independently (e.g. kill the brief LLM without silencing
// the email's AI summary during a provider outage).
const BRIEF_LLM_ENABLED = process.env.BRIEF_LLM_ENABLED !== '0';

// Phase 3c — analyst-backed whyMatters enrichment via an internal Vercel
// edge endpoint. When the endpoint is reachable + returns a string, it
// takes priority over the direct-Gemini path. On any failure the cron
// falls through to its existing Gemini cache+LLM chain. Env override
// lets local dev point at a preview deployment or `localhost:3000`.
const BRIEF_WHY_MATTERS_ENDPOINT_URL =
  process.env.BRIEF_WHY_MATTERS_ENDPOINT_URL ??
  `${WORLDMONITOR_PUBLIC_BASE_URL}/api/internal/brief-why-matters`;

/**
 * Lowercase + collapse whitespace to mirror extractor-side gate in
 * server/worldmonitor/news/v1/list-feed-digest.ts
 * (normalizeForDescriptionEquality). Duplicated (not imported) because
 * that module is .ts on a different loader path; a shared .mjs helper
 * would be a cleaner home if more surfaces adopt this check.
 */
function normalizeForDescriptionEquality(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * POST one story to the analyst whyMatters endpoint. Returns the
 * string on success, null on any failure (auth, non-200, parse error,
 * timeout, missing value). The cron's `generateWhyMatters` is
 * responsible for falling through to the direct-Gemini path on null.
 *
 * Ground-truth signal: logs `source` (cache|analyst|gemini) and
 * `producedBy` (analyst|gemini|null) at the call site so the cron's
 * log stream has a forensic trail of which path actually produced each
 * story's whyMatters — needed for shadow-diff review and for the
 * "stop writing v2" decision once analyst coverage is proven.
 * (See feedback_gate_on_ground_truth_not_configured_state.md.)
 */
async function callAnalystWhyMatters(story) {
  if (!RELAY_SECRET) return null;
  // Forward a trimmed story payload so the endpoint only sees the
  // fields it validates. `description` is NEW for prompt-v2 — when
  // upstream has a real one (falls back to headline via
  // shared/brief-filter.js:134), it gives the LLM a grounded sentence
  // beyond the headline. Skip when it equals the headline (no signal).
  const payload = {
    headline: story.headline ?? '',
    source: story.source ?? '',
    threatLevel: story.threatLevel ?? '',
    category: story.category ?? '',
    country: story.country ?? '',
  };
  if (
    typeof story.description === 'string' &&
    story.description.length > 0 &&
    // Normalize-equality (case + whitespace) mirrors the extractor-side gate
    // in list-feed-digest.ts (normalizeForDescriptionEquality) so a feed
    // whose description only differs from the headline by casing/spacing
    // doesn't leak as "grounding" content here.
    normalizeForDescriptionEquality(story.description) !==
      normalizeForDescriptionEquality(story.headline ?? '')
  ) {
    payload.description = story.description;
  }
  try {
    const resp = await fetch(BRIEF_WHY_MATTERS_ENDPOINT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        'Content-Type': 'application/json',
        // Explicit UA — Node undici's default is short/empty enough to
        // trip middleware.ts's "No user-agent or suspiciously short"
        // 403 path. Defense-in-depth alongside the PUBLIC_API_PATHS
        // allowlist. Distinct from ops curl / UptimeRobot so log grep
        // disambiguates cron traffic from operator traffic.
        'User-Agent': 'worldmonitor-digest-notifications/1.0',
        Accept: 'application/json',
      },
      body: JSON.stringify({ story: payload }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`[digest] brief-why-matters endpoint HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    if (!data || typeof data.whyMatters !== 'string') return null;
    // Emit the ground-truth provenance at the call site. `source` tells
    // us cache vs. live; `producedBy` tells us which LLM wrote the
    // string (or the cached value's original producer on cache hits).
    const src = typeof data.source === 'string' ? data.source : 'unknown';
    const producedBy = typeof data.producedBy === 'string' ? data.producedBy : 'unknown';
    console.log(
      `[brief-llm] whyMatters source=${src} producedBy=${producedBy} hash=${data.hash ?? 'n/a'}`,
    );
    return data.whyMatters;
  } catch (err) {
    console.warn(
      `[digest] brief-why-matters endpoint call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// Dependencies injected into brief-llm.mjs. Defined near the top so
// the upstashRest helper below is in scope when this closure runs
// inside composeAndStoreBriefForUser().
const briefLlmDeps = {
  callLLM,
  callAnalystWhyMatters,
  async cacheGet(key) {
    const raw = await upstashRest('GET', key);
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  async cacheSet(key, value, ttlSec) {
    await upstashRest('SETEX', key, String(ttlSec), JSON.stringify(value));
  },
};

// ── Redis helpers ──────────────────────────────────────────────────────────────

async function upstashRest(...args) {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'User-Agent': 'worldmonitor-digest/1.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    console.warn(`[digest] Upstash error ${res.status} for command ${args[0]}`);
    return null;
  }
  const json = await res.json();
  return json.result;
}

async function upstashPipeline(commands) {
  if (commands.length === 0) return [];
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'worldmonitor-digest/1.0',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.warn(`[digest] pipeline error ${res.status}`);
    return [];
  }
  return res.json();
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

function toLocalHour(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(nowMs));
    const hourPart = parts.find((p) => p.type === 'hour');
    return hourPart ? parseInt(hourPart.value, 10) : -1;
  } catch {
    return -1;
  }
}

/**
 * Read digest:last-sent:v1:{userId}:{variant} from Upstash. Returns
 * null on miss / parse error / network hiccup so the caller can treat
 * "first send" and "transient lookup failure" the same way (both fall
 * through to isDue's `lastSentAt === null` branch). Extracted so the
 * compose-flow's per-rule annotation pass and the send loop can share
 * one source of truth — Codex Round-3 High #1 + Round-4 fixes.
 *
 * @param {{ userId: string; variant?: string }} rule
 * @returns {Promise<number | null>}
 */
async function getLastSentAt(rule) {
  if (!rule?.userId || !rule.variant) return null;
  const key = `digest:last-sent:v1:${rule.userId}:${rule.variant}`;
  try {
    const raw = await upstashRest('GET', key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed.sentAt === 'number' ? parsed.sentAt : null;
  } catch {
    return null;
  }
}

/**
 * Build the synthesis context (profile, greeting) for the canonical
 * synthesis call. profile is the formatted user-context line block;
 * greeting is the time-of-day-appropriate opener. Both are stripped
 * by `generateDigestProsePublic` for the share-URL surface; this
 * function is for the personalised path only.
 *
 * Defensive: prefs lookup failures degrade to a non-personalised
 * synthesis (profile=null) rather than blocking the brief — same
 * pattern the legacy generateAISummary used.
 *
 * @param {{ userId: string; variant?: string; digestTimezone?: string }} rule
 * @param {number} nowMs
 * @returns {Promise<{ profile: string | null; greeting: string | null }>}
 */
async function buildSynthesisCtx(rule, nowMs) {
  if (!rule?.userId) return { profile: null, greeting: null };
  let profile = null;
  try {
    const { data: prefs } = await fetchUserPreferences(rule.userId, rule.variant ?? 'full');
    if (prefs) {
      const ctx = extractUserContext(prefs);
      profile = formatUserProfile(ctx, rule.variant ?? 'full');
    }
  } catch {
    /* prefs unavailable — degrade to non-personalised */
  }
  const tz = rule.digestTimezone ?? 'UTC';
  const localHour = toLocalHour(nowMs, tz);
  const greeting = localHour >= 5 && localHour < 12 ? 'Good morning'
    : localHour >= 12 && localHour < 17 ? 'Good afternoon'
    : localHour >= 17 && localHour < 22 ? 'Good evening'
    : 'Good evening';
  return { profile, greeting };
}

function isDue(rule, lastSentAt) {
  const nowMs = Date.now();
  const tz = rule.digestTimezone ?? 'UTC';
  const primaryHour = rule.digestHour ?? 8;
  const localHour = toLocalHour(nowMs, tz);
  const hourMatches = rule.digestMode === 'twice_daily'
    ? localHour === primaryHour || localHour === (primaryHour + 12) % 24
    : localHour === primaryHour;
  if (!hourMatches) return false;
  if (lastSentAt === null) return true;
  const minIntervalMs =
    rule.digestMode === 'daily'        ? 23 * 3600000
    : rule.digestMode === 'twice_daily' ? 11 * 3600000
    : rule.digestMode === 'weekly'      ? 6.5 * 24 * 3600000
    : 0;
  return (nowMs - lastSentAt) >= minIntervalMs;
}

// ── Story helpers ─────────────────────────────────────────────────────────────

function flatArrayToObject(flat) {
  const obj = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

function derivePhase(track) {
  const mentionCount = parseInt(track.mentionCount ?? '1', 10);
  const firstSeen = parseInt(track.firstSeen ?? '0', 10);
  const lastSeen = parseInt(track.lastSeen ?? String(Date.now()), 10);
  const now = Date.now();
  const ageH = (now - firstSeen) / 3600000;
  const silenceH = (now - lastSeen) / 3600000;
  if (silenceH > 24) return 'fading';
  if (mentionCount >= 3 && ageH >= 12) return 'sustained';
  if (mentionCount >= 2) return 'developing';
  if (ageH < 2) return 'breaking';
  return 'unknown';
}

function matchesSensitivity(ruleSensitivity, severity) {
  if (ruleSensitivity === 'all') return true;
  if (ruleSensitivity === 'high') return severity === 'high' || severity === 'critical';
  return severity === 'critical';
}

// ── Digest content ────────────────────────────────────────────────────────────

// Dedup lives in scripts/lib/brief-dedup.mjs (orchestrator) with the
// legacy Jaccard in scripts/lib/brief-dedup-jaccard.mjs. The orchestrator
// reads DIGEST_DEDUP_MODE at call time — default 'jaccard' keeps
// behaviour identical to pre-embedding production. stripSourceSuffix
// is imported from the Jaccard module so the text/HTML formatters
// below keep their current per-story title cleanup.

async function buildDigest(rule, windowStartMs) {
  const variant = rule.variant ?? 'full';
  const lang = rule.lang ?? 'en';
  const accKey = `digest:accumulator:v1:${variant}:${lang}`;

  const hashes = await upstashRest(
    'ZRANGEBYSCORE', accKey, String(windowStartMs), String(Date.now()),
  );
  if (!Array.isArray(hashes) || hashes.length === 0) return null;

  // null = at least one HGETALL chunk failed. Returning null here
  // matches the legacy semantic (single-pipeline failure produced
  // an empty story list → null buildDigest result → cron skipped
  // sending the digest for this user/variant). The alternative —
  // shipping a digest built from only the successfully-fetched
  // chunks — would silently drop stories AND mark the slot as sent,
  // suppressing retry on the next tick. See:
  //   scripts/lib/story-track-batch-reader.mjs (bail-on-failure rationale).
  const trackResults = await readStoryTracksChunked(hashes, upstashPipeline);
  if (trackResults === null) return null;

  // READ-time freshness cutoff is anchored to the rule's own digest
  // window. Daily user (24h window) → 48h cutoff; weekly user (7d
  // window) → 8d cutoff. See: skill ingest-gate-tightening-leaves-
  // residue-in-read-path. Legacy rows without publishedAt fall through
  // (back-compat); pre-deploy residue with no publishedAt is handled
  // by audit --mode=residue (one-shot).
  const ageCutoffMs = readTimeAgeCutoffMs(windowStartMs);

  const stories = [];
  let droppedStaleAtRead = 0;
  for (let i = 0; i < hashes.length; i++) {
    const raw = trackResults[i]?.result;
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const track = flatArrayToObject(raw);
    if (!track.title || !track.severity) continue;

    if (shouldDropTrackByAge(track, ageCutoffMs)) {
      droppedStaleAtRead++;
      continue;
    }

    const phase = derivePhase(track);
    if (phase === 'fading') continue;
    if (!matchesSensitivity(rule.sensitivity ?? 'high', track.severity)) continue;

    stories.push({
      hash: hashes[i],
      title: track.title,
      link: track.link ?? '',
      severity: track.severity,
      currentScore: parseInt(track.currentScore ?? '0', 10),
      mentionCount: parseInt(track.mentionCount ?? '1', 10),
      phase,
      sources: [],
      // Cleaned RSS description from list-feed-digest's parseRssXml; empty
      // on old story:track rows (pre-fix, 48h bleed) and feeds without a
      // description. Downstream adapter falls back to the cleaned headline.
      description: typeof track.description === 'string' ? track.description : '',
    });
  }

  if (droppedStaleAtRead > 0) {
    const cutoffH = Math.round((Date.now() - ageCutoffMs) / (60 * 60 * 1000));
    console.warn(
      `[digest] buildDigest read-time freshness floor dropped ${droppedStaleAtRead} ` +
        `stale items (window cutoff: ${cutoffH}h ago) — likely pre-deploy residue`,
    );
  }

  if (stories.length === 0) return null;

  stories.sort((a, b) => b.currentScore - a.currentScore);
  const cfg = readOrchestratorConfig(process.env);
  // Sample tsMs BEFORE dedup so briefTickId anchors to tick-start, not
  // to dedup-completion. Dedup can take a few seconds on cold-cache
  // embed calls; we want the replay log's tick id to reflect when the
  // tick began processing, which is the natural reading of
  // "briefTickId" for downstream readers.
  const tsMs = Date.now();
  const { reps: dedupedAll, embeddingByHash, logSummary } =
    await deduplicateStories(stories);
  // Replay log (opt-in via DIGEST_DEDUP_REPLAY_LOG=1). Best-effort — any
  // failure is swallowed by writeReplayLog. Runs AFTER dedup so the log
  // captures the real rep + cluster assignments. RuleId omits userId on
  // purpose: dedup input is shared across users of the same (variant,
  // lang, sensitivity), and we don't want user identity in log keys.
  // See docs/brainstorms/2026-04-23-001-brief-dedup-recall-gap.md §5 Phase 1.
  //
  // AWAITED on purpose: this script exits via explicit process.exit(1)
  // on the brief-compose failure gate (~line 1539) and on main().catch
  // (~line 1545). process.exit does NOT drain in-flight promises like
  // natural exit does, so a `void` call here would silently drop the
  // last N ticks' replay records — exactly the runs where measurement
  // fidelity matters most. writeReplayLog has its own internal try/
  // catch + early return when the flag is off, so awaiting is free on
  // the disabled path and bounded by the 10s Upstash pipeline timeout
  // on the enabled path.
  // Codex PR #3617 P1 — hydrate sources on `dedupedAll` BEFORE
  // writeReplayLog so the replay records carry the canonical source
  // count Sprint 1 / U6 needs to evaluate +5-evolution bypasses. The
  // pre-fix order wrote replay records with `sources: []` (hydration
  // happened later, only on the post-cap `top` slice), which made U6
  // structurally unable to detect source-count evolution.
  //
  // Implementation: run SMEMBERS for every rep's mergedHashes BEFORE
  // the replay-log write. `top` (built later as a slice of dedupedAll)
  // shares object references with the reps we're hydrating here, so the
  // later "hydrate top.sources" block becomes a no-op and is removed
  // below. Cost: one Upstash pipeline with ~30 SMEMBERS commands per
  // tick — bounded by the dedup output size (typically 20-30 reps).
  {
    const preCmds = [];
    const preIdx = [];
    for (let i = 0; i < dedupedAll.length; i++) {
      dedupedAll[i].sources = [];
      const hashes = Array.isArray(dedupedAll[i].mergedHashes)
        ? dedupedAll[i].mergedHashes
        : [dedupedAll[i].hash];
      for (const h of hashes) {
        if (typeof h === 'string' && h.length > 0) {
          preCmds.push(['SMEMBERS', `story:sources:v1:${h}`]);
          preIdx.push(i);
        }
      }
    }
    if (preCmds.length > 0) {
      try {
        const preResults = await upstashPipeline(preCmds);
        for (let j = 0; j < preResults.length; j++) {
          const arr = preResults[j]?.result ?? [];
          const target = dedupedAll[preIdx[j]];
          for (const src of arr) {
            if (!target.sources.includes(src)) target.sources.push(src);
          }
        }
      } catch (err) {
        // Best-effort: if the source pipeline fails, replay-log carries
        // empty source arrays (the pre-fix shape). Cooldown evolution
        // bypass goes blind for that tick — preferable to crashing the
        // cron over a non-load-bearing diagnostic write.
        console.warn(
          `[digest] U6 pre-hydrate sources failed: ${err?.message ?? err} — replay records will carry empty sources for this tick`,
        );
      }
    }
  }
  const ruleKey = `${variant}:${lang}:${rule.sensitivity ?? 'high'}`;
  await writeReplayLog({
    stories,
    reps: dedupedAll,
    embeddingByHash,
    cfg,
    tickContext: {
      briefTickId: `${ruleKey}:${tsMs}`,
      ruleId: ruleKey,
      tsMs,
    },
  });
  // Apply the absolute-score floor AFTER dedup so the floor runs on
  // the representative's score (mentionCount-sum doesn't change the
  // score field; the rep is the highest-scoring member of its
  // cluster). At DIGEST_SCORE_MIN=0 this is a no-op.
  const scoreFloor = getDigestScoreMin();
  const deduped = scoreFloor > 0
    ? dedupedAll.filter((s) => Number(s.currentScore ?? 0) >= scoreFloor)
    : dedupedAll;
  if (scoreFloor > 0 && dedupedAll.length !== deduped.length) {
    console.log(
      `[digest] score floor dropped ${dedupedAll.length - deduped.length} ` +
        `of ${dedupedAll.length} clusters (DIGEST_SCORE_MIN=${scoreFloor})`,
    );
  }
  // If the floor drained every cluster, return null with a distinct
  // log line so operators can tell "floor too high" apart from "no
  // stories in window" (the caller treats both as a skip but the
  // root causes are different — without this line the main-loop
  // "No stories in window" message never fires because [] is truthy
  // and silences the diagnostic at the caller's guard).
  if (deduped.length === 0) {
    if (scoreFloor > 0 && dedupedAll.length > 0) {
      console.log(
        `[digest] score floor dropped ALL ${dedupedAll.length} clusters ` +
          `(DIGEST_SCORE_MIN=${scoreFloor}) — skipping user`,
      );
    }
    return null;
  }
  const sliced = deduped.slice(0, DIGEST_MAX_ITEMS);

  // Secondary topic-grouping pass: re-orders `sliced` so related stories
  // form contiguous blocks. Disabled via DIGEST_DEDUP_TOPIC_GROUPING=0.
  // Gate on the sidecar Map being non-empty — this is the precise
  // signal for "primary embed path produced vectors". Gating on
  // cfg.mode is WRONG: the embed path can run AND fall back to
  // Jaccard at runtime (try/catch inside deduplicateStories), leaving
  // cfg.mode==='embed' but embeddingByHash empty. The Map size is the
  // only ground truth. Kill-switch (mode=jaccard) and runtime fallback
  // both produce size=0 → shouldGroupTopics=false → no misleading
  // "topic grouping failed: missing embedding" warn.
  // Errors from the helper are returned (not thrown) and MUST NOT
  // cascade into the outer Jaccard fallback — they just preserve
  // primary order.
  const shouldGroupTopics = cfg.topicGroupingEnabled && embeddingByHash.size > 0;
  const { reps: top, topicCount, error: topicErr } = shouldGroupTopics
    ? groupTopicsPostDedup(sliced, cfg, embeddingByHash)
    : { reps: sliced, topicCount: sliced.length, error: null };
  if (topicErr) {
    console.warn(
      `[digest] topic grouping failed, preserving primary order: ${topicErr.message}`,
    );
  }
  if (logSummary) {
    const finalLog =
      shouldGroupTopics && !topicErr
        ? logSummary.replace(
            /clusters=(\d+) /,
            `clusters=$1 topics=${topicCount} `,
          )
        : logSummary;
    console.log(finalLog);
  }

  // Codex PR #3617 P1 — sources are already hydrated on `dedupedAll`
  // BEFORE the writeReplayLog call above (so U6 replay records carry
  // canonical source counts). `top` items are references to the same
  // objects, so they already have `sources` populated. The redundant
  // hydration block that lived here pre-fix has been removed; it would
  // have RESET (top[i].sources = []) and re-fetched, doubling the
  // SMEMBERS pipeline cost per tick for no functional benefit.

  return top;
}

function formatDigest(stories, nowMs) {
  if (!stories || stories.length === 0) return null;
  const dateStr = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(nowMs));

  const lines = [`WorldMonitor Daily Digest — ${dateStr}`, ''];

  const buckets = { critical: [], high: [], medium: [] };
  for (const s of stories) {
    const b = buckets[s.severity] ?? buckets.high;
    b.push(s);
  }

  const SEVERITY_LIMITS = { critical: DIGEST_CRITICAL_LIMIT, high: DIGEST_HIGH_LIMIT, medium: DIGEST_MEDIUM_LIMIT };

  for (const [level, items] of Object.entries(buckets)) {
    if (items.length === 0) continue;
    const limit = SEVERITY_LIMITS[level] ?? DIGEST_MEDIUM_LIMIT;
    lines.push(`${level.toUpperCase()} (${items.length} event${items.length !== 1 ? 's' : ''})`);
    for (const item of items.slice(0, limit)) {
      const src = item.sources.length > 0
        ? ` [${item.sources.slice(0, 3).join(', ')}${item.sources.length > 3 ? ` +${item.sources.length - 3}` : ''}]`
        : '';
      lines.push(`  \u2022 ${stripSourceSuffix(item.title)}${src}`);
      // Append the RSS description as a short context line when upstream
      // persisted one. Truncated at a word boundary to ~200 chars to keep
      // the plain-text email terse. Empty \u2192 no context line (R6).
      if (typeof item.description === 'string' && item.description.length > 0) {
        const trimmed = item.description.length > 200
          ? item.description.slice(0, 200).replace(/\s+\S*$/, '') + '\u2026'
          : item.description;
        lines.push(`    ${trimmed}`);
      }
    }
    if (items.length > limit) lines.push(`  ... and ${items.length - limit} more`);
    lines.push('');
  }

  lines.push('View full dashboard \u2192 worldmonitor.app');
  return lines.join('\n');
}

function formatDigestHtml(stories, nowMs) {
  if (!stories || stories.length === 0) return null;
  const dateStr = new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(nowMs));

  const buckets = { critical: [], high: [], medium: [] };
  for (const s of stories) {
    const b = buckets[s.severity] ?? buckets.high;
    b.push(s);
  }

  const totalCount = stories.length;
  const criticalCount = buckets.critical.length;
  const highCount = buckets.high.length;

  const SEVERITY_BORDER = { critical: '#ef4444', high: '#f97316', medium: '#eab308' };
  const PHASE_COLOR = { breaking: '#ef4444', developing: '#f97316', sustained: '#60a5fa', fading: '#555' };

  function storyCard(s) {
    const borderColor = SEVERITY_BORDER[s.severity] ?? '#4ade80';
    const phaseColor = PHASE_COLOR[s.phase] ?? '#888';
    const phaseCap = s.phase ? s.phase.charAt(0).toUpperCase() + s.phase.slice(1) : '';
    const srcText = s.sources.length > 0
      ? s.sources.slice(0, 3).join(', ') + (s.sources.length > 3 ? ` +${s.sources.length - 3}` : '')
      : '';
    const cleanTitle = stripSourceSuffix(s.title);
    const titleEl = s.link
      ? `<a href="${escapeHtml(s.link)}" style="color: #e0e0e0; text-decoration: none; font-size: 14px; font-weight: 600; line-height: 1.4;">${escapeHtml(cleanTitle)}</a>`
      : `<span style="color: #e0e0e0; font-size: 14px; font-weight: 600; line-height: 1.4;">${escapeHtml(cleanTitle)}</span>`;
    // RSS description: truncated ~200 chars at a word boundary, rendered
    // between title and meta when present. Empty → section omitted (R6).
    let snippetEl = '';
    if (typeof s.description === 'string' && s.description.length > 0) {
      const trimmed = s.description.length > 200
        ? s.description.slice(0, 200).replace(/\s+\S*$/, '') + '…'
        : s.description;
      snippetEl = `<div style="margin-top: 6px; font-size: 12px; color: #999; line-height: 1.45;">${escapeHtml(trimmed)}</div>`;
    }
    const meta = [
      phaseCap ? `<span style="font-size: 10px; color: ${phaseColor}; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">${phaseCap}</span>` : '',
      srcText ? `<span style="font-size: 11px; color: #555;">${escapeHtml(srcText)}</span>` : '',
    ].filter(Boolean).join('<span style="color: #333; margin: 0 6px;">&bull;</span>');
    return `<div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${borderColor}; padding: 12px 16px; margin-bottom: 8px;">${titleEl}${snippetEl}${meta ? `<div style="margin-top: 6px;">${meta}</div>` : ''}</div>`;
  }

  const SEVERITY_LIMITS = { critical: DIGEST_CRITICAL_LIMIT, high: DIGEST_HIGH_LIMIT, medium: DIGEST_MEDIUM_LIMIT };

  function sectionHtml(severity, items) {
    if (items.length === 0) return '';
    const limit = SEVERITY_LIMITS[severity] ?? DIGEST_MEDIUM_LIMIT;
    const SEVERITY_LABEL = { critical: '&#128308; Critical', high: '&#128992; High', medium: '&#128993; Medium' };
    const label = SEVERITY_LABEL[severity] ?? severity.toUpperCase();
    const cards = items.slice(0, limit).map(storyCard).join('');
    const overflow = items.length > limit
      ? `<p style="font-size: 12px; color: #555; margin: 4px 0 16px; padding-left: 4px;">... and ${items.length - limit} more</p>`
      : '';
    return `<div style="margin-bottom: 24px;"><div style="font-size: 11px; font-weight: 700; color: #888; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px;">${label} (${items.length})</div>${cards}${overflow}</div>`;
  }

  const sectionsHtml = ['critical', 'high', 'medium']
    .map((sev) => sectionHtml(sev, buckets[sev]))
    .join('');

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111; color: #e0e0e0;">
  <div style="max-width: 680px; margin: 0 auto;">
    <div style="background: #4ade80; height: 3px;"></div>
    <div style="background: #0d0d0d; padding: 32px 36px 0;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 28px;">
        <tr>
          <td style="vertical-align: middle;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="width: 36px; height: 36px; vertical-align: middle;">
                  <img src="https://www.worldmonitor.app/favico/android-chrome-192x192.png" width="36" height="36" alt="WorldMonitor" style="border-radius: 50%; display: block;" />
                </td>
                <td style="padding-left: 10px;">
                  <div style="font-size: 15px; font-weight: 800; color: #fff; letter-spacing: -0.3px;">WORLD MONITOR</div>
                </td>
              </tr>
            </table>
          </td>
          <td style="text-align: right; vertical-align: middle;">
            <span style="font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 1px;">${dateStr}</span>
          </td>
        </tr>
      </table>
      <div data-ai-summary-slot></div>
      <div data-brief-cta-slot></div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 24px;">
        <tr>
          <td style="text-align: center; padding: 14px 8px; width: 33%; background: #161616; border: 1px solid #222;">
            <div style="font-size: 24px; font-weight: 800; color: #4ade80;">${totalCount}</div>
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 2px;">Events</div>
          </td>
          <td style="width: 1px;"></td>
          <td style="text-align: center; padding: 14px 8px; width: 33%; background: #161616; border: 1px solid #222;">
            <div style="font-size: 24px; font-weight: 800; color: #ef4444;">${criticalCount}</div>
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 2px;">Critical</div>
          </td>
          <td style="width: 1px;"></td>
          <td style="text-align: center; padding: 14px 8px; width: 33%; background: #161616; border: 1px solid #222;">
            <div style="font-size: 24px; font-weight: 800; color: #f97316;">${highCount}</div>
            <div style="font-size: 9px; color: #666; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 2px;">High</div>
          </td>
        </tr>
      </table>
      ${sectionsHtml}
      <div style="text-align: center; padding: 12px 0 36px;">
        <a href="https://worldmonitor.app" style="display: inline-block; background: #4ade80; color: #0a0a0a; padding: 12px 32px; text-decoration: none; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; border-radius: 3px;">Open Dashboard</a>
      </div>
    </div>
    <div style="background: #0a0a0a; border-top: 1px solid #1a1a1a; padding: 20px 36px; text-align: center;">
      <div style="margin-bottom: 12px;">
        <a href="https://x.com/worldmonitorapp" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">X / Twitter</a>
        <a href="https://github.com/koala73/worldmonitor" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">GitHub</a>
        <a href="https://discord.gg/re63kWKxaz" style="color: #555; text-decoration: none; font-size: 11px; margin: 0 10px;">Discord</a>
      </div>
      <p style="font-size: 10px; color: #444; margin: 0; line-height: 1.5;">
        <a href="https://worldmonitor.app" style="color: #4ade80; text-decoration: none;">worldmonitor.app</a>
      </p>
    </div>
  </div>
</div>`;
}

// ── Sprint 1 / U7 production-gap shim: BriefStory → formatter shape ──
//
// The U7 invariant `digest.cards ⊆ brief.cards` only holds in
// production if `formatDigest`/`formatDigestHtml` consume the brief
// envelope's filtered slice (capped at MAX_STORIES_PER_USER=12, post-
// compose, post-filter), NOT the raw `stories` pool from `buildDigest`
// (capped at DIGEST_MAX_ITEMS=30).
//
// The two formatters above were written when there was no envelope —
// they expect raw-shape stories with `{title, severity, sources, link,
// description, phase}`. The brief envelope's `BriefStory` carries a
// different field set: `{headline, threatLevel, source, sourceUrl,
// description, clusterId, ...}`. This shim maps the envelope shape to
// the formatter shape without touching the formatters themselves,
// keeping the U7 invariant holdable on the live send path with the
// minimum surgical change.
//
// Compatibility decisions:
//   - `headline` → `title`. Direct rename.
//   - `threatLevel` → `severity`. The values overlap (`critical`,
//     `high`, `medium`); a `BriefStory` `low` falls into the formatter's
//     `high` bucket fallback (line ~651 / ~692). That's a benign
//     mis-bucket — the brief composer's filter already drops `low` from
//     the pool today, so the production occurrence is zero.
//   - `source` (single string) → `sources` (array). Wrap into a
//     1-element array; empty when missing. Multi-source fan-out for the
//     formatter's "+N" suffix is lost here — acceptable trade-off
//     because the BriefStory schema only carries the primary source by
//     design (per shared/brief-envelope.d.ts:112).
//   - `sourceUrl` → `link`. Direct rename. Empty string when absent
//     (the formatter renders unlinked text in that case).
//   - `description` → `description`. Direct passthrough.
//   - `clusterId` → `hash`. THIS IS THE U7-LOAD-BEARING MAPPING. The
//     formatter doesn't consume `hash` for rendering, but the U7
//     invariant projection (`projectDigestEmitClusterId` in the
//     companion test) reads it as the per-card identity. Setting
//     `hash = clusterId` makes the runtime emit set provably equal to
//     the brief envelope's clusterId set.
//   - `phase` is not on `BriefStory`. Default to `'sustained'` — a
//     valid phase value with a dedicated PHASE_COLOR entry, no
//     filtering effect (the only phase that filters is `'fading'`,
//     and that filter lives in `buildDigest`, not the formatters).
//
// Why an inline shim and not a shared helper: this transformation is
// load-bearing only for the cron's send loop. Any other consumer that
// wants the formatter shape would convert via this function would couple
// itself to the BriefStory→raw mapping that is not load-bearing
// anywhere else. Keep it local until a second consumer appears.
function briefStoriesToFormatterShape(briefStories) {
  if (!Array.isArray(briefStories)) return [];
  return briefStories.map((s) => {
    const sources = typeof s?.source === 'string' && s.source.length > 0 ? [s.source] : [];
    return {
      title: typeof s?.headline === 'string' ? s.headline : '',
      severity: typeof s?.threatLevel === 'string' ? s.threatLevel : 'high',
      sources,
      link: typeof s?.sourceUrl === 'string' ? s.sourceUrl : '',
      description: typeof s?.description === 'string' ? s.description : '',
      // 'sustained' has a defined PHASE_COLOR entry in the formatter
      // and is NOT 'fading' (the only phase value that drops in
      // buildDigest). The formatter only uses phase for cosmetic
      // colour/label, never for filtering.
      phase: 'sustained',
      // Load-bearing for the U7 invariant — see header above.
      hash: typeof s?.clusterId === 'string' ? s.clusterId : '',
    };
  });
}

// ── (Removed) standalone generateAISummary ───────────────────────────────────
//
// Prior to 2026-04-25 a separate `generateAISummary()` here ran a
// second LLM call per send to produce the email's exec-summary
// block, independent of the brief envelope's `digest.lead`. That
// asymmetry was the root cause of the email/brief contradiction
// (different inputs, different leads, different ranked stories).
//
// The synthesis is now produced ONCE per user by
// `generateDigestProse(userId, fullPool, sensitivity, deps, ctx)`
// in composeAndStoreBriefForUser, written into
// `envelope.data.digest.lead`, and read by every channel
// (email HTML, plain-text, Telegram, Slack, Discord, webhook). See
// docs/plans/2026-04-25-002-fix-brief-email-two-brain-divergence-plan.md.
//
// The `digest:ai-summary:v1:*` cache rows from the legacy code path
// expire on their existing 1h TTL — no cleanup pass needed.

// ── Channel deactivation ──────────────────────────────────────────────────────

async function deactivateChannel(userId, channelType) {
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/deactivate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SECRET}`,
        'User-Agent': 'worldmonitor-digest/1.0',
      },
      body: JSON.stringify({ userId, channelType }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[digest] Deactivate failed ${userId}/${channelType}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`[digest] Deactivate request failed for ${userId}/${channelType}:`, err.message);
  }
}

function isPrivateIP(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc|fd)/.test(ip);
}

// ── Send functions ────────────────────────────────────────────────────────────

const TELEGRAM_MAX_LEN = 4096;

function sanitizeTelegramHtml(html) {
  let out = html.replace(/<[^>]*$/, '');
  for (const tag of ['b', 'i', 'u', 's', 'code', 'pre']) {
    const opens = (out.match(new RegExp(`<${tag}>`, 'g')) || []).length;
    const closes = (out.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    for (let i = closes; i < opens; i++) out += `</${tag}>`;
  }
  return out;
}

function truncateTelegramHtml(html, limit = TELEGRAM_MAX_LEN) {
  if (html.length <= limit) {
    const sanitized = sanitizeTelegramHtml(html);
    return sanitized.length <= limit ? sanitized : truncateTelegramHtml(sanitized, limit);
  }
  const truncated = html.slice(0, limit - 30);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > limit * 0.6 ? lastNewline : truncated.length;
  return sanitizeTelegramHtml(truncated.slice(0, cutPoint) + '\n\n[truncated]');
}

/**
 * Phase 8: derive the 3 carousel image URLs from a signed magazine
 * URL. The HMAC token binds (userId, issueSlot), not the path — so
 * the same token verifies against /api/brief/{u}/{slot}?t=T AND against
 * /api/brief/carousel/{u}/{slot}/{0|1|2}?t=T.
 *
 * Returns null when the magazine URL doesn't match the expected shape
 * — caller falls back to text-only delivery.
 */
function carouselUrlsFrom(magazineUrl) {
  try {
    const u = new URL(magazineUrl);
    const m = u.pathname.match(/^\/api\/brief\/([^/]+)\/(\d{4}-\d{2}-\d{2}-\d{4})\/?$/);
    if (!m) return null;
    const [, userId, issueSlot] = m;
    const token = u.searchParams.get('t');
    if (!token) return null;
    return [0, 1, 2].map(
      (p) => `${u.origin}/api/brief/carousel/${userId}/${issueSlot}/${p}?t=${token}`,
    );
  } catch {
    return null;
  }
}

/**
 * Send the 3-image brief carousel to a Telegram chat via sendMediaGroup.
 * Telegram fetches each URL server-side, so our carousel edge function
 * has to be publicly reachable (it is — HMAC is the only credential).
 *
 * Caption goes on the FIRST image only (Telegram renders one shared
 * caption beneath the album). The caller still calls sendTelegram()
 * afterward for the long-form text — carousel is the header, text is
 * the body.
 */
async function sendTelegramBriefCarousel(userId, chatId, caption, magazineUrl) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  const urls = carouselUrlsFrom(magazineUrl);
  if (!urls) return false;
  const media = urls.map((url, i) => ({
    type: 'photo',
    media: url,
    ...(i === 0 ? { caption, parse_mode: 'HTML' } : {}),
  }));
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-digest/1.0' },
        body: JSON.stringify({ chat_id: chatId, media }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[digest] Telegram carousel ${res.status} for ${userId}: ${body.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[digest] Telegram carousel error for ${userId}: ${err.code || err.message}`);
    return false;
  }
}

async function sendTelegram(userId, chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[digest] Telegram: TELEGRAM_BOT_TOKEN not set, skipping');
    return false;
  }
  const safeText = truncateTelegramHtml(text);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-digest/1.0' },
        body: JSON.stringify({
          chat_id: chatId,
          text: safeText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (res.status === 403) {
      console.warn(`[digest] Telegram 403 for ${userId}, deactivating`);
      await deactivateChannel(userId, 'telegram');
      return false;
    } else if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[digest] Telegram send failed ${res.status} for ${userId}: ${body.slice(0, 300)}`);
      return false;
    }
    console.log(`[digest] Telegram delivered to ${userId}`);
    return true;
  } catch (err) {
    console.warn(`[digest] Telegram send error for ${userId}: ${err.code || err.message}`);
    return false;
  }
}

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[a-zA-Z0-9]+$/;
const DISCORD_RE = /^https:\/\/discord\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/;

async function sendSlack(userId, webhookEnvelope, text) {
  let webhookUrl;
  try { webhookUrl = decrypt(webhookEnvelope); } catch (err) {
    console.warn(`[digest] Slack decrypt failed for ${userId}:`, err.message); return false;
  }
  if (!SLACK_RE.test(webhookUrl)) { console.warn(`[digest] Slack URL invalid for ${userId}`); return false; }
  try {
    const hostname = new URL(webhookUrl).hostname;
    const addrs = await dns.resolve4(hostname).catch(() => []);
    if (addrs.some(isPrivateIP)) { console.warn(`[digest] Slack SSRF blocked for ${userId}`); return false; }
  } catch { return false; }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-digest/1.0' },
      body: JSON.stringify({ text, unfurl_links: false }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404 || res.status === 410) {
      console.warn(`[digest] Slack webhook gone for ${userId}, deactivating`);
      await deactivateChannel(userId, 'slack');
      return false;
    } else if (!res.ok) {
      console.warn(`[digest] Slack send failed ${res.status} for ${userId}`);
      return false;
    }
    console.log(`[digest] Slack delivered to ${userId}`);
    return true;
  } catch (err) {
    console.warn(`[digest] Slack send error for ${userId}: ${err.code || err.message}`);
    return false;
  }
}

async function sendDiscord(userId, webhookEnvelope, text) {
  let webhookUrl;
  try { webhookUrl = decrypt(webhookEnvelope); } catch (err) {
    console.warn(`[digest] Discord decrypt failed for ${userId}:`, err.message); return false;
  }
  if (!DISCORD_RE.test(webhookUrl)) { console.warn(`[digest] Discord URL invalid for ${userId}`); return false; }
  try {
    const hostname = new URL(webhookUrl).hostname;
    const addrs = await dns.resolve4(hostname).catch(() => []);
    if (addrs.some(isPrivateIP)) { console.warn(`[digest] Discord SSRF blocked for ${userId}`); return false; }
  } catch { return false; }
  const content = text.length > 2000 ? text.slice(0, 1999) + '\u2026' : text;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-digest/1.0' },
      body: JSON.stringify({ content }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404 || res.status === 410) {
      console.warn(`[digest] Discord webhook gone for ${userId}, deactivating`);
      await deactivateChannel(userId, 'discord');
      return false;
    } else if (!res.ok) {
      console.warn(`[digest] Discord send failed ${res.status} for ${userId}`);
      return false;
    }
    console.log(`[digest] Discord delivered to ${userId}`);
    return true;
  } catch (err) {
    console.warn(`[digest] Discord send error for ${userId}: ${err.code || err.message}`);
    return false;
  }
}

async function sendEmail(email, subject, text, html) {
  if (!resend) { console.warn('[digest] Email: RESEND_API_KEY not set — skipping'); return false; }
  try {
    const payload = { from: RESEND_FROM, to: email, subject, text };
    if (html) payload.html = html;
    await resend.emails.send(payload);
    console.log(`[digest] Email delivered to ${email}`);
    return true;
  } catch (err) {
    console.warn('[digest] Resend failed:', err.message);
    return false;
  }
}

async function sendWebhook(userId, webhookEnvelope, stories, aiSummary) {
  let url;
  try { url = decrypt(webhookEnvelope); } catch (err) {
    console.warn(`[digest] Webhook decrypt failed for ${userId}:`, err.message);
    return false;
  }
  let parsed;
  try { parsed = new URL(url); } catch {
    console.warn(`[digest] Webhook invalid URL for ${userId}`);
    await deactivateChannel(userId, 'webhook');
    return false;
  }
  if (parsed.protocol !== 'https:') {
    console.warn(`[digest] Webhook rejected non-HTTPS for ${userId}`);
    return false;
  }
  try {
    const addrs = await dns.resolve4(parsed.hostname);
    if (addrs.some(isPrivateIP)) { console.warn(`[digest] Webhook SSRF blocked for ${userId}`); return false; }
  } catch {
    console.warn(`[digest] Webhook DNS resolve failed for ${userId}`);
    return false;
  }
  const payload = JSON.stringify({
    version: '1',
    eventType: 'digest',
    stories: stories.map(s => ({ title: s.title, severity: s.severity, phase: s.phase, sources: s.sources })),
    summary: aiSummary ?? null,
    storyCount: stories.length,
  });
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-digest/1.0' },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 404 || resp.status === 410 || resp.status === 403) {
      console.warn(`[digest] Webhook ${resp.status} for ${userId} — deactivating`);
      await deactivateChannel(userId, 'webhook');
      return false;
    }
    if (!resp.ok) { console.warn(`[digest] Webhook ${resp.status} for ${userId}`); return false; }
    console.log(`[digest] Webhook delivered for ${userId}`);
    return true;
  } catch (err) {
    console.warn(`[digest] Webhook error for ${userId}:`, err.message);
    return false;
  }
}

// ── Entitlement check ────────────────────────────────────────────────────────

async function isUserPro(userId) {
  const cacheKey = `relay:entitlement:${userId}`;
  try {
    const cached = await upstashRest('GET', cacheKey);
    if (cached !== null) return Number(cached) >= 1;
  } catch { /* miss */ }
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/entitlement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-digest/1.0' },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return true; // fail-open
    const { tier } = await res.json();
    await upstashRest('SET', cacheKey, String(tier ?? 0), 'EX', String(ENTITLEMENT_CACHE_TTL));
    return (tier ?? 0) >= 1;
  } catch {
    return true; // fail-open
  }
}

// ── Per-channel body composition ─────────────────────────────────────────────

const DIVIDER = '─'.repeat(40);

/**
 * Compose the per-channel message bodies for a single digest rule.
 * Keeps the per-channel formatting logic out of main() so its cognitive
 * complexity stays within the lint budget.
 */
function buildChannelBodies(storyListPlain, aiSummary, magazineUrl) {
  // The URL is already HMAC-signed and shape-validated at sign time
  // (userId regex + YYYY-MM-DD), but we still escape it per-target
  // as defence-in-depth — same discipline injectBriefCta uses for
  // the email button. Each target has different metacharacter rules.
  const telegramSafeUrl = magazineUrl
    ? String(magazineUrl)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    : '';
  const slackSafeUrl = magazineUrl
    ? String(magazineUrl).replace(/[<>|]/g, '')
    : '';
  const briefFooterPlain = magazineUrl
    ? `\n\n${DIVIDER}\n\n📖 Open your WorldMonitor Brief magazine:\n${magazineUrl}`
    : '';
  const briefFooterTelegram = magazineUrl
    ? `\n\n${DIVIDER}\n\n📖 <a href="${telegramSafeUrl}">Open your WorldMonitor Brief magazine</a>`
    : '';
  const briefFooterSlack = magazineUrl
    ? `\n\n${DIVIDER}\n\n📖 <${slackSafeUrl}|Open your WorldMonitor Brief magazine>`
    : '';
  const briefFooterDiscord = magazineUrl
    ? `\n\n${DIVIDER}\n\n📖 [Open your WorldMonitor Brief magazine](${magazineUrl})`
    : '';
  if (!aiSummary) {
    return {
      text: `${storyListPlain}${briefFooterPlain}`,
      telegramText: `${escapeTelegramHtml(storyListPlain)}${briefFooterTelegram}`,
      slackText: `${escapeSlackMrkdwn(storyListPlain)}${briefFooterSlack}`,
      discordText: `${storyListPlain}${briefFooterDiscord}`,
    };
  }
  return {
    text: `EXECUTIVE SUMMARY\n\n${aiSummary}\n\n${DIVIDER}\n\n${storyListPlain}${briefFooterPlain}`,
    telegramText: `<b>EXECUTIVE SUMMARY</b>\n\n${markdownToTelegramHtml(aiSummary)}\n\n${DIVIDER}\n\n${escapeTelegramHtml(storyListPlain)}${briefFooterTelegram}`,
    slackText: `*EXECUTIVE SUMMARY*\n\n${markdownToSlackMrkdwn(aiSummary)}\n\n${DIVIDER}\n\n${escapeSlackMrkdwn(storyListPlain)}${briefFooterSlack}`,
    discordText: `**EXECUTIVE SUMMARY**\n\n${markdownToDiscord(aiSummary)}\n\n${DIVIDER}\n\n${storyListPlain}${briefFooterDiscord}`,
  };
}

// injectEmailSummary lives in scripts/lib/email-summary-html.mjs so
// the multi-section HTML assembly can be unit-tested without
// dragging the cron's env-checking side effects into the test
// runtime. Imported at the top alongside the other lib helpers.

/**
 * Inject the "Open your brief" CTA into the email HTML. Placed near
 * the top of the body so recipients see the magazine link before the
 * story list. Uses inline styles only (Gmail / Outlook friendly).
 * When no magazineUrl is present (composer skipped / signing
 * failed), the slot is stripped so the email stays clean.
 */
function injectBriefCta(html, magazineUrl) {
  if (!html) return html;
  if (!magazineUrl) return html.replace('<div data-brief-cta-slot></div>', '');
  const escapedUrl = String(magazineUrl)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const ctaHtml = `<div style="margin:0 0 24px 0;">
<a href="${escapedUrl}" style="display:inline-block;background:#f2ede4;color:#0a0a0a;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.08em;padding:14px 22px;border-radius:4px;">Open your WorldMonitor Brief →</a>
<div style="margin-top:10px;font-size:11px;color:#888;line-height:1.5;">Your personalised editorial magazine. Opens in the browser — scroll or swipe through today's threads.</div>
</div>`;
  return html.replace('<div data-brief-cta-slot></div>', ctaHtml);
}

// ── Brief composition (runs once per cron tick, before digest loop) ─────────

/**
 * Write brief:{userId}:{issueDate} for every eligible user and
 * return { briefByUser, counters } for the digest loop + main's
 * end-of-run exit gate. One brief per user regardless of how many
 * variants they have enabled.
 *
 * Returns empty counters when brief composition is disabled,
 * insights are unavailable, or the signing secret is missing. Never
 * throws — the digest send path must remain independent of the
 * brief path, so main() handles exit-codes at the very end AFTER
 * the digest has been dispatched.
 *
 * @param {unknown[]} rules
 * @param {number} nowMs
 * @returns {Promise<{ briefByUser: Map<string, object>; composeSuccess: number; composeFailed: number }>}
 */
async function composeBriefsForRun(rules, nowMs) {
  const briefByUser = new Map();
  // Missing secret without explicit operator-disable = misconfigured
  // rollout. Count it as a compose failure so the end-of-run exit
  // gate trips and Railway flags the run red. Digest send still
  // proceeds (compose failures must never block notification
  // delivery to users).
  if (BRIEF_SIGNING_SECRET_MISSING) {
    console.error(
      '[digest] brief: BRIEF_URL_SIGNING_SECRET not configured. Set BRIEF_COMPOSE_ENABLED=0 to silence intentionally.',
    );
    return { briefByUser, composeSuccess: 0, composeFailed: 1 };
  }
  if (!BRIEF_COMPOSE_ENABLED) return { briefByUser, composeSuccess: 0, composeFailed: 0 };

  // The brief's story list now comes from the same digest accumulator
  // the email reads (buildDigest). news:insights:v1 is still consulted
  // for the global "clusters / multi-source" stat-page numbers, but no
  // longer for the story list itself. A failed or empty insights fetch
  // is NOT fatal — we fall back to zeroed numbers and still ship the
  // brief, because the stories are what matter. (A mismatched brief
  // was far worse than a brief with dashes on the stats page.)
  let insightsNumbers = { clusters: 0, multiSource: 0 };
  try {
    const insightsRaw = await readRawJsonFromUpstash(INSIGHTS_KEY);
    if (insightsRaw) insightsNumbers = extractInsights(insightsRaw).numbers;
  } catch (err) {
    console.warn('[digest] brief: insights read failed, using zeroed stats:', err.message);
  }

  // Memoize buildDigest by (variant, lang, sensitivity, windowStart).
  // Many users share a variant/lang, so this saves ZRANGE + HGETALL
  // round-trips across the per-user loop. Scoped to this cron run —
  // no cross-run memoization needed (Redis is authoritative).
  //
  // Sensitivity is part of the key because buildDigest filters by
  // rule.sensitivity BEFORE dedup — without it, a stricter user
  // inherits a looser populator's pool (the earlier populator "wins"
  // and decides which severity tiers enter the pool, so stricter
  // users get a pool that contains severities they never wanted).
  //
  // windowStart is derived per-candidate from `lastSentAt`, matching
  // the send loop's formula exactly (digestWindowStartMs). Without
  // this, the canonical brief lead would be synthesized from a fixed
  // 24h pool while the email/Slack body ships the actual cadence's
  // window (7d for weekly, 12h for twice_daily) — a different flavor
  // of the cross-surface divergence the canonical-brain refactor is
  // designed to eliminate.
  const digestCache = new Map();
  async function digestFor(cand) {
    const windowStart = digestWindowStartMs(cand.lastSentAt, nowMs, DIGEST_LOOKBACK_MS);
    const key = `${cand.rule.variant ?? 'full'}:${cand.rule.lang ?? 'en'}:${cand.rule.sensitivity ?? 'high'}:${windowStart}`;
    if (digestCache.has(key)) return digestCache.get(key);
    const stories = await buildDigest(cand.rule, windowStart);
    digestCache.set(key, stories ?? []);
    return stories ?? [];
  }

  // Pre-annotate every eligible rule with its lastSentAt + isDue
  // status. The compose flow uses this to prefer a "due-this-tick"
  // candidate as the canonical synthesis source, falling back to any
  // eligible candidate when nothing is due (preserving today's
  // dashboard refresh contract for weekly users on non-due ticks).
  // Codex Round-3 High #1 + Round-4 High #1 + Round-4 Medium #2.
  //
  // One Upstash GET per rule per tick; with caching across rules of
  // the same user this is cheap. The send loop in main() reads from
  // this same map (via getLastSentAt) so compose + send agree on
  // lastSentAt for every rule.
  const annotatedByUser = new Map();
  for (const [userId, candidates] of groupEligibleRulesByUser(rules)) {
    const annotated = [];
    for (const rule of candidates) {
      const lastSentAt = await getLastSentAt(rule);
      annotated.push({ rule, lastSentAt, due: isDue(rule, lastSentAt) });
    }
    annotatedByUser.set(userId, annotated);
  }

  let composeSuccess = 0;
  let composeFailed = 0;
  for (const [userId, annotated] of annotatedByUser) {
    try {
      const hit = await composeAndStoreBriefForUser(userId, annotated, insightsNumbers, digestFor, nowMs);
      if (hit) {
        briefByUser.set(userId, hit);
        composeSuccess++;
      }
    } catch (err) {
      composeFailed++;
      if (err instanceof BriefUrlError) {
        console.warn(`[digest] brief: sign failed for ${userId} (${err.code}): ${err.message}`);
      } else {
        console.warn(`[digest] brief: compose failed for ${userId}:`, err.message);
      }
    }
  }
  console.log(
    `[digest] brief: compose_success=${composeSuccess} compose_failed=${composeFailed} total_users=${annotatedByUser.size}`,
  );
  return { briefByUser, composeSuccess, composeFailed };
}

/**
 * Per-user: pick a winning candidate (DUE rules first, then any
 * eligible rule), pull its digest pool, run canonical synthesis
 * over the FULL pre-cap pool, then compose the envelope with the
 * synthesis spliced in. SETEX the envelope, sign the magazine URL.
 *
 * Returns the entry the caller should stash in briefByUser, or null
 * when no candidate had stories. The entry's `synthesisLevel` field
 * tells the send loop which fallback path produced the lead (1 =
 * canonical, 2 = degraded, 3 = stub) — drives the email subject-line
 * ternary and the parity log.
 *
 * @param {string} userId
 * @param {Array<{ rule: object; lastSentAt: number | null; due: boolean }>} annotated
 * @param {{ clusters: number; multiSource: number }} insightsNumbers
 * @param {(rule: object) => Promise<unknown[]>} digestFor
 * @param {number} nowMs
 */
async function composeAndStoreBriefForUser(userId, annotated, insightsNumbers, digestFor, nowMs) {
  // Two-pass walk extracted to a pure helper so it can be unit-tested
  // (A6.l + A6.m). When no candidate has a non-empty pool — OR when
  // every non-empty candidate has its stories filtered out by the
  // composer (URL/headline/shape filters) — returns null.
  //
  // The `tryCompose` callback is the filter-rejection fall-through:
  // before the original PR, the legacy loop kept trying lower-priority
  // candidates whenever compose returned null. Without this hook the
  // helper would claim the first non-empty pool as winner and the
  // caller would bail on filter-drop, suppressing briefs that a
  // lower-priority candidate would have produced.
  //
  // We compose WITHOUT synthesis here (cheap — pure JS, no I/O) just
  // to check filter survival; the real composition with synthesis
  // splice-in happens once below, after the winner is locked in.
  const log = (line) => console.log(line);
  const winnerResult = await pickWinningCandidateWithPool(
    annotated,
    digestFor,
    log,
    userId,
    (cand, stories) => {
      const test = composeBriefFromDigestStories(
        cand.rule,
        stories,
        insightsNumbers,
        { nowMs },
      );
      return test ?? null;
    },
  );
  if (!winnerResult) return null;
  const { winner, stories: winnerStories } = winnerResult;

  // ── Canonical synthesis (3-level fallback chain) ────────────────────
  //
  // L1: full pre-cap pool + personalised ctx (profile, greeting). The
  //     desired outcome — single LLM call per user, lead anchored on
  //     the wider story set the model has the most signal from.
  // L2: post-cap envelope-only + empty ctx. Mirrors today's
  //     enrichBriefEnvelopeWithLLM behavior — used when L1 returns
  //     null (LLM down across all providers, parse failure).
  // L3: stub from assembleStubbedBriefEnvelope. The brief still
  //     ships; only the lead text degrades. Email subject downgrades
  //     from "Intelligence Brief" to "Digest" (driven by
  //     synthesisLevel === 3 in the send loop).
  const sensitivity = winner.rule.sensitivity ?? 'high';
  let synthesis = null;
  let publicLead = null;
  let synthesisLevel = 3;  // pessimistic default; bumped on success
  if (BRIEF_LLM_ENABLED) {
    const ctx = await buildSynthesisCtx(winner.rule, nowMs);
    const result = await runSynthesisWithFallback(
      userId,
      winnerStories,
      sensitivity,
      ctx,
      briefLlmDeps,
      (level, kind, err) => {
        if (kind === 'throw') {
          console.warn(
            `[digest] brief: synthesis L${level} threw for ${userId} — falling to L${level + 1}:`,
            err?.message,
          );
        } else if (kind === 'success' && level === 2) {
          console.log(`[digest] synthesis level=2_degraded user=${userId}`);
        } else if (kind === 'success' && level === 3) {
          console.log(`[digest] synthesis level=3_stub user=${userId}`);
        }
      },
    );
    synthesis = result.synthesis;
    synthesisLevel = result.level;
    // Public synthesis — parallel call. Profile-stripped; cache-
    // shared across all users for the same (date, sensitivity,
    // story-pool). Captures the FULL prose object (lead + signals +
    // threads) since each personalised counterpart in the envelope
    // can carry profile bias and the public surface needs sibling
    // safe-versions of all three. Failure is non-fatal — the
    // renderer's public-mode fail-safes (omit pull-quote / omit
    // signals page / category-derived threads stub) handle absence
    // rather than leaking the personalised version.
    try {
      const pub = await generateDigestProsePublic(winnerStories, sensitivity, briefLlmDeps);
      if (pub) publicLead = pub;  // { lead, threads, signals, rankedStoryHashes }
    } catch (err) {
      console.warn(`[digest] brief: publicLead generation failed for ${userId}:`, err?.message);
    }
  }

  // Compose envelope with synthesis pre-baked. The composer applies
  // rankedStoryHashes-aware ordering BEFORE the cap, so the model's
  // editorial judgment of importance survives MAX_STORIES_PER_USER.
  const dropStats = {
    severity: 0,
    headline: 0,
    url: 0,
    shape: 0,
    cap: 0,
    source_topic_cap: 0,
    institutional_static_page: 0,
    in: winnerStories.length,
  };
  const envelope = composeBriefFromDigestStories(
    winner.rule,
    winnerStories,
    insightsNumbers,
    {
      nowMs,
      onDrop: (ev) => { dropStats[ev.reason] = (dropStats[ev.reason] ?? 0) + 1; },
      synthesis: synthesis || publicLead
        ? {
            ...(synthesis ?? {}),
            publicLead: publicLead?.lead ?? undefined,
            publicSignals: publicLead?.signals ?? undefined,
            publicThreads: publicLead?.threads ?? undefined,
          }
        : undefined,
    },
  );

  // Per-attempt filter-drop line for the winning candidate. Same
  // shape today's log emits — operators can keep their existing
  // queries. The `due` field is new; legacy parsers ignore unknown
  // fields.
  const out = envelope?.data?.stories?.length ?? 0;
  console.log(
    `[digest] brief filter drops user=${userId} ` +
      `sensitivity=${sensitivity} ` +
      `variant=${winner.rule.variant ?? 'full'} ` +
      `due=${winner.due} ` +
      `outcome=${envelope ? 'shipped' : 'rejected'} ` +
      `in=${dropStats.in} ` +
      `dropped_severity=${dropStats.severity} ` +
      `dropped_url=${dropStats.url} ` +
      `dropped_headline=${dropStats.headline} ` +
      `dropped_shape=${dropStats.shape} ` +
      `dropped_cap=${dropStats.cap} ` +
      `dropped_source_topic_cap=${dropStats.source_topic_cap} ` +
      `dropped_institutional_static_page=${dropStats.institutional_static_page} ` +
      `out=${out}`,
  );

  if (!envelope) return null;

  // Per-story whyMatters enrichment. The synthesis is already in the
  // envelope; this pass only fills per-story rationales. Failures
  // fall through cleanly — the stub `whyMatters` from the composer
  // is acceptable.
  let finalEnvelope = envelope;
  if (BRIEF_LLM_ENABLED) {
    try {
      const enriched = await enrichBriefEnvelopeWithLLM(envelope, winner.rule, briefLlmDeps);
      // Defence in depth: re-validate the enriched envelope against
      // the renderer's strict contract before we SETEX it. If
      // enrichment produced a structurally broken shape (bad cache
      // row, code bug, upstream type drift) we'd otherwise SETEX it
      // and /api/brief would 404 the user's brief at read time. Fall
      // back to the unenriched envelope — which is already known to
      // pass assertBriefEnvelope() because composeBriefFromDigestStories
      // asserted on construction.
      try {
        assertBriefEnvelope(enriched);
        finalEnvelope = enriched;
      } catch (assertErr) {
        console.warn(`[digest] brief: enriched envelope failed assertion for ${userId} — shipping unenriched:`, assertErr?.message);
      }
    } catch (err) {
      console.warn(`[digest] brief: per-story enrichment threw for ${userId} — shipping unenriched envelope:`, err?.message);
    }
  }

  // Slot (YYYY-MM-DD-HHMM in the user's tz) is what routes the
  // magazine URL + Redis key. Using the same tz the composer used to
  // produce envelope.data.date guarantees the slot's date portion
  // matches the displayed date. Two same-day compose runs produce
  // distinct slots so each digest dispatch freezes its own URL.
  const briefTz = winner.rule?.digestTimezone ?? 'UTC';
  const issueSlot = issueSlotInTz(nowMs, briefTz);
  const key = `brief:${userId}:${issueSlot}`;
  // The latest-pointer lets readers (dashboard panel, share-url
  // endpoint) locate the most recent brief without knowing the slot.
  // One SET per compose is cheap and always current.
  const latestPointerKey = `brief:latest:${userId}`;
  const latestPointerValue = JSON.stringify({ issueSlot });
  const pipelineResult = await redisPipeline([
    ['SETEX', key, String(BRIEF_TTL_SECONDS), JSON.stringify(finalEnvelope)],
    ['SETEX', latestPointerKey, String(BRIEF_TTL_SECONDS), latestPointerValue],
  ]);
  if (!pipelineResult || !Array.isArray(pipelineResult) || pipelineResult.length < 2) {
    throw new Error('null pipeline response from Upstash');
  }
  for (const cell of pipelineResult) {
    if (cell && typeof cell === 'object' && 'error' in cell) {
      throw new Error(`Upstash SETEX error: ${cell.error}`);
    }
  }

  const magazineUrl = await signBriefUrl({
    userId,
    issueDate: issueSlot,
    baseUrl: WORLDMONITOR_PUBLIC_BASE_URL,
    secret: BRIEF_URL_SIGNING_SECRET,
  });
  return {
    envelope: finalEnvelope,
    magazineUrl,
    chosenVariant: winner.rule.variant,
    // synthesisLevel goes here — NOT in the envelope (renderer's
    // assertNoExtraKeys would reject it). Read by the send loop for
    // the email subject-line ternary and the parity log.
    synthesisLevel,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const nowMs = Date.now();
  console.log('[digest] Cron run start:', new Date(nowMs).toISOString());

  let rules;
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/digest-rules`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${RELAY_SECRET}`,
        'User-Agent': 'worldmonitor-digest/1.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error('[digest] Failed to fetch rules:', res.status);
      return;
    }
    rules = await res.json();
  } catch (err) {
    console.error('[digest] Fetch rules failed:', err.message);
    return;
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    console.log('[digest] No digest rules found — nothing to do');
    return;
  }

  // Operator single-user test filter. Self-expiring by design: the env
  // var MUST carry an `|until=<ISO8601>` suffix within 48h, or it's
  // IGNORED. Rationale: the naive `DIGEST_ONLY_USER=user_xxx` format
  // from PR #3255 was a sticky footgun — if an operator set it for a
  // one-off validation and forgot to unset it, the cron would silently
  // filter out every other user indefinitely while still completing
  // normally and exiting 0, creating a prolonged partial outage with
  // "green" runs. Mandatory expiry + hard 48h cap + loud warn at run
  // start makes the test surface self-cleanup even if the operator
  // walks away.
  //
  // Format: DIGEST_ONLY_USER=user_xxxxxxxxxxxxxxxxxxxxxx|until=2026-04-22T18:00Z
  // Legacy bare-userId format is rejected (fall-through to normal
  // fan-out) with a loud warn explaining the new syntax.
  const onlyUserFilter = parseDigestOnlyUser(
    (process.env.DIGEST_ONLY_USER ?? '').trim(),
    nowMs,
  );
  if (onlyUserFilter.kind === 'active') {
    const remainingMin = Math.round((onlyUserFilter.untilMs - nowMs) / 60_000);
    console.warn(
      `⚠️  [digest] DIGEST_ONLY_USER ACTIVE — filtering to userId=${onlyUserFilter.userId}. ` +
        `Expires in ${remainingMin} min (${new Date(onlyUserFilter.untilMs).toISOString()}). ` +
        `All other users are EXCLUDED from this run. Unset DIGEST_ONLY_USER after testing.`,
    );
    const before = rules.length;
    rules = rules.filter((r) => r && r.userId === onlyUserFilter.userId);
    console.log(
      `[digest] DIGEST_ONLY_USER — filtered ${before} rules → ${rules.length}`,
    );
    if (rules.length === 0) {
      console.warn(
        `[digest] No rules matched userId=${onlyUserFilter.userId} — nothing to do (exiting green).`,
      );
      return;
    }
  } else if (onlyUserFilter.kind === 'reject') {
    // Malformed / expired / cap-exceeded — log LOUDLY and fan out normally
    // so a forgotten flag cannot produce a silent partial outage.
    console.warn(
      `[digest] DIGEST_ONLY_USER present but IGNORED: ${onlyUserFilter.reason}. ` +
        `Proceeding with normal fan-out. Format: ` +
        `DIGEST_ONLY_USER=user_xxx|until=<ISO8601 within 48h>.`,
    );
  }
  // kind === 'unset' → normal fan-out, no log (production default)

  // Compose per-user brief envelopes once per run (extracted so main's
  // complexity score stays in the biome budget). Failures MUST NOT
  // block digest sends — we carry counters forward and apply the
  // exit-non-zero gate AFTER the digest dispatch so Railway still
  // surfaces compose-layer breakage without skipping user-visible
  // digest delivery.
  const { briefByUser, composeSuccess, composeFailed } = await composeBriefsForRun(rules, nowMs);

  // Sprint 1 / U2 — option (a) canonical-send mapping. Build a per-user
  // rule index ONCE so each iteration of the send loop can resolve the
  // user's canonical winner rule in O(1). The compose phase already
  // identified the winner via pickWinningCandidateWithPool and stamped
  // its variant into briefByUser[userId].chosenVariant; we use that as
  // the per-user filter below to drop non-winner rules from the send
  // fan-out. Rules without a string userId are skipped here so the
  // index lookup in the loop is a single map.get() rather than a re-
  // filter each iteration.
  const userRulesByUserId = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule.userId !== 'string') continue;
    const list = userRulesByUserId.get(rule.userId);
    if (list) list.push(rule);
    else userRulesByUserId.set(rule.userId, [rule]);
  }

  let sentCount = 0;
  // Sprint 1 / U2 hardening — track which users we've already warned
  // about a compose-miss so each user gets ONE warn per cron tick, not
  // one per rule iteration. See the briefForUser-missing branch below.
  const composeMissUsers = new Set();

  // Sprint 1 / U5 — cooldown mode resolved ONCE per cron tick. Operator
  // surface is `DIGEST_COOLDOWN_MODE` ∈ {shadow, off}; default 'shadow'.
  // Anything else (typo, garbage, even 'enforce' which Sprint 2 will
  // introduce) fails closed to 'shadow' with `invalidRaw` populated for
  // a startup warn — see `feedback_kill_switch_default_on_typo`.
  //
  // Resolved at the top of the run (not per rule) because the env value
  // can't change mid-tick, and we want the typo-warn to fire ONCE per
  // cron run, not once per user. The decision evaluator below is invoked
  // with `mode` as a per-call option so a future per-user shadow-subset
  // gate can short-circuit by passing `mode: 'off'` for excluded users
  // (decision artifact becomes null → shadow logger silently skips them
  // per `feedback_gate_on_ground_truth_not_configured_state`).
  const cooldownConfig = readCooldownConfig(process.env);
  if (cooldownConfig.invalidRaw !== null) {
    console.warn(
      `[digest] cooldown unrecognised DIGEST_COOLDOWN_MODE=${JSON.stringify(cooldownConfig.invalidRaw)} — ` +
        `falling back to 'shadow' (safe default; Sprint 1 has no enforce mode). Valid: shadow | off.`,
    );
  }

  for (const rule of rules) {
    if (!rule.userId || !rule.variant) continue;

    // Sprint 1 / U2 — drop non-winner rules under option (a) WHEN
    // compose succeeded for this user. The compose phase already
    // picked ONE rule per user-slot; only that rule drives the send.
    // Non-winner rules silently fall through here (their pools are
    // absorbed into the winner's at the accumulator/dedup layer
    // upstream — see brief-dedup.mjs).
    //
    // Codex PR #3614 P1 — composeBriefsForRun returns an empty map
    // when BRIEF_SIGNING_SECRET is missing OR brief compose is
    // disabled OR a per-user compose error was caught upstream. The
    // pre-fix canonical filter dropped EVERY rule for those users —
    // turning a brief-compose outage / config disable into a digest-
    // send outage. Now: when briefForUser is missing, the canonical
    // filter is skipped and we fall through to the legacy per-rule
    // send path (multi-rule divergence reappears for THAT USER ONLY
    // for THIS TICK only — acceptable trade-off because silent
    // suppression of an entire user's digest is worse than a one-
    // tick divergence on the path back to recovery). magazineUrl
    // resolves to null at line ~1793 (brief?.magazineUrl ?? null);
    // the carousel + CTA paths already gate on magazineUrl being
    // truthy, so this branch produces a brief-less email/text body
    // that still delivers the curated story list.
    const briefForUser = briefByUser.get(rule.userId);
    if (briefForUser) {
      const canonicalRule = selectCanonicalSendRule(
        briefForUser,
        userRulesByUserId.get(rule.userId) ?? [],
      );
      if (!canonicalRule || canonicalRule !== rule) continue;
    } else {
      if (!composeMissUsers.has(rule.userId)) {
        console.warn(
          `[digest] compose-miss user=${rule.userId} — briefByUser has no entry. ` +
            `Falling through to per-rule send (no magazineUrl, multi-rule users will see ` +
            `pre-U2 per-rule body divergence for this tick). Investigate: ` +
            `BRIEF_SIGNING_SECRET unset, brief compose disabled, OR composeBriefForUser ` +
            `caught a per-user error (Sentry should carry the trace).`,
        );
        composeMissUsers.add(rule.userId);
      }
      // Fall through — no canonical filter; this rule iterates
      // through isDue / isUserPro / buildDigest / send normally.
    }

    const lastSentKey = `digest:last-sent:v1:${rule.userId}:${rule.variant}`;
    // Reuse the same getLastSentAt helper the compose pass used so
    // the two flows agree on lastSentAt for every rule. Codex Round-3
    // High #1 — winner-from-due-candidates pre-condition.
    const lastSentAt = await getLastSentAt(rule);

    if (!isDue(rule, lastSentAt)) continue;

    const pro = await isUserPro(rule.userId);
    if (!pro) {
      console.log(`[digest] Skipping ${rule.userId} — not PRO`);
      continue;
    }

    const windowStart = digestWindowStartMs(lastSentAt, nowMs, DIGEST_LOOKBACK_MS);
    const stories = await buildDigest(rule, windowStart);
    if (!stories) {
      console.log(`[digest] No stories in window for ${rule.userId} (${rule.variant})`);
      continue;
    }

    let channels = [];
    try {
      const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RELAY_SECRET}`,
          'User-Agent': 'worldmonitor-digest/1.0',
        },
        body: JSON.stringify({ userId: rule.userId }),
        signal: AbortSignal.timeout(10000),
      });
      if (chRes.ok) channels = await chRes.json();
    } catch (err) {
      console.warn(`[digest] Channel fetch failed for ${rule.userId}:`, err.message);
    }

    const ruleChannelSet = new Set(rule.channels ?? []);
    const deliverableChannels = channels.filter(ch => ruleChannelSet.has(ch.channelType) && ch.verified);
    if (deliverableChannels.length === 0) {
      console.log(`[digest] No deliverable channels for ${rule.userId} — skipping`);
      continue;
    }

    // Sprint 1 / U2 — option (a) canonical send.
    //
    // We are guaranteed to be on the WINNING rule for this user-slot
    // (the canonical-rule filter above dropped every non-winner). So:
    //
    //   - The synthesis we run here against `stories` is the canonical
    //     synthesis that backs the magazine envelope. generateDigestProse
    //     hits the same cache row the compose phase wrote (same
    //     userId/sensitivity/pool/ctx), so this is a cache read, not a
    //     second LLM call.
    //   - Every channel body — email HTML + plain text + Telegram +
    //     Slack + Discord + webhook — reads from this single synthesis
    //     output. There is no per-rule fan-out, no winner-vs-non-winner
    //     channel divergence, and no separate per-rule magazine URL.
    //   - The magazine URL (briefByUser[userId].magazineUrl) points at
    //     the SAME rule's envelope this synthesis was derived from, so
    //     subscribers experience full email-body ↔ magazine consistency
    //     for the first time.
    //
    // Pre-U2 (PR <U2-pr> reference), this block ran a fresh synthesis
    // per enabled rule and accepted "channel-body lead vs magazine lead
    // may differ for non-winner rules" as a trade-off. Option (a) closes
    // the divergence at the cost of multi-rule users seeing only the
    // winner rule's content per slot — confirmed during planning as the
    // intended subscriber-visible behaviour change.
    //
    // Reuse briefForUser fetched above (Codex PR #3614 P2 — was a
    // duplicate Map.get on the same key).
    const brief = briefForUser;
    let briefSynthesis = null;  // full {lead, threads, signals} when synthesis succeeded
    let briefLead = null;       // string projection for non-email channels + parity log
    let synthesisLevel = 3;
    if (AI_DIGEST_ENABLED && rule.aiDigestEnabled !== false) {
      const ruleCtx = await buildSynthesisCtx(rule, nowMs);
      const ruleResult = await runSynthesisWithFallback(
        rule.userId,
        stories,
        rule.sensitivity ?? 'high',
        ruleCtx,
        briefLlmDeps,
      );
      briefSynthesis = ruleResult.synthesis;
      briefLead = ruleResult.synthesis?.lead ?? null;
      synthesisLevel = ruleResult.level;
    }

    // Sprint 1 / U7 production-gap fix.
    //
    // Pre-fix the formatters consumed the raw `stories` pool (capped
    // at DIGEST_MAX_ITEMS=30 by buildDigest). Post-fix they consume
    // the brief envelope's `data.stories` (capped at MAX_STORIES_PER_USER
    // =12 by filterTopStories). This is what makes the U7 invariant
    // `digest.cards ⊆ brief.cards` HOLD ON THE LIVE SEND PATH — without
    // this swap the email body could surface clusterIds the brief
    // envelope omitted (the 18-30 stories the cap dropped), which
    // would orphan their delivered-log keys from the magazine side.
    //
    // briefForUser is guaranteed non-null in this branch (the
    // canonical-rule filter at the top of the loop returned only when
    // briefForUser was present). The compose-miss fallback path
    // (briefForUser === undefined) does NOT reach here — that branch
    // either skips the user or falls through with magazineUrl=null;
    // the formatters in that fallback continue to consume the raw
    // stories pool, accepting U7-invariant degradation as the cost of
    // delivering SOMETHING for that one tick.
    //
    // Compatibility shim: briefStoriesToFormatterShape maps the
    // BriefStory schema to the formatter's expected raw-shape fields.
    // See the function header for field-by-field rationale + the
    // load-bearing `clusterId → hash` mapping that makes the U7
    // invariant projection work at runtime.
    const briefEnvelopeStories = brief?.envelope?.data?.stories;
    const formatterStories = Array.isArray(briefEnvelopeStories) && briefEnvelopeStories.length > 0
      ? briefStoriesToFormatterShape(briefEnvelopeStories)
      : stories; // fallback: brief envelope absent (compose-miss branch above)

    // Codex PR #3617 round-4 P2 — unified iterable for U4/U5 coverage in
    // both branches.
    //
    // Pre-fix the cooldown loop (U5) and delivered-log writer (U4) were
    // both gated on `briefEnvelopeStories.length > 0`, so under
    // compose-miss (brief absent) the digest cards were SENT to the
    // user but the U4/U5 substrate skipped them entirely. Multi-tick
    // compose outages (e.g. signing secret unset for 6h) accumulated
    // un-tracked deliveries; when compose recovered, the cooldown
    // saw "no prior delivery" and re-aired everything the user had
    // received during the outage.
    //
    // Fix: build a unified `cooldownIterableStories` array that both
    // branches feed. Under brief-success it's the v4 BriefStory shape
    // directly (already has clusterId, threatLevel, source, sourceUrl,
    // headline). Under compose-miss it's a normalized projection of
    // the raw `stories` pool — fields mapped by hand from the
    // post-buildDigest shape (severity → threatLevel, link → sourceUrl,
    // title → headline, mergedHashes[0] || hash → clusterId).
    //
    // Same downstream iteration in both U4 and U5 loops; same
    // sourceCountByClusterId Map (already keyed on repHash, which
    // matches both branches' clusterId semantics).
    const cooldownIterableStories = Array.isArray(briefEnvelopeStories) && briefEnvelopeStories.length > 0
      ? briefEnvelopeStories
      : (Array.isArray(stories) ? stories.map((rawStory) => {
          const repHash = Array.isArray(rawStory?.mergedHashes)
            && rawStory.mergedHashes.length > 0
            && typeof rawStory.mergedHashes[0] === 'string'
            ? rawStory.mergedHashes[0]
            : (typeof rawStory?.hash === 'string' ? rawStory.hash : '');
          const sources = Array.isArray(rawStory?.sources) ? rawStory.sources : [];
          return {
            clusterId: repHash,
            threatLevel: typeof rawStory?.severity === 'string' ? rawStory.severity : 'unknown',
            source: typeof sources[0] === 'string' ? sources[0] : '',
            sourceUrl: typeof rawStory?.link === 'string' ? rawStory.link : '',
            headline: typeof rawStory?.title === 'string' ? rawStory.title : '',
          };
        }) : []);

    const storyListPlain = formatDigest(formatterStories, nowMs);
    if (!storyListPlain) continue;
    const htmlRaw = formatDigestHtml(formatterStories, nowMs);

    const magazineUrl = brief?.magazineUrl ?? null;
    const { text, telegramText, slackText, discordText } = buildChannelBodies(
      storyListPlain,
      briefLead,
      magazineUrl,
    );
    // Email gets the FULL structured synthesis (lead + threads +
    // signals) so the editorial block matches the old Brain B
    // multi-paragraph richness — not just the magazine pull-quote.
    // Non-email channels (Telegram/Slack/Discord/webhook) keep the
    // single-string lead since their formats favour brevity. The
    // canonical-synthesis contract still holds: every channel reads
    // from the same generateDigestProse output for this rule.
    const htmlWithSummary = injectEmailSummary(htmlRaw, briefSynthesis);
    const html = injectBriefCta(htmlWithSummary, magazineUrl);

    const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(nowMs));
    const subject = subjectForBrief({ briefLead, synthesisLevel, shortDate });

    // Sprint 1 / U5 — cooldown shadow-mode evaluation (per-cluster,
    // per-channel, BEFORE the channel send). The decision is computed
    // and accumulated; the send loop below is unchanged. Sprint 2 will
    // wire the decision into the send-loop guard. Until then, the
    // accumulator's only consumer is the shadow log line emitted after
    // the send loop completes for this user-rule.
    //
    // Why before the send (not after): the U4 delivered-log writes
    // happen AFTER each channel's send returns true, and we want the
    // cooldown evaluator to see the previous tick's row, not the row
    // we're about to write. Moving the GET to "after send" would race
    // with the writer and turn every re-send into a `conflicts: 1`
    // observation — masking the real cooldown signal we're trying to
    // measure.
    //
    // The evaluator is short-circuited by `mode === 'off'` (decision
    // === null). When that happens we skip the per-cluster GET pipeline
    // entirely — no Upstash traffic, no log line. This makes the
    // operator-side kill switch instant: flip Railway env to 'off',
    // next tick spends zero on cooldown.
    const cooldownDecisions = [];
    const ruleIdComposite = `${rule.variant ?? 'full'}:${rule.lang ?? 'en'}:${rule.sensitivity ?? 'high'}`;
    // Codex PR #3617 P1 — real per-cluster source count for U4 writes
    // and U5 cooldown evaluation.
    //
    // The brief envelope's BriefStory schema only carries a single
    // `source` string (the primary wire) — the original cluster's full
    // sources[] array is not preserved. Reading 0/1 off briefStory.source
    // collapses real source counts (5, 10, 37+) and breaks U5's "+5
    // sources within floor" evolution bypass: the delta from N to 0/1
    // is always 0 or 1, never ≥5. Without this, today's shadow rows
    // seed bad history that Sprint 2's enforce mode would inherit.
    //
    // Fix: derive sourceCount from the raw clustered `stories` pool
    // (post-buildDigest, pre-filterTopStories) where the original
    // sources[] is still attached. Match by cluster identity:
    // mergedHashes[0] when present (rep's own hash by U3's contract),
    // else the story's own hash (singletons). One Map build per send,
    // O(1) lookup per cluster iteration.
    const sourceCountByClusterId = new Map();
    if (Array.isArray(stories)) {
      for (const rawStory of stories) {
        const repHash = Array.isArray(rawStory?.mergedHashes)
          && rawStory.mergedHashes.length > 0
          && typeof rawStory.mergedHashes[0] === 'string'
          ? rawStory.mergedHashes[0]
          : (typeof rawStory?.hash === 'string' ? rawStory.hash : '');
        if (!repHash) continue;
        const sources = Array.isArray(rawStory?.sources) ? rawStory.sources : [];
        // Existing entry wins (first-rep-by-iteration order). Raw
        // stories shouldn't duplicate clusterIds post-dedup, but the
        // defensive first-write semantics protect against a future
        // dedup bug double-counting sources.
        if (!sourceCountByClusterId.has(repHash)) {
          sourceCountByClusterId.set(repHash, sources.length);
        }
      }
    }
    // Slot string mirrors the brief composer: `issueSlotInTz(nowMs, tz)`.
    // We use the same tz the composer used (rule.digestTimezone, default
    // 'UTC') so the slot naming aligns 1:1 with the brief envelope's
    // magazine URL slot. Operators grepping the shadow log by slot get
    // the same slot string they'd see in `brief:${userId}:${issueSlot}`.
    const cooldownSlot = issueSlotInTz(nowMs, rule.digestTimezone ?? 'UTC');
    if (
      cooldownConfig.mode === 'shadow'
      && Array.isArray(cooldownIterableStories)
      && cooldownIterableStories.length > 0
    ) {
      // Outer loop: one decision per (channel, cluster) tuple. Same
      // shape as the U4 writer's iteration so the shadow log's
      // `total` aligns with the writer's eventual write count under
      // healthy paths. Sequential awaits — same rationale as the U4
      // writer (≤12 clusters × ≤5 channels per user = ≤60 GETs;
      // bursty parallelism would compete with the rest of the cron's
      // Upstash traffic for no measurable latency win).
      //
      // Codex PR #3617 round-4 P2 — iterate cooldownIterableStories
      // (NOT briefEnvelopeStories) so the compose-miss fallback path
      // also gets U5 coverage. See the cooldownIterableStories
      // construction above for the unified-shape rationale.
      for (const ch of deliverableChannels) {
        for (const briefStory of cooldownIterableStories) {
          const clusterId = typeof briefStory?.clusterId === 'string' ? briefStory.clusterId : '';
          if (!clusterId) {
            // Same defensive branch as the U4 writer below — a v4
            // envelope MUST carry clusterId. Skip the GET here so we
            // don't construct a malformed key; the U4-side warn will
            // fire on the same iteration when the writer runs.
            continue;
          }
          const key = `digest:sent:v1:${rule.userId}:${ch.channelType}:${ruleIdComposite}:${clusterId}`;
          let lastDeliveredAt = null;
          let lastDeliveredSourceCount = null;
          let lastDeliveredTier = null;
          // Greptile PR #3617 P2 — read prior headline for the
          // EVOLUTION_NEW_FACT bypass. Older v4 rows written before
          // this fix won't carry the field; null is the safe default
          // (the evaluator skips the bypass when either side is null).
          let lastDeliveredHeadline = null;
          try {
            const raw = await upstashRest('GET', key);
            if (typeof raw === 'string' && raw.length > 0) {
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object') {
                if (Number.isFinite(parsed.sentAt)) lastDeliveredAt = parsed.sentAt;
                if (Number.isFinite(parsed.sourceCount)) lastDeliveredSourceCount = parsed.sourceCount;
                if (typeof parsed.severity === 'string') lastDeliveredTier = parsed.severity;
                if (typeof parsed.headline === 'string' && parsed.headline.length > 0) {
                  lastDeliveredHeadline = parsed.headline;
                }
              }
            }
          } catch (err) {
            // GET failed (transient Upstash, JSON parse error). Treat
            // as "no prior delivery" — the safe default in shadow mode
            // is `decision='allow'`, which never affects subsequent
            // sends. A real enforcement path (Sprint 2) will need to
            // decide whether to fail-open or fail-closed here; shadow
            // mode is fail-open by definition.
            console.warn(
              `[digest] U5 cooldown: GET failed for key=${key}: ${err?.message ?? err} — treating as no prior delivery`,
            );
          }
          const sourceDomain = (() => {
            const url = typeof briefStory?.sourceUrl === 'string' ? briefStory.sourceUrl : '';
            if (!url) return '';
            try {
              return new URL(url).hostname.toLowerCase();
            } catch {
              return '';
            }
          })();
          const severity = typeof briefStory?.threatLevel === 'string' ? briefStory.threatLevel : 'unknown';
          // Codex PR #3617 P1 — real source count from the raw clustered
          // story (sources[].length), not the BriefStory.source 0/1 collapse.
          // Falls back to 0 when the cluster doesn't appear in the raw
          // stories Map (defensive — shouldn't happen on the option-(a)
          // canonical-rule path, but a future bug shouldn't crash the cron).
          const currentSourceCount = sourceCountByClusterId.get(clusterId) ?? 0;
          const decision = evaluateCooldown({
            userId: rule.userId,
            slot: cooldownSlot,
            clusterId,
            channel: ch.channelType,
            ruleId: ruleIdComposite,
            type: null, // invoke stub classifier
            severity,
            currentSourceCount,
            currentTier: severity,
            lastDeliveredAt,
            lastDeliveredSourceCount,
            lastDeliveredTier,
            // Greptile PR #3617 P2 — drives EVOLUTION_NEW_FACT bypass.
            lastDeliveredHeadline,
            classifierInputs: {
              sourceDomain,
              headline: typeof briefStory?.headline === 'string' ? briefStory.headline : '',
            },
            options: { mode: cooldownConfig.mode, nowMs },
          });
          // `decision === null` is unreachable here (we guarded on
          // `mode === 'shadow'` at the loop entry) but defensive —
          // protects the shadow logger from a future code path that
          // calls evaluateCooldown with mode='off' inside the shadow
          // branch.
          if (decision !== null) cooldownDecisions.push(decision);
        }
      }
    }

    let anyDelivered = false;
    // Sprint 1 / U4 — per-channel/per-cluster delivered-log accumulator.
    // We aggregate tri-state counts across every (channel, cluster)
    // write for THIS user-rule send so the post-loop log line can
    // report a single summary instead of one line per cluster (with
    // ~12 clusters × ~5 channels that's 60 lines per user otherwise).
    // This sits ALONGSIDE the existing `anyDelivered` write below — the
    // delivered-log keys feed U5's cooldown evaluator (per-cluster
    // grain), the `digest:last-sent:v1:{user}:{variant}` write feeds
    // the cron's isDue gate (per-rule grain). Two separate concerns;
    // both writes happen on success.
    const deliveredLogResults = [];

    for (const ch of deliverableChannels) {
      let ok = false;
      if (ch.channelType === 'telegram' && ch.chatId) {
        // Phase 8: send the 3-image carousel first (best-effort), then
        // the full text. Caption on the carousel is a short teaser —
        // the long-form story list goes in the text message below so
        // it remains forwardable / quotable on its own.
        if (magazineUrl) {
          const caption = `<b>WorldMonitor Brief — ${shortDate}</b>\n${formatterStories.length} ${formatterStories.length === 1 ? 'thread' : 'threads'} on the desk today.`;
          await sendTelegramBriefCarousel(rule.userId, ch.chatId, caption, magazineUrl);
        }
        ok = await sendTelegram(rule.userId, ch.chatId, telegramText);
      } else if (ch.channelType === 'slack' && ch.webhookEnvelope) {
        ok = await sendSlack(rule.userId, ch.webhookEnvelope, slackText);
      } else if (ch.channelType === 'discord' && ch.webhookEnvelope) {
        ok = await sendDiscord(rule.userId, ch.webhookEnvelope, discordText);
      } else if (ch.channelType === 'email' && ch.email) {
        ok = await sendEmail(ch.email, subject, text, html);
      } else if (ch.channelType === 'webhook' && ch.webhookEnvelope) {
        // Webhook payload's `summary` field reads the canonical
        // briefLead — same string the email exec block + magazine
        // pull-quote use. Codex Round-1 Medium #6 (channel-scope
        // parity).
        //
        // Codex PR #3617 round-5 P1 — pass formatterStories (NOT raw
        // stories). Pre-fix the webhook serialised the full raw pool
        // (up to DIGEST_MAX_ITEMS=30) while every other channel
        // consumed formatterStories (post-cap, post-filter — what
        // U4/U5 also iterate via cooldownIterableStories). Webhook
        // users were therefore receiving cards that were never
        // shadow-evaluated and never seeded delivered-log rows for
        // future cooldown enforcement. Aligning to formatterStories
        // closes the channel-coverage gap so the webhook payload
        // exactly matches what U4 stamped + U5 evaluated for that
        // (user, rule, tick).
        ok = await sendWebhook(rule.userId, ch.webhookEnvelope, formatterStories, briefLead);
      }
      if (ok) {
        anyDelivered = true;
        // Sprint 1 / U4 — record one delivered-log entry per cluster
        // surfaced in this channel's body. The brief envelope's stories
        // are the canonical source set (post-cap, post-filter, ⊆ U7
        // invariant); the formatter shim above maps them into the
        // raw-shape used by formatDigest, which means the SAME stories
        // were surfaced to the user.
        //
        // Order of operations: send first, write second. If the writer
        // fails AFTER the channel succeeded, the story is eligible to
        // re-air on the next tick. We accept that trade-off (extra
        // edition beats silent suppression of a real delivery
        // problem) — see digest-delivered-log.mjs's "Failure-mode
        // trade-off" docblock for the canonical rationale.
        //
        // Per-cluster writer is awaited sequentially: under option (a)
        // we ship ≤12 clusters × ≤5 channels per user, so the
        // sequential cost is ~bounded at 60 SET commands per user.
        // Parallelising via Promise.all would add bursty load to the
        // same Upstash account that's serving the rest of the cron;
        // sequential is simpler and the latency budget already
        // tolerates it.
        // Codex PR #3617 round-4 P2 — iterate cooldownIterableStories
        // (unified across brief-success + compose-miss). See the
        // cooldownIterableStories construction above for rationale.
        if (Array.isArray(cooldownIterableStories) && cooldownIterableStories.length > 0) {
          for (const briefStory of cooldownIterableStories) {
            const clusterId = typeof briefStory?.clusterId === 'string'
              ? briefStory.clusterId
              : '';
            if (!clusterId) {
              // Defensive: a v4 envelope MUST carry clusterId per
              // assertBriefEnvelope. Under compose-miss, clusterId is
              // derived from raw mergedHashes[0]/hash — always present
              // for valid raw stories. Skip the write on missing
              // clusterId either way (malformed key would throw).
              console.warn(
                `[digest] U4 delivered-log: brief story missing clusterId — ` +
                  `user=${rule.userId} channel=${ch.channelType} headline=${JSON.stringify(briefStory?.headline ?? '<missing>')}. ` +
                  `Skipping log write for this cluster.`,
              );
              continue;
            }
            try {
              const writeResult = await writeDeliveredEntry({
                userId: rule.userId,
                channel: ch.channelType,
                ruleId: `${rule.variant ?? 'full'}:${rule.lang ?? 'en'}:${rule.sensitivity ?? 'high'}`,
                clusterId,
                sentAt: nowMs,
                // Codex PR #3617 P1 — real source count, not the
                // 0/1 collapse from BriefStory.source. See the
                // sourceCountByClusterId Map construction above the
                // U5 cooldown loop for the full rationale.
                sourceCount: sourceCountByClusterId.get(clusterId) ?? 0,
                severity: typeof briefStory?.threatLevel === 'string' ? briefStory.threatLevel : 'unknown',
                // Greptile PR #3617 P2 — persist headline so the next
                // tick's cooldown evaluator can drive the
                // EVOLUTION_NEW_FACT bypass via string-equality
                // compare. cooldownIterableStories carries the
                // canonical headline in both branches (BriefStory
                // shape under brief-success; synthesized from raw
                // story.title under compose-miss).
                headline: typeof briefStory?.headline === 'string' ? briefStory.headline : '',
              });
              deliveredLogResults.push(writeResult);
            } catch (err) {
              // writeDeliveredEntry only throws on programmer error
              // (empty key components). Network/Upstash failures map
              // to {errors: 1} in the tri-state result. A throw here
              // means a v4 envelope leaked through with bad fields;
              // record as error in the aggregate so it surfaces in
              // the summary line below.
              console.warn(
                `[digest] U4 delivered-log: writeDeliveredEntry threw for ` +
                  `user=${rule.userId} channel=${ch.channelType} clusterId=${clusterId}: ${err?.message ?? err}`,
              );
              deliveredLogResults.push({ written: 0, conflicts: 0, errors: 1 });
            }
          }
        }
      }
    }
    // Sprint 1 / U4 summary — one line per user-rule send, not per
    // (channel, cluster) write. Operators can tail this as a single
    // line per user. Tri-state counters distinguish:
    //   - written  = first-time delivered-log entries (cooldown table starts here)
    //   - conflicts = NX-collide on existing keys (idempotent re-write,
    //                 happens when the same (channel, rule, cluster)
    //                 ships twice within the 30d±jitter TTL window —
    //                 expected for sustained-narrative re-airs)
    //   - errors   = Upstash transport failure or invariant break —
    //                next tick re-airs the story to the affected
    //                channel (see digest-delivered-log.mjs failure-mode
    //                docblock).
    if (deliveredLogResults.length > 0) {
      const aggregate = aggregateDeliveredResults(deliveredLogResults);
      const logFn = aggregate.errors > 0 ? console.warn : console.log;
      logFn(
        `[digest] U4 delivered-log user=${rule.userId} ` +
          `rule=${rule.variant ?? 'full'}:${rule.lang ?? 'en'}:${rule.sensitivity ?? 'high'} ` +
          `written=${aggregate.written} conflicts=${aggregate.conflicts} errors=${aggregate.errors} ` +
          `total=${deliveredLogResults.length}`,
      );
    }

    // Sprint 1 / U5 — shadow-mode cooldown summary line. ONE line per
    // user-rule send (not per cluster, not per channel) so a busy cron
    // doesn't flood Sentry. Skipped entirely when no decisions were
    // accumulated (mode='off' OR no brief envelope OR all clusters
    // missing clusterId). The logger promotes to console.warn when
    // any decision had `classificationMissing: true` — that's real
    // signal for Sprint 3's classifier work.
    //
    // The line is independent of `anyDelivered` — we want the would-
    // have-suppressed counter even on no-channel-success ticks (those
    // are the operator-visible cases where shadow telemetry matters
    // most: "we'd have suppressed even MORE if the send had succeeded").
    emitCooldownShadowLog({
      userId: rule.userId,
      ruleId: ruleIdComposite,
      slot: cooldownSlot,
      decisions: cooldownDecisions,
    });

    if (anyDelivered) {
      await upstashRest(
        'SET', lastSentKey, JSON.stringify({ sentAt: nowMs }), 'EX', '691200', // 8 days
      );
      sentCount++;
      // Story count reports the formatter-shape length (post-cap,
      // post-filter slice) — what the user actually received in their
      // digest. Pre-U7-fix this read `stories.length` (raw 30 from
      // buildDigest), which over-counted by up to ~18 vs the cards
      // the user saw.
      console.log(
        `[digest] Sent ${formatterStories.length} stories to ${rule.userId} (${rule.variant}, ${rule.digestMode})`,
      );
      // Parity observability. Gated on AI_DIGEST_ENABLED + per-rule
      // aiDigestEnabled — without this guard, opt-out users (briefLead
      // is intentionally null) trigger PARITY REGRESSION every tick
      // (null !== '<envelope stub lead>'), flooding Sentry with
      // false positives. Greptile P1 on PR #3396.
      //
      // Sprint 1 / U2 — option (a) made `winner_match=true` the
      // UNIVERSAL invariant: the canonical-rule filter at the top of
      // the loop ensures every send is the user's winning rule for
      // this slot. Two consequences:
      //
      // 1. `winner_match=false` was previously "expected divergence
      //    for a non-winner rule send"; under option (a) it can ONLY
      //    indicate a bug — most likely briefByUser missing the user
      //    OR chosenVariant drifting between compose and send. Treat
      //    as a hard alarm, not a periodic mismatch warning.
      // 2. `channels_equal=false` while `winner_match=true` retains
      //    its pre-U2 meaning — canonical-synthesis cache row drift.
      //    Same PARITY REGRESSION alarm semantics.
      //
      // Both alarms warn on the same console.warn channel so Sentry's
      // console-breadcrumb hook surfaces them without explicit
      // captureMessage calls.
      if (AI_DIGEST_ENABLED && rule.aiDigestEnabled !== false) {
        const envLead = brief?.envelope?.data?.digest?.lead ?? '';
        const winnerVariant = brief?.chosenVariant ?? '';
        const winnerMatch = winnerVariant === (rule.variant ?? 'full');
        const channelsEqual = briefLead === envLead;
        const publicLead = brief?.envelope?.data?.digest?.publicLead ?? '';
        console.log(
          `[digest] brief lead parity user=${rule.userId} ` +
            `rule=${rule.variant ?? 'full'}:${rule.sensitivity ?? 'high'}:${rule.lang ?? 'en'} ` +
            `winner_match=${winnerMatch} ` +
            `synthesis_level=${synthesisLevel} ` +
            `exec_len=${(briefLead ?? '').length} ` +
            `brief_lead_len=${envLead.length} ` +
            `channels_equal=${channelsEqual} ` +
            `public_lead_len=${publicLead.length}`,
        );
        if (!winnerMatch) {
          // Under option (a) this is unreachable in practice — the
          // canonical-rule filter at the top of the loop drops every
          // non-winner rule before this point. If we ever see it in
          // production, the canonical-rule filter has been bypassed
          // OR briefByUser/chosenVariant drifted between compose and
          // send. Hard alarm.
          console.warn(
            `[digest] PARITY REGRESSION user=${rule.userId} — winner_match=false under option (a). ` +
              `Expected: winner_variant=${winnerVariant || '<missing>'} === rule_variant=${rule.variant ?? 'full'}. ` +
              `Investigate: canonical-rule filter bypass OR compose↔send chosenVariant drift.`,
          );
        } else if (!channelsEqual && briefLead && envLead) {
          // Canonical-synthesis cache row drifted between compose and
          // send passes — a real contract break. Same semantics as
          // pre-U2 PARITY REGRESSION.
          console.warn(
            `[digest] PARITY REGRESSION user=${rule.userId} — winner-rule channel lead != envelope lead. ` +
              `Investigate: cache drift between compose pass and send pass?`,
          );
        }
      }
    }
  }

  console.log(`[digest] Cron run complete: ${sentCount} digest(s) sent`);

  // Brief-compose failure gate. Runs at the very end so a compose-
  // layer outage (Upstash blip, insights key stale, signing secret
  // missing) never blocks digest delivery to users — but Railway
  // still flips the run red so ops see the signal. Denominator is
  // attempted writes (shouldExitNonZero enforces this).
  if (shouldExitOnBriefFailures({ success: composeSuccess, failed: composeFailed })) {
    console.warn(
      `[digest] brief: exiting non-zero — compose_failed=${composeFailed} compose_success=${composeSuccess} crossed the threshold`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[digest] Fatal:', err);
  process.exit(1);
});
