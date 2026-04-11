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

// ── Fuzzy deduplication ──────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','in','on','at','to','for','of','is','are','was','were',
  'has','have','had','be','been','by','from','with','as','it','its',
  'says','say','said','according','reports','report','officials','official',
  'us','new','will','can','could','would','may','also','who','that','this',
  'after','about','over','more','up','out','into','than','some','other',
]);

function stripSourceSuffix(title) {
  return title
    .replace(/\s*[-–—]\s*[\w\s.]+\.(?:com|org|net|co\.uk)\s*$/i, '')
    .replace(/\s*[-–—]\s*(?:Reuters|AP News|BBC|CNN|Al Jazeera|France 24|DW News|PBS NewsHour|CBS News|NBC|ABC|Associated Press|The Guardian|NOS Nieuws|Tagesschau|CNBC|The National)\s*$/i, '');
}

function extractTitleWords(title) {
  return new Set(
    stripSourceSuffix(title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function deduplicateStories(stories) {
  const clusters = [];
  for (const story of stories) {
    const words = extractTitleWords(story.title);
    let merged = false;
    for (const cluster of clusters) {
      if (jaccardSimilarity(words, cluster.words) > 0.55) {
        cluster.items.push(story);
        merged = true;
        break;
      }
    }
    if (!merged) clusters.push({ words, items: [story] });
  }
  return clusters.map(({ items }) => {
    items.sort((a, b) => b.currentScore - a.currentScore || b.mentionCount - a.mentionCount);
    const best = { ...items[0] };
    if (items.length > 1) {
      best.mentionCount = items.reduce((sum, s) => sum + s.mentionCount, 0);
    }
    best.mergedHashes = items.map(s => s.hash);
    return best;
  });
}

// ── Digest content ────────────────────────────────────────────────────────────

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
  const deduped = deduplicateStories(stories);
  const top = deduped.slice(0, DIGEST_MAX_ITEMS);

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
  const storiesHash = hashShort(stories.map(s =>
    `${s.titleHash ?? s.title}:${s.severity ?? ''}:${s.phase ?? ''}:${(s.sources ?? []).slice(0, 3).join(',')}`
  ).sort().join('|'));
  const ctxHash = hashShort(JSON.stringify(ctx));
  const cacheKey = `digest:ai-summary:v1:${variant}:${storiesHash}:${ctxHash}`;

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

User profile:
${profile}

Rules:
- Lead with the single most impactful development for this user
- Connect events to watched assets/regions where relevant
- 3-5 bullet points, 1-2 sentences each
- Flag anything directly affecting watched assets
- Separate facts from assessment
- End with "Signals to watch:" (1-2 items)
- Under 250 words`;

  const summary = await callLLM(systemPrompt, storyList, { maxTokens: 600, temperature: 0.3, timeoutMs: 15_000 });
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

async function sendTelegram(userId, chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[digest] Telegram: TELEGRAM_BOT_TOKEN not set, skipping');
    return false;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-digest/1.0' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
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
      console.warn(`[digest] Telegram send failed ${res.status} for ${userId}`);
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
function buildChannelBodies(storyListPlain, aiSummary) {
  if (!aiSummary) {
    return {
      text: storyListPlain,
      telegramText: escapeTelegramHtml(storyListPlain),
      slackText: escapeSlackMrkdwn(storyListPlain),
      discordText: storyListPlain,
    };
  }
  return {
    text: `EXECUTIVE SUMMARY\n\n${aiSummary}\n\n${DIVIDER}\n\n${storyListPlain}`,
    telegramText: `<b>EXECUTIVE SUMMARY</b>\n\n${markdownToTelegramHtml(aiSummary)}\n\n${DIVIDER}\n\n${escapeTelegramHtml(storyListPlain)}`,
    slackText: `*EXECUTIVE SUMMARY*\n\n${markdownToSlackMrkdwn(aiSummary)}\n\n${DIVIDER}\n\n${escapeSlackMrkdwn(storyListPlain)}`,
    discordText: `**EXECUTIVE SUMMARY**\n\n${markdownToDiscord(aiSummary)}\n\n${DIVIDER}\n\n${storyListPlain}`,
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

    const { text, telegramText, slackText, discordText } = buildChannelBodies(storyListPlain, aiSummary);
    const html = injectEmailSummary(htmlRaw, aiSummary);

    const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(nowMs));
    const subject = aiSummary ? `WorldMonitor Intelligence Brief — ${shortDate}` : `WorldMonitor Digest — ${shortDate}`;

    let anyDelivered = false;

    for (const ch of deliverableChannels) {
      let ok = false;
      if (ch.channelType === 'telegram' && ch.chatId) {
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
}

main().catch((err) => {
  console.error('[digest] Fatal:', err);
  process.exit(1);
});
