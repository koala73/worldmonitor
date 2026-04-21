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
  markdownToEmailHtml,
  markdownToTelegramHtml,
  markdownToSlackMrkdwn,
  markdownToDiscord,
} from './_digest-markdown.mjs';

const require = createRequire(import.meta.url);
const { decrypt } = require('./lib/crypto.cjs');
const { callLLM } = require('./lib/llm-chain.cjs');
const { fetchUserPreferences, extractUserContext, formatUserProfile } = require('./lib/user-context.cjs');
const { Resend } = require('resend');
import { readRawJsonFromUpstash, redisPipeline } from '../api/_upstash-json.js';
import {
  composeBriefFromDigestStories,
  extractInsights,
  groupEligibleRulesByUser,
  shouldExitNonZero as shouldExitOnBriefFailures,
} from './lib/brief-compose.mjs';
import { issueSlotInTz } from '../shared/brief-filter.js';
import { enrichBriefEnvelopeWithLLM } from './lib/brief-llm.mjs';
import { parseDigestOnlyUser } from './lib/digest-only-user.mjs';
import { assertBriefEnvelope } from '../server/_shared/brief-render.js';
import { signBriefUrl, BriefUrlError } from './lib/brief-url-sign.mjs';
import {
  deduplicateStories,
  groupTopicsPostDedup,
  readOrchestratorConfig,
} from './lib/brief-dedup.mjs';
import { stripSourceSuffix } from './lib/brief-dedup-jaccard.mjs';

// ── Config ────────────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const RESEND_FROM = process.env.RESEND_FROM_EMAIL ?? 'WorldMonitor <alerts@worldmonitor.app>';

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
const AI_SUMMARY_CACHE_TTL = 3600; // 1h
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
// The brief is a once-per-day editorial snapshot. 24h is the natural
// window regardless of a user's email cadence (daily / twice_daily /
// weekly) — weekly subscribers still expect a fresh brief each day
// in the dashboard panel. Matches DIGEST_LOOKBACK_MS so first-send
// users see identical story pools in brief and email.
const BRIEF_STORY_WINDOW_MS = 24 * 60 * 60 * 1000;
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
    story.description !== story.headline
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

  const trackResults = await upstashPipeline(
    hashes.map((h) => ['HGETALL', `story:track:v1:${h}`]),
  );

  const stories = [];
  for (let i = 0; i < hashes.length; i++) {
    const raw = trackResults[i]?.result;
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const track = flatArrayToObject(raw);
    if (!track.title || !track.severity) continue;

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
    });
  }

  if (stories.length === 0) return null;

  stories.sort((a, b) => b.currentScore - a.currentScore);
  const cfg = readOrchestratorConfig(process.env);
  const { reps: dedupedAll, embeddingByHash, logSummary } =
    await deduplicateStories(stories);
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

  const allSourceCmds = [];
  const cmdIndex = [];
  for (let i = 0; i < top.length; i++) {
    const hashes = top[i].mergedHashes ?? [top[i].hash];
    for (const h of hashes) {
      allSourceCmds.push(['SMEMBERS', `story:sources:v1:${h}`]);
      cmdIndex.push(i);
    }
  }
  const sourceResults = await upstashPipeline(allSourceCmds);
  for (let i = 0; i < top.length; i++) top[i].sources = [];
  for (let j = 0; j < sourceResults.length; j++) {
    const arr = sourceResults[j]?.result ?? [];
    for (const src of arr) {
      if (!top[cmdIndex[j]].sources.includes(src)) top[cmdIndex[j]].sources.push(src);
    }
  }

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
    const meta = [
      phaseCap ? `<span style="font-size: 10px; color: ${phaseColor}; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">${phaseCap}</span>` : '',
      srcText ? `<span style="font-size: 11px; color: #555;">${escapeHtml(srcText)}</span>` : '',
    ].filter(Boolean).join('<span style="color: #333; margin: 0 6px;">&bull;</span>');
    return `<div style="background: #111; border: 1px solid #1a1a1a; border-left: 3px solid ${borderColor}; padding: 12px 16px; margin-bottom: 8px;">${titleEl}${meta ? `<div style="margin-top: 6px;">${meta}</div>` : ''}</div>`;
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

// ── AI summary generation ────────────────────────────────────────────────────

function hashShort(str) {
  return createHash('sha256').update(str).digest('hex').slice(0, 16);
}

async function generateAISummary(stories, rule) {
  if (!AI_DIGEST_ENABLED) return null;
  if (!stories || stories.length === 0) return null;

  // rule.aiDigestEnabled (from alertRules) is the user's explicit opt-in for
  // AI summaries. userPreferences is a SEPARATE table (SPA app settings blob:
  // watchlist, airports, panels). A user can have alertRules without having
  // ever saved userPreferences — or under a different variant. Missing prefs
  // must NOT silently disable the feature the user just enabled; degrade to
  // a non-personalized summary instead.
  //   error: true  = transient fetch failure (network, non-OK HTTP, env missing)
  //   error: false = the (userId, variant) row genuinely does not exist
  // Both cases degrade to a non-personalized summary, but log them distinctly
  // so transient fetch failures are visible in observability.
  const { data: prefs, error: prefsFetchError } = await fetchUserPreferences(rule.userId, rule.variant ?? 'full');
  if (!prefs) {
    console.log(
      prefsFetchError
        ? `[digest] Prefs fetch failed for ${rule.userId} — generating non-personalized AI summary`
        : `[digest] No stored preferences for ${rule.userId} — generating non-personalized AI summary`,
    );
  }
  const ctx = extractUserContext(prefs);
  const profile = formatUserProfile(ctx, rule.variant ?? 'full');

  const variant = rule.variant ?? 'full';
  const tz = rule.digestTimezone ?? 'UTC';
  const localHour = toLocalHour(Date.now(), tz);
  if (localHour === -1) console.warn(`[digest] Bad timezone "${tz}" for ${rule.userId} — defaulting to evening greeting`);
  const greeting = localHour >= 5 && localHour < 12 ? 'Good morning'
    : localHour >= 12 && localHour < 17 ? 'Good afternoon'
    : 'Good evening';
  const storiesHash = hashShort(stories.map(s =>
    `${s.titleHash ?? s.title}:${s.severity ?? ''}:${s.phase ?? ''}:${(s.sources ?? []).slice(0, 3).join(',')}`
  ).sort().join('|'));
  const ctxHash = hashShort(JSON.stringify(ctx));
  const cacheKey = `digest:ai-summary:v1:${variant}:${greeting}:${storiesHash}:${ctxHash}`;

  try {
    const cached = await upstashRest('GET', cacheKey);
    if (cached) {
      console.log(`[digest] AI summary cache hit for ${rule.userId}`);
      return cached;
    }
  } catch { /* miss */ }

  const dateStr = new Date().toISOString().split('T')[0];
  const storyList = stories.slice(0, 20).map((s, i) => {
    const phase = s.phase ? ` [${s.phase}]` : '';
    const src = s.sources?.length > 0 ? ` (${s.sources.slice(0, 2).join(', ')})` : '';
    return `${i + 1}. [${(s.severity ?? 'high').toUpperCase()}]${phase} ${s.title}${src}`;
  }).join('\n');

  const systemPrompt = `You are WorldMonitor's intelligence analyst. Today is ${dateStr} UTC.
Write a personalized daily brief for a user focused on ${rule.variant ?? 'full'} intelligence.
The user's local time greeting is "${greeting}" — use this exact greeting to open the brief.

User profile:
${profile}

Rules:
- Open with "${greeting}." followed by the brief
- Lead with the single most impactful development for this user
- Connect events to watched assets/regions where relevant
- 3-5 bullet points, 1-2 sentences each
- Flag anything directly affecting watched assets
- Separate facts from assessment
- End with "Signals to watch:" (1-2 items)
- Under 250 words`;

  const summary = await callLLM(systemPrompt, storyList, { maxTokens: 600, temperature: 0.3, timeoutMs: 15_000, skipProviders: ['groq'] });
  if (!summary) {
    console.warn(`[digest] AI summary generation failed for ${rule.userId}`);
    return null;
  }

  try {
    await upstashRest('SET', cacheKey, summary, 'EX', String(AI_SUMMARY_CACHE_TTL));
  } catch { /* best-effort cache write */ }

  console.log(`[digest] AI summary generated for ${rule.userId} (${summary.length} chars)`);
  return summary;
}

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

/**
 * Inject the formatted AI summary into the HTML email template's slot,
 * or strip the slot placeholder when there is no summary.
 */
function injectEmailSummary(html, aiSummary) {
  if (!html) return html;
  if (!aiSummary) return html.replace('<div data-ai-summary-slot></div>', '');
  const formattedSummary = markdownToEmailHtml(aiSummary);
  const summaryHtml = `<div style="background:#161616;border:1px solid #222;border-left:3px solid #4ade80;padding:18px 22px;margin:0 0 24px 0;">
<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#4ade80;margin-bottom:10px;">Executive Summary</div>
<div style="font-size:13px;line-height:1.7;color:#ccc;">${formattedSummary}</div>
</div>`;
  return html.replace('<div data-ai-summary-slot></div>', summaryHtml);
}

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

  // Memoize buildDigest by (variant, lang, windowStart). Many users
  // share a variant/lang, so this saves ZRANGE + HGETALL round-trips
  // across the per-user loop. Scoped to this cron run — no cross-run
  // memoization needed (Redis is authoritative).
  const windowStart = nowMs - BRIEF_STORY_WINDOW_MS;
  const digestCache = new Map();
  async function digestFor(candidate) {
    const key = `${candidate.variant ?? 'full'}:${candidate.lang ?? 'en'}:${windowStart}`;
    if (digestCache.has(key)) return digestCache.get(key);
    const stories = await buildDigest(candidate, windowStart);
    digestCache.set(key, stories ?? []);
    return stories ?? [];
  }

  const eligibleByUser = groupEligibleRulesByUser(rules);
  let composeSuccess = 0;
  let composeFailed = 0;
  for (const [userId, candidates] of eligibleByUser) {
    try {
      const hit = await composeAndStoreBriefForUser(userId, candidates, insightsNumbers, digestFor, nowMs);
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
    `[digest] brief: compose_success=${composeSuccess} compose_failed=${composeFailed} total_users=${eligibleByUser.size}`,
  );
  return { briefByUser, composeSuccess, composeFailed };
}

/**
 * Per-user: walk candidates, for each pull the per-variant digest
 * story pool (same pool buildDigest feeds to the email), and compose
 * the brief envelope from the first candidate that yields non-empty
 * stories. SETEX the envelope, sign the magazine URL. Returns the
 * entry the caller should stash in briefByUser, or null when no
 * candidate had stories.
 */
async function composeAndStoreBriefForUser(userId, candidates, insightsNumbers, digestFor, nowMs) {
  let envelope = null;
  let chosenVariant = null;
  let chosenCandidate = null;
  for (const candidate of candidates) {
    const digestStories = await digestFor(candidate);
    if (!digestStories || digestStories.length === 0) continue;
    const composed = composeBriefFromDigestStories(
      candidate,
      digestStories,
      insightsNumbers,
      { nowMs },
    );
    if (composed) {
      envelope = composed;
      chosenVariant = candidate.variant;
      chosenCandidate = candidate;
      break;
    }
  }
  if (!envelope) return null;

  // Phase 3b — LLM enrichment. Substitutes the stubbed whyMatters /
  // lead / threads / signals fields with Gemini 2.5 Flash output.
  // Pure passthrough on any failure: the baseline envelope has
  // already passed validation and is safe to ship as-is. Do NOT
  // abort composition if the LLM is down; the stub is better than
  // no brief.
  if (BRIEF_LLM_ENABLED && chosenCandidate) {
    const baseline = envelope;
    try {
      const enriched = await enrichBriefEnvelopeWithLLM(envelope, chosenCandidate, briefLlmDeps);
      // Defence in depth: re-validate the enriched envelope against
      // the renderer's strict contract before we SETEX it. If
      // enrichment produced a structurally broken shape (bad cache
      // row, code bug, upstream type drift) we'd otherwise SETEX it
      // and /api/brief would 404 the user's brief at read time. Fall
      // back to the unenriched baseline — which is already known to
      // pass assertBriefEnvelope() because composeBriefFromDigestStories
      // asserted on construction.
      try {
        assertBriefEnvelope(enriched);
        envelope = enriched;
      } catch (assertErr) {
        console.warn(`[digest] brief: enriched envelope failed assertion for ${userId} — shipping stubbed:`, assertErr?.message);
        envelope = baseline;
      }
    } catch (err) {
      console.warn(`[digest] brief: LLM enrichment threw for ${userId} — shipping stubbed envelope:`, err?.message);
      envelope = baseline;
    }
  }

  // Slot (YYYY-MM-DD-HHMM in the user's tz) is what routes the
  // magazine URL + Redis key. Using the same tz the composer used to
  // produce envelope.data.date guarantees the slot's date portion
  // matches the displayed date. Two same-day compose runs produce
  // distinct slots so each digest dispatch freezes its own URL.
  const briefTz = chosenCandidate?.digestTimezone ?? 'UTC';
  const issueSlot = issueSlotInTz(nowMs, briefTz);
  const key = `brief:${userId}:${issueSlot}`;
  // The latest-pointer lets readers (dashboard panel, share-url
  // endpoint) locate the most recent brief without knowing the slot.
  // One SET per compose is cheap and always current.
  const latestPointerKey = `brief:latest:${userId}`;
  const latestPointerValue = JSON.stringify({ issueSlot });
  const pipelineResult = await redisPipeline([
    ['SETEX', key, String(BRIEF_TTL_SECONDS), JSON.stringify(envelope)],
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
  return { envelope, magazineUrl, chosenVariant };
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

  let sentCount = 0;

  for (const rule of rules) {
    if (!rule.userId || !rule.variant) continue;

    const lastSentKey = `digest:last-sent:v1:${rule.userId}:${rule.variant}`;
    let lastSentAt = null;
    try {
      const raw = await upstashRest('GET', lastSentKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        lastSentAt = typeof parsed.sentAt === 'number' ? parsed.sentAt : null;
      }
    } catch { /* first send */ }

    if (!isDue(rule, lastSentAt)) continue;

    const pro = await isUserPro(rule.userId);
    if (!pro) {
      console.log(`[digest] Skipping ${rule.userId} — not PRO`);
      continue;
    }

    const windowStart = lastSentAt ?? (nowMs - DIGEST_LOOKBACK_MS);
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

    let aiSummary = null;
    if (AI_DIGEST_ENABLED && rule.aiDigestEnabled !== false) {
      aiSummary = await generateAISummary(stories, rule);
    }

    const storyListPlain = formatDigest(stories, nowMs);
    if (!storyListPlain) continue;
    const htmlRaw = formatDigestHtml(stories, nowMs);

    const brief = briefByUser.get(rule.userId);
    const magazineUrl = brief?.magazineUrl ?? null;
    const { text, telegramText, slackText, discordText } = buildChannelBodies(
      storyListPlain,
      aiSummary,
      magazineUrl,
    );
    const htmlWithSummary = injectEmailSummary(htmlRaw, aiSummary);
    const html = injectBriefCta(htmlWithSummary, magazineUrl);

    const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(nowMs));
    const subject = aiSummary ? `WorldMonitor Intelligence Brief — ${shortDate}` : `WorldMonitor Digest — ${shortDate}`;

    let anyDelivered = false;

    for (const ch of deliverableChannels) {
      let ok = false;
      if (ch.channelType === 'telegram' && ch.chatId) {
        // Phase 8: send the 3-image carousel first (best-effort), then
        // the full text. Caption on the carousel is a short teaser —
        // the long-form story list goes in the text message below so
        // it remains forwardable / quotable on its own.
        if (magazineUrl) {
          const caption = `<b>WorldMonitor Brief — ${shortDate}</b>\n${stories.length} ${stories.length === 1 ? 'thread' : 'threads'} on the desk today.`;
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
        ok = await sendWebhook(rule.userId, ch.webhookEnvelope, stories, aiSummary);
      }
      if (ok) anyDelivered = true;
    }

    if (anyDelivered) {
      await upstashRest(
        'SET', lastSentKey, JSON.stringify({ sentAt: nowMs }), 'EX', '691200', // 8 days
      );
      sentCount++;
      console.log(
        `[digest] Sent ${stories.length} stories to ${rule.userId} (${rule.variant}, ${rule.digestMode})`,
      );
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
