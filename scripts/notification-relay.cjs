'use strict';

const { createHash } = require('node:crypto');
const dns = require('node:dns').promises;
const { ConvexHttpClient } = require('convex/browser');
const { Resend } = require('resend');
const { decrypt } = require('./lib/crypto.cjs');
const { callLLM } = require('./lib/llm-chain.cjs');
const { fetchUserPreferences, extractUserContext, formatUserProfile } = require('./lib/user-context.cjs');

// ── Config ────────────────────────────────────────────────────────────────────

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? '';
const CONVEX_URL = process.env.CONVEX_URL ?? '';
// Convex HTTP actions are hosted at *.convex.site (not *.convex.cloud)
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? CONVEX_URL.replace('.convex.cloud', '.convex.site');
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? '';
const RESEND_FROM = process.env.RESEND_FROM_EMAIL ?? 'WorldMonitor <alerts@worldmonitor.app>';
// When QUIET_HOURS_BATCH_ENABLED=0, treat batch_on_wake as critical_only.
// Useful during relay rollout to disable queued batching before drainBatchOnWake is fully tested.
const QUIET_HOURS_BATCH_ENABLED = process.env.QUIET_HOURS_BATCH_ENABLED !== '0';
const AI_IMPACT_ENABLED = process.env.AI_IMPACT_ENABLED === '1';
const AI_IMPACT_CACHE_TTL = 1800; // 30 min, matches dedup window

if (!UPSTASH_URL || !UPSTASH_TOKEN) { console.error('[relay] UPSTASH_REDIS_REST_URL/TOKEN not set'); process.exit(1); }
if (!CONVEX_URL) { console.error('[relay] CONVEX_URL not set'); process.exit(1); }
if (!RELAY_SECRET) { console.error('[relay] RELAY_SHARED_SECRET not set'); process.exit(1); }

const convex = new ConvexHttpClient(CONVEX_URL);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ── Upstash REST helpers ──────────────────────────────────────────────────────

async function upstashRest(...args) {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'User-Agent': 'worldmonitor-relay/1.0' },
  });
  if (!res.ok) {
    console.warn(`[relay] Upstash error ${res.status} for command ${args[0]}`);
    return null;
  }
  const json = await res.json();
  return json.result;
}

// ── Dedup ─────────────────────────────────────────────────────────────────────

function sha256Hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

async function checkDedup(userId, eventType, title) {
  const hash = sha256Hex(`${eventType}:${title}`);
  const key = `wm:notif:dedup:${userId}:${hash}`;
  const result = await upstashRest('SET', key, '1', 'NX', 'EX', '1800');
  return result === 'OK'; // true = new, false = duplicate
}

// ── Channel deactivation ──────────────────────────────────────────────────────

async function deactivateChannel(userId, channelType) {
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/deactivate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RELAY_SECRET}`,
        'User-Agent': 'worldmonitor-relay/1.0',
      },
      body: JSON.stringify({ userId, channelType }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.warn(`[relay] Deactivate failed ${userId}/${channelType}: ${res.status}`);
  } catch (err) {
    console.warn(`[relay] Deactivate request failed for ${userId}/${channelType}:`, err.message);
  }
}

// ── Entitlement check (PRO gate for delivery) ───────────────────────────────

const ENTITLEMENT_CACHE_TTL = 900; // 15 min

async function isUserPro(userId) {
  const cacheKey = `relay:entitlement:${userId}`;
  try {
    const cached = await upstashRest('GET', cacheKey);
    if (cached !== null) return Number(cached) >= 1;
  } catch { /* miss */ }
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/entitlement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-relay/1.0' },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return true; // fail-open: don't block delivery on entitlement service failure
    const { tier } = await res.json();
    await upstashRest('SET', cacheKey, String(tier ?? 0), 'EX', String(ENTITLEMENT_CACHE_TTL));
    return (tier ?? 0) >= 1;
  } catch {
    return true; // fail-open
  }
}

// ── Private IP guard ─────────────────────────────────────────────────────────

function isPrivateIP(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc|fd)/.test(ip);
}

// ── Quiet hours ───────────────────────────────────────────────────────────────

const { toLocalHour, isInQuietHours } = require('./lib/quiet-hours.cjs');

// Returns 'deliver' | 'suppress' | 'hold'
function resolveQuietAction(rule, severity) {
  if (!isInQuietHours(rule)) return 'deliver';
  const override = rule.quietHoursOverride ?? 'critical_only';
  if (override === 'silence_all') return 'suppress';
  if (override === 'batch_on_wake' && QUIET_HOURS_BATCH_ENABLED) {
    return severity === 'critical' ? 'deliver' : 'hold';
  }
  // critical_only (default): critical passes through, everything else suppressed
  return severity === 'critical' ? 'deliver' : 'suppress';
}

const QUIET_HELD_TTL = 86400; // 24h — held events expire if never drained

async function holdEvent(userId, variant, eventJson) {
  const key = `digest:quiet-held:${userId}:${variant}`;
  await upstashRest('RPUSH', key, eventJson);
  await upstashRest('EXPIRE', key, String(QUIET_HELD_TTL));
}

// Delivers (or discards) the held queue for a single user+variant.
// Used by both drainBatchOnWake (wake-up) and processFlushQuietHeld (settings change).
// allowedChannelTypes: which channels to attempt delivery on; null = use rule's channels.
async function drainHeldForUser(userId, variant, allowedChannelTypes) {
  const key = `digest:quiet-held:${userId}:${variant}`;
  const len = await upstashRest('LLEN', key);
  if (!len || len === 0) return;

  const items = await upstashRest('LRANGE', key, '0', '-1');
  if (!Array.isArray(items) || items.length === 0) return;

  const events = items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
  if (events.length === 0) { await upstashRest('DEL', key); return; }

  const lines = [`WorldMonitor — ${events.length} held alert${events.length !== 1 ? 's' : ''} from quiet hours`, ''];
  for (const ev of events) {
    lines.push(`[${(ev.severity ?? 'high').toUpperCase()}] ${ev.payload?.title ?? ev.eventType}`);
  }
  lines.push('', 'View full dashboard → worldmonitor.app');
  const text = lines.join('\n');
  const subject = `WorldMonitor — ${events.length} held alert${events.length !== 1 ? 's' : ''}`;

  let channels = [];
  try {
    const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-relay/1.0' },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(10000),
    });
    if (chRes.ok) channels = await chRes.json();
  } catch (err) {
    console.warn(`[relay] drainHeldForUser: channel fetch failed for ${userId}:`, err.message);
    return;
  }

  const verifiedChannels = channels.filter(c =>
    c.verified && (allowedChannelTypes == null || allowedChannelTypes.includes(c.channelType)),
  );
  let anyDelivered = false;
  for (const ch of verifiedChannels) {
    try {
      let ok = false;
      if (ch.channelType === 'telegram' && ch.chatId) ok = await sendTelegram(userId, ch.chatId, text);
      else if (ch.channelType === 'slack' && ch.webhookEnvelope) ok = await sendSlack(userId, ch.webhookEnvelope, text);
      else if (ch.channelType === 'discord' && ch.webhookEnvelope) ok = await sendDiscord(userId, ch.webhookEnvelope, text);
      else if (ch.channelType === 'email' && ch.email) ok = await sendEmail(ch.email, subject, text);
      else if (ch.channelType === 'webhook' && ch.webhookEnvelope) ok = await sendWebhook(userId, ch.webhookEnvelope, {
        eventType: 'quiet_hours_batch',
        severity: 'info',
        payload: {
          title: subject,
          alertCount: events.length,
          alerts: events.map(ev => ({ eventType: ev.eventType, severity: ev.severity ?? 'high', title: ev.payload?.title ?? ev.eventType })),
        },
      });
      else if (ch.channelType === 'web_push' && ch.endpoint && ch.p256dh && ch.auth) {
        ok = await sendWebPush(userId, ch, {
          title: `WorldMonitor · ${events.length} held alert${events.length === 1 ? '' : 's'}`,
          body: subject,
          url: 'https://worldmonitor.app/',
          tag: `quiet_hours_batch:${userId}`,
          eventType: 'quiet_hours_batch',
        });
      }
      if (ok) anyDelivered = true;
    } catch (err) {
      console.warn(`[relay] drainHeldForUser: delivery error for ${userId}/${ch.channelType}:`, err.message);
    }
  }
  if (anyDelivered) {
    await upstashRest('DEL', key);
    console.log(`[relay] drainHeldForUser: delivered ${events.length} held events to ${userId} (${variant})`);
  }
}

// Called on a 5-minute timer in the poll loop; sends held batches to users
// whose quiet hours have ended. Self-contained — fetches its own rules.
// No-op when QUIET_HOURS_BATCH_ENABLED=0 — held events will expire via TTL.
async function drainBatchOnWake() {
  if (!QUIET_HOURS_BATCH_ENABLED) return;
  let allRules;
  try {
    allRules = await convex.query('alertRules:getByEnabled', { enabled: true });
  } catch (err) {
    console.warn('[relay] drainBatchOnWake: failed to fetch rules:', err.message);
    return;
  }

  const batchRules = allRules.filter(r =>
    r.quietHoursEnabled && r.quietHoursOverride === 'batch_on_wake' && !isInQuietHours(r),
  );
  for (const rule of batchRules) {
    await drainHeldForUser(rule.userId, rule.variant ?? 'full', rule.channels ?? null);
  }
}

// Triggered when a user changes quiet hours settings away from batch_on_wake,
// so held events are delivered rather than expiring silently.
async function processFlushQuietHeld(event) {
  const { userId, variant = 'full' } = event;
  if (!userId) return;
  console.log(`[relay] flush_quiet_held for ${userId} (${variant})`);
  // Use the same public query the relay already calls in processEvent.
  // internalQuery functions are unreachable via ConvexHttpClient.
  let allowedChannels = null;
  try {
    const allRules = await convex.query('alertRules:getByEnabled', { enabled: true });
    const rule = Array.isArray(allRules)
      ? allRules.find(r => r.userId === userId && (r.variant ?? 'full') === variant)
      : null;
    if (rule && Array.isArray(rule.channels) && rule.channels.length > 0) {
      allowedChannels = rule.channels;
    }
  } catch (err) {
    // If the lookup fails, deliver nothing rather than fan out to wrong channels.
    console.warn(`[relay] flush_quiet_held: could not fetch rule for ${userId} — held alerts preserved until drain:`, err.message);
    return;
  }
  // No matching rule or rule has no channels configured — preserve held events.
  if (!allowedChannels) {
    console.log(`[relay] flush_quiet_held: no active rule with channels for ${userId} (${variant}) — held alerts preserved`);
    return;
  }
  await drainHeldForUser(userId, variant, allowedChannels);
}

// ── Delivery: Telegram ────────────────────────────────────────────────────────

async function sendTelegram(userId, chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[relay] Telegram: TELEGRAM_BOT_TOKEN not set — skipping');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-relay/1.0' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 403 || res.status === 400) {
    const body = await res.json().catch(() => ({}));
    console.warn(`[relay] Telegram ${res.status} for ${userId}: ${body.description ?? '(no description)'}`);
    if (res.status === 403 || body.description?.includes('chat not found')) {
      console.warn(`[relay] Telegram deactivating channel for ${userId}`);
      await deactivateChannel(userId, 'telegram');
    }
    return false;
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const wait = ((body.parameters?.retry_after ?? 5) + 1) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return sendTelegram(userId, chatId, text); // single retry
  }
  if (res.status === 401) {
    console.error('[relay] Telegram 401 Unauthorized — TELEGRAM_BOT_TOKEN is invalid or belongs to a different bot; correct the Railway env var to restore Telegram delivery');
    return false;
  }
  if (!res.ok) {
    console.warn(`[relay] Telegram send failed: ${res.status}`);
    return false;
  }
  console.log(`[relay] Telegram delivered to ${userId} (chatId: ${chatId})`);
  return true;
}

// ── Delivery: Slack ───────────────────────────────────────────────────────────

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[a-zA-Z0-9]+$/;
const DISCORD_RE = /^https:\/\/discord\.com\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/;

async function sendSlack(userId, webhookEnvelope, text) {
  let webhookUrl;
  try {
    webhookUrl = decrypt(webhookEnvelope);
  } catch (err) {
    console.warn(`[relay] Slack decrypt failed for ${userId}:`, err.message);
    return false;
  }
  if (!SLACK_RE.test(webhookUrl)) {
    console.warn(`[relay] Slack URL invalid for ${userId}`);
    return false;
  }
  // SSRF prevention: resolve hostname and check for private IPs
  try {
    const hostname = new URL(webhookUrl).hostname;
    const addresses = await dns.resolve4(hostname);
    if (addresses.some(isPrivateIP)) {
      console.warn(`[relay] Slack URL resolves to private IP for ${userId}`);
      return false;
    }
  } catch {
    console.warn(`[relay] Slack DNS resolution failed for ${userId}`);
    return false;
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-relay/1.0' },
    body: JSON.stringify({ text, unfurl_links: false }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404 || res.status === 410) {
    console.warn(`[relay] Slack webhook gone for ${userId} — deactivating`);
    await deactivateChannel(userId, 'slack');
    return false;
  } else if (!res.ok) {
    console.warn(`[relay] Slack send failed: ${res.status}`);
    return false;
  }
  return true;
}

// ── Delivery: Discord ─────────────────────────────────────────────────────────

const DISCORD_MAX_CONTENT = 2000;

async function sendDiscord(userId, webhookEnvelope, text, retryCount = 0) {
  let webhookUrl;
  try {
    webhookUrl = decrypt(webhookEnvelope);
  } catch (err) {
    console.warn(`[relay] Discord decrypt failed for ${userId}:`, err.message);
    return false;
  }
  if (!DISCORD_RE.test(webhookUrl)) {
    console.warn(`[relay] Discord URL invalid for ${userId}`);
    return false;
  }
  // SSRF prevention: resolve hostname and check for private IPs
  try {
    const hostname = new URL(webhookUrl).hostname;
    const addresses = await dns.resolve4(hostname);
    if (addresses.some(isPrivateIP)) {
      console.warn(`[relay] Discord URL resolves to private IP for ${userId}`);
      return false;
    }
  } catch {
    console.warn(`[relay] Discord DNS resolution failed for ${userId}`);
    return false;
  }
  const content = text.length > DISCORD_MAX_CONTENT
    ? text.slice(0, DISCORD_MAX_CONTENT - 1) + '…'
    : text;
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-relay/1.0' },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404 || res.status === 410) {
    console.warn(`[relay] Discord webhook gone for ${userId} — deactivating`);
    await deactivateChannel(userId, 'discord');
    return false;
  } else if (res.status === 429) {
    if (retryCount >= 1) {
      console.warn(`[relay] Discord 429 retry limit reached for ${userId}`);
      return false;
    }
    const body = await res.json().catch(() => ({}));
    const wait = ((body.retry_after ?? 1) + 0.5) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return sendDiscord(userId, webhookEnvelope, text, retryCount + 1);
  } else if (!res.ok) {
    console.warn(`[relay] Discord send failed: ${res.status}`);
    return false;
  }
  console.log(`[relay] Discord delivered to ${userId}`);
  return true;
}

// ── Delivery: Email ───────────────────────────────────────────────────────────

async function sendEmail(email, subject, text) {
  if (!resend) { console.warn('[relay] RESEND_API_KEY not set — skipping email'); return false; }
  try {
    await resend.emails.send({ from: RESEND_FROM, to: email, subject, text });
    return true;
  } catch (err) {
    console.warn('[relay] Resend send failed:', err.message);
    return false;
  }
}

async function sendWebhook(userId, webhookEnvelope, event) {
  let url;
  try {
    url = decrypt(webhookEnvelope);
  } catch (err) {
    console.warn(`[relay] Webhook decrypt failed for ${userId}:`, err.message);
    return false;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    console.warn(`[relay] Webhook invalid URL for ${userId}`);
    await deactivateChannel(userId, 'webhook');
    return false;
  }

  if (parsed.protocol !== 'https:') {
    console.warn(`[relay] Webhook rejected non-HTTPS for ${userId}`);
    return false;
  }

  try {
    const addrs = await dns.resolve4(parsed.hostname);
    if (addrs.some(isPrivateIP)) {
      console.warn(`[relay] Webhook SSRF blocked (private IP) for ${userId}`);
      return false;
    }
  } catch (err) {
    console.warn(`[relay] Webhook DNS resolve failed for ${userId}:`, err.message);
    return false;
  }

  // Envelope version stays at '1'. Payload gained optional `corroborationCount`
  // on rss_alert (PR #3069) — this is an additive field, backwards-compatible
  // for consumers that don't enforce `additionalProperties: false`. Bumping
  // version here would have broken parity with the other webhook producers
  // (scripts/proactive-intelligence.mjs, scripts/seed-digest-notifications.mjs)
  // which still emit v1, causing the same endpoint to receive mixed envelope
  // versions per event type.
  const payload = JSON.stringify({
    version: '1',
    eventType: event.eventType,
    severity: event.severity ?? 'high',
    timestamp: event.publishedAt ?? Date.now(),
    payload: event.payload ?? {},
    variant: event.variant ?? null,
  });

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-relay/1.0' },
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 404 || resp.status === 410 || resp.status === 403) {
      console.warn(`[relay] Webhook ${resp.status} for ${userId} — deactivating`);
      await deactivateChannel(userId, 'webhook');
      return false;
    }
    if (!resp.ok) {
      console.warn(`[relay] Webhook delivery failed for ${userId}: HTTP ${resp.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[relay] Webhook delivery error for ${userId}:`, err.message);
    return false;
  }
}

// ── Web Push (Phase 6) ────────────────────────────────────────────────────────
//
// Lazy-require web-push so the relay can still start on Railway if the
// dep isn't pulled in. If VAPID keys are unset the relay logs once and
// skips web_push deliveries entirely — telegram/slack/email still work.

let webpushLib = null;
let webpushConfigured = false;
let webpushConfigWarned = false;

function getWebpushClient() {
  if (webpushLib) return webpushLib;
  try {
    webpushLib = require('web-push');
  } catch (err) {
    if (!webpushConfigWarned) {
      console.warn('[relay] web-push dep unavailable — web_push deliveries disabled:', err.message);
      webpushConfigWarned = true;
    }
    return null;
  }
  return webpushLib;
}

function ensureVapidConfigured(client) {
  if (webpushConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@worldmonitor.app';
  if (!pub || !priv) {
    if (!webpushConfigWarned) {
      console.warn('[relay] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — web_push deliveries disabled');
      webpushConfigWarned = true;
    }
    return false;
  }
  try {
    client.setVapidDetails(subject, pub, priv);
    webpushConfigured = true;
    return true;
  } catch (err) {
    console.warn('[relay] VAPID configuration failed:', err.message);
    return false;
  }
}

/**
 * Deliver a web push notification to one subscription. Returns true on
 * success. On 404/410 (subscription gone) the channel is deactivated
 * in Convex so the next run doesn't re-try a dead endpoint.
 *
 * @param {string} userId
 * @param {{ endpoint: string; p256dh: string; auth: string }} subscription
 * @param {{ title: string; body: string; url?: string; tag?: string; eventType?: string }} payload
 */
async function sendWebPush(userId, subscription, payload) {
  const client = getWebpushClient();
  if (!client) return false;
  if (!ensureVapidConfigured(client)) return false;

  const body = JSON.stringify({
    title: payload.title || 'WorldMonitor',
    body: payload.body || '',
    url: payload.url || 'https://worldmonitor.app/',
    tag: payload.tag || 'worldmonitor-generic',
    eventType: payload.eventType,
  });

  // Event-type-aware TTL. Push services hold undeliverable messages
  // until TTL expires — a 24h blanket meant a device offline 20h
  // would reconnect to a flood of yesterday's rss_alerts. Three tiers:
  //   brief_ready:    12h  — the editorial brief is a daily artefact
  //                          and remains interesting into the next
  //                          afternoon even on a long reconnect
  //   quiet_hours_batch: 6h — by definition the alerts inside are
  //                          already queued-on-wake; users care
  //                          about the batch when they wake
  //   everything else:   30 min — rss_alert / oref_siren / conflict_
  //                          escalation are transient. After 30 min
  //                          they're noise; the dashboard is the
  //                          canonical surface.
  const ttlSec =
    payload.eventType === 'brief_ready'        ? 60 * 60 * 12 :
    payload.eventType === 'quiet_hours_batch'  ? 60 * 60 * 6  :
    60 * 30;

  try {
    await client.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      body,
      { TTL: ttlSec },
    );
    return true;
  } catch (err) {
    const code = err?.statusCode;
    if (code === 404 || code === 410) {
      console.warn(`[relay] web_push ${code} for ${userId} — deactivating`);
      await deactivateChannel(userId, 'web_push');
      return false;
    }
    console.warn(`[relay] web_push delivery error for ${userId}:`, err?.message ?? String(err));
    return false;
  }
}

// ── Event processing ──────────────────────────────────────────────────────────

function matchesSensitivity(ruleSensitivity, eventSeverity) {
  if (ruleSensitivity === 'all') return true;
  if (ruleSensitivity === 'high') return eventSeverity === 'high' || eventSeverity === 'critical';
  return eventSeverity === 'critical';
}

/**
 * Score-gated dispatch decision.
 *
 * Always runs the legacy binary severity check first (backwards-compat for
 * rules created before E1). When IMPORTANCE_SCORE_LIVE=1 is set AND the event
 * carries an importanceScore, adds a secondary threshold gate.
 *
 * Shadow mode (default, flag OFF): computes score decision but always falls
 * back to the legacy result so real notifications are unaffected. Logs to
 * shadow:score-log (currently v3) for tuning.
 */
function shouldNotify(rule, event) {
  const passesLegacy = matchesSensitivity(rule.sensitivity, event.severity ?? 'high');
  if (!passesLegacy) return false;

  if (process.env.IMPORTANCE_SCORE_LIVE === '1' && event.payload?.importanceScore != null) {
    const threshold = rule.sensitivity === 'critical' ? 85
                    : rule.sensitivity === 'high' ? 65
                    : 40; // 'all'
    return event.payload.importanceScore >= threshold;
  }

  return true;
}

function formatMessage(event) {
  const parts = [`[${(event.severity ?? 'high').toUpperCase()}] ${event.payload?.title ?? event.eventType}`];
  if (event.payload?.source) parts.push(`Source: ${event.payload.source}`);
  if (event.payload?.link) parts.push(event.payload.link);
  return parts.join('\n');
}

async function processWelcome(event) {
  const { userId, channelType } = event;
  if (!userId || !channelType) return;
  // Telegram welcome is sent directly by Convex; no relay send needed.
  if (channelType === 'telegram') return;
  let channels = [];
  try {
    const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-relay/1.0' },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(10000),
    });
    if (chRes.ok) channels = (await chRes.json()) ?? [];
  } catch {}

  const ch = channels.find(c => c.channelType === channelType && c.verified);
  if (!ch) return;

  // Telegram welcome is sent directly by convex/http.ts after claimPairingToken succeeds.
  const text = `✅ WorldMonitor connected! You'll receive breaking news alerts here.`;
  if (channelType === 'slack' && ch.webhookEnvelope) {
    await sendSlack(userId, ch.webhookEnvelope, text);
  } else if (channelType === 'discord' && ch.webhookEnvelope) {
    await sendDiscord(userId, ch.webhookEnvelope, text);
  } else if (channelType === 'email' && ch.email) {
    await sendEmail(ch.email, 'WorldMonitor Notifications Connected', text);
  } else if (channelType === 'web_push' && ch.endpoint && ch.p256dh && ch.auth) {
    // Welcome push on first web_push connect. Short body — Chrome's
    // notification shelf clips past ~80 chars on most OSes. Click
    // opens the dashboard so the user lands somewhere useful. Uses
    // the 'channel_welcome' event type which maps to the 30-min TTL
    // in sendWebPush — a welcome past 30 minutes after subscribe is
    // noise, not value.
    await sendWebPush(userId, ch, {
      title: 'WorldMonitor connected',
      body: "You'll receive alerts here when events match your sensitivity settings.",
      url: 'https://worldmonitor.app/',
      tag: `channel_welcome:${userId}`,
      eventType: 'channel_welcome',
    });
  }
}

const IMPORTANCE_SCORE_LIVE = process.env.IMPORTANCE_SCORE_LIVE === '1';
const IMPORTANCE_SCORE_MIN = Number(process.env.IMPORTANCE_SCORE_MIN ?? 40);
// v2 key: JSON-encoded members, used after the stale-score fix (PR #TBD).
// The old v1 key (compact string format) is retained by consumers for
// backward-compat reading but is no longer written. See
// docs/internal/scoringDiagnostic.md §5 and §9 Step 4.
const SHADOW_SCORE_LOG_KEY = 'shadow:score-log:v3';
const SHADOW_LOG_TTL = 7 * 24 * 3600; // 7 days

async function shadowLogScore(event) {
  const importanceScore = event.payload?.importanceScore ?? 0;
  if (!UPSTASH_URL || !UPSTASH_TOKEN || importanceScore === 0) return;
  const now = Date.now();
  const record = {
    ts: now,
    importanceScore,
    severity: event.severity ?? 'high',
    eventType: event.eventType,
    title: String(event.payload?.title ?? '').slice(0, 160),
    source: event.payload?.source ?? '',
    publishedAt: event.payload?.publishedAt ?? null,
    corroborationCount: event.payload?.corroborationCount ?? null,
    variant: event.variant ?? '',
  };
  const member = JSON.stringify(record);
  const cutoff = String(now - SHADOW_LOG_TTL * 1000); // prune entries older than 7 days
  // One pipelined HTTP request: ZADD + ZREMRANGEBYSCORE prune + 30-day
  // belt-and-suspenders EXPIRE. Saves ~50% round-trips vs sequential calls
  // and bounds growth even if writes stop and the rolling prune stalls.
  try {
    const res = await fetch(`${UPSTASH_URL}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-relay/1.0',
      },
      body: JSON.stringify([
        ['ZADD', SHADOW_SCORE_LOG_KEY, String(now), member],
        ['ZREMRANGEBYSCORE', SHADOW_SCORE_LOG_KEY, '-inf', cutoff],
        ['EXPIRE', SHADOW_SCORE_LOG_KEY, '2592000'],
      ]),
    });
    // Surface HTTP failures and per-command errors. Activation depends on v2
    // filling with clean data; a silent write-failure would leave operators
    // staring at an empty ZSET with no signal.
    if (!res.ok) {
      console.warn(`[relay] shadow-log pipeline HTTP ${res.status}`);
      return;
    }
    const body = await res.json().catch(() => null);
    if (Array.isArray(body)) {
      const failures = body.map((cmd, i) => (cmd?.error ? `cmd[${i}] ${cmd.error}` : null)).filter(Boolean);
      if (failures.length > 0) console.warn(`[relay] shadow-log pipeline partial failure: ${failures.join('; ')}`);
    }
  } catch (err) {
    console.warn(`[relay] shadow-log pipeline threw: ${err?.message ?? err}`);
  }
}

// ── AI impact analysis ───────────────────────────────────────────────────────

async function generateEventImpact(event, rule) {
  if (!AI_IMPACT_ENABLED) return null;

  // fetchUserPreferences returns { data, error } — must destructure `data`.
  // Without this the wrapper object was passed to extractUserContext, which
  // read no keys, so ctx was always empty and the gate below returned null
  // for every user, silently disabling AI impact analysis entirely.
  const { data: prefs, error: prefsFetchError } = await fetchUserPreferences(rule.userId, rule.variant ?? 'full');
  if (!prefs) {
    if (prefsFetchError) {
      console.warn(`[relay] Prefs fetch failed for ${rule.userId} — skipping AI impact`);
    }
    return null;
  }

  const ctx = extractUserContext(prefs);
  if (ctx.tickers.length === 0 && ctx.airports.length === 0 && !ctx.frameworkName) return null;

  const variant = rule.variant ?? 'full';
  const eventHash = sha256Hex(`${event.eventType}:${event.payload?.title ?? ''}`);
  const ctxHash = sha256Hex(JSON.stringify({ ...ctx, variant })).slice(0, 16);
  const cacheKey = `impact:ai:v1:${eventHash.slice(0, 16)}:${ctxHash}`;

  try {
    const cached = await upstashRest('GET', cacheKey);
    if (cached) return cached;
  } catch { /* miss */ }

  const profile = formatUserProfile(ctx, variant);
  const safeTitle = String(event.payload?.title ?? event.eventType).replace(/[\r\n]/g, ' ').slice(0, 300);
  const safeSource = event.payload?.source ? String(event.payload.source).replace(/[\r\n]/g, ' ').slice(0, 100) : '';
  const systemPrompt = `Assess how this event impacts a specific investor/analyst.
Return 1-2 sentences: (1) direct impact on their assets/regions, (2) action implication.
If no clear impact: "Low direct impact on your portfolio."
Be specific about tickers and regions. No preamble.`;

  const userPrompt = `Event: [${(event.severity ?? 'high').toUpperCase()}] ${safeTitle}
${safeSource ? `Source: ${safeSource}` : ''}

${profile}`;

  let impact;
  try {
    impact = await Promise.race([
      callLLM(systemPrompt, userPrompt, { maxTokens: 200, temperature: 0.2, timeoutMs: 8000 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('global timeout')), 10000)),
    ]);
  } catch {
    console.warn(`[relay] AI impact global timeout for ${rule.userId}`);
    return null;
  }
  if (!impact) return null;

  try {
    await upstashRest('SET', cacheKey, impact, 'EX', String(AI_IMPACT_CACHE_TTL));
  } catch { /* best-effort */ }

  console.log(`[relay] AI impact generated for ${rule.userId} (${impact.length} chars)`);
  return impact;
}

async function processEvent(event) {
  if (event.eventType === 'channel_welcome') { await processWelcome(event); return; }
  if (event.eventType === 'flush_quiet_held') { await processFlushQuietHeld(event); return; }
  console.log(`[relay] Processing event: ${event.eventType} (${event.severity ?? 'high'})`);

  // Shadow log importanceScore for comparison. Gate at caller: only rss_alert
  // events carry importanceScore; for everything else shadowLogScore would
  // short-circuit, but we still pay the promise/microtask cost unless gated here.
  if (event.eventType === 'rss_alert') shadowLogScore(event).catch(() => {});

  // Score gate — only for relay-emitted rss_alert (no userId). Browser-submitted
  // events (with userId) have importanceScore stripped at ingestion and no server-
  // computed score; gating them would drop every browser notification once
  // IMPORTANCE_SCORE_LIVE=1 is activated. Other event types (oref_siren,
  // conflict_escalation, notam_closure) never attach importanceScore.
  if (IMPORTANCE_SCORE_LIVE && event.eventType === 'rss_alert' && !event.userId) {
    const score = event.payload?.importanceScore ?? 0;
    if (score < IMPORTANCE_SCORE_MIN) {
      console.log(`[relay] Score gate: dropped ${event.eventType} score=${score} < ${IMPORTANCE_SCORE_MIN}`);
      return;
    }
  }

  let enabledRules;
  try {
    enabledRules = await convex.query('alertRules:getByEnabled', { enabled: true });
  } catch (err) {
    console.error('[relay] Failed to fetch alert rules:', err.message);
    return;
  }

  // If the event carries a userId (browser-submitted via /api/notify), scope
  // delivery to ONLY that user's own rules. Relay-emitted events (ais-relay,
  // regional-snapshot) have no userId and fan out to all matching Pro users.
  // Without this guard, a Pro user can POST arbitrary rss_alert events that
  // fan out to every other Pro subscriber — see todo #196.
  const matching = enabledRules.filter(r =>
    (!r.digestMode || r.digestMode === 'realtime') &&
    (r.eventTypes.length === 0 || r.eventTypes.includes(event.eventType)) &&
    shouldNotify(r, event) &&
    (!event.variant || !r.variant || r.variant === event.variant) &&
    (!event.userId || r.userId === event.userId)
  );

  if (matching.length === 0) return;

  // Batch PRO check: resolve all unique userIds in parallel instead of one-by-one.
  // isUserPro() has a 15-min Redis cache, so this is cheap after the first call.
  const uniqueUserIds = [...new Set(matching.map(r => r.userId))];
  const proResults = await Promise.all(uniqueUserIds.map(async uid => [uid, await isUserPro(uid)]));
  const proSet = new Set(proResults.filter(([, isPro]) => isPro).map(([uid]) => uid));
  const skippedCount = uniqueUserIds.length - proSet.size;
  if (skippedCount > 0) console.log(`[relay] Skipping ${skippedCount} non-PRO user(s)`);

  const text = formatMessage(event);
  const subject = `WorldMonitor Alert: ${event.payload?.title ?? event.eventType}`;
  const eventSeverity = event.severity ?? 'high';

  for (const rule of matching) {
    if (!proSet.has(rule.userId)) continue;

    const quietAction = resolveQuietAction(rule, eventSeverity);

    if (quietAction === 'suppress') {
      console.log(`[relay] Quiet hours suppress for ${rule.userId} (severity=${eventSeverity}, override=${rule.quietHoursOverride ?? 'critical_only'})`);
      continue;
    }

    if (quietAction === 'hold') {
      const isNew = await checkDedup(rule.userId, event.eventType, event.payload?.title ?? '');
      if (!isNew) { console.log(`[relay] Dedup hit (held) for ${rule.userId}`); continue; }
      console.log(`[relay] Quiet hours hold for ${rule.userId} — queuing for batch_on_wake`);
      await holdEvent(rule.userId, rule.variant ?? 'full', JSON.stringify(event));
      continue;
    }

    const isNew = await checkDedup(rule.userId, event.eventType, event.payload?.title ?? '');
    if (!isNew) { console.log(`[relay] Dedup hit for ${rule.userId}`); continue; }

    let channels = [];
    try {
      const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RELAY_SECRET}`,
          'User-Agent': 'worldmonitor-relay/1.0',
        },
        body: JSON.stringify({ userId: rule.userId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!chRes.ok) throw new Error(`HTTP ${chRes.status}`);
      channels = (await chRes.json()) ?? [];
    } catch (err) {
      console.warn(`[relay] Failed to fetch channels for ${rule.userId}:`, err.message);
      channels = [];
    }

    const verifiedChannels = channels.filter(c => c.verified && rule.channels.includes(c.channelType));
    if (verifiedChannels.length === 0) continue;

    let deliveryText = text;
    if (AI_IMPACT_ENABLED) {
      const impact = await generateEventImpact(event, rule);
      if (impact) deliveryText = `${text}\n\n— Impact —\n${impact}`;
    }

    for (const ch of verifiedChannels) {
      try {
        if (ch.channelType === 'telegram' && ch.chatId) {
          await sendTelegram(rule.userId, ch.chatId, deliveryText);
        } else if (ch.channelType === 'slack' && ch.webhookEnvelope) {
          await sendSlack(rule.userId, ch.webhookEnvelope, deliveryText);
        } else if (ch.channelType === 'discord' && ch.webhookEnvelope) {
          await sendDiscord(rule.userId, ch.webhookEnvelope, deliveryText);
        } else if (ch.channelType === 'email' && ch.email) {
          await sendEmail(ch.email, subject, deliveryText);
        } else if (ch.channelType === 'webhook' && ch.webhookEnvelope) {
          await sendWebhook(rule.userId, ch.webhookEnvelope, event);
        } else if (ch.channelType === 'web_push' && ch.endpoint && ch.p256dh && ch.auth) {
          // Web push carries short payloads (Chrome caps at ~4KB and
          // auto-truncates longer ones anyway). Use title + first line
          // of the formatted text as the body; the click URL points
          // at the event's link if present, else the dashboard.
          const firstLine = (deliveryText || '').split('\n')[1] || '';
          const eventUrl = event.payload?.link || event.payload?.url || 'https://worldmonitor.app/';
          await sendWebPush(rule.userId, ch, {
            title: event.payload?.title || event.eventType || 'WorldMonitor',
            body: firstLine,
            url: eventUrl,
            tag: `${event.eventType}:${rule.userId}`,
            eventType: event.eventType,
          });
        }
      } catch (err) {
        console.warn(`[relay] Delivery error for ${rule.userId}/${ch.channelType}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}

// ── Poll loop (RPOP queue) ────────────────────────────────────────────────────
//
// Publishers push to wm:events:queue via LPUSH (FIFO: LPUSH head, RPOP tail).
// The relay polls RPOP every 1s when idle; processes immediately when messages exist.
// Advantage over pub/sub: messages survive relay restarts and are not lost.

async function subscribe() {
  console.log('[relay] Starting notification relay...');
  console.log('[relay] UPSTASH_URL set:', !!UPSTASH_URL, '| CONVEX_URL set:', !!CONVEX_URL, '| RELAY_SECRET set:', !!RELAY_SECRET);
  console.log('[relay] TELEGRAM_BOT_TOKEN set:', !!TELEGRAM_BOT_TOKEN, '| RESEND_API_KEY set:', !!RESEND_API_KEY);
  let idleCount = 0;
  let lastDrainMs = 0;
  const DRAIN_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  while (true) {
    try {
      // Periodically flush batch_on_wake held events regardless of queue activity
      const nowMs = Date.now();
      if (nowMs - lastDrainMs >= DRAIN_INTERVAL_MS) {
        lastDrainMs = nowMs;
        drainBatchOnWake().catch(err => console.warn('[relay] drainBatchOnWake error:', err.message));
      }

      const result = await upstashRest('RPOP', 'wm:events:queue');
      if (result) {
        idleCount = 0;
        console.log('[relay] RPOP dequeued message:', String(result).slice(0, 200));
        try {
          const event = JSON.parse(result);
          await processEvent(event);
        } catch (err) {
          console.warn('[relay] Failed to parse event:', err.message, '| raw:', String(result).slice(0, 120));
        }
      } else {
        idleCount++;
        // Log a heartbeat every 60s so we know the relay is alive and connected
        if (idleCount % 60 === 0) {
          console.log(`[relay] Heartbeat: idle ${idleCount}s, queue empty, Upstash OK`);
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.warn('[relay] Poll error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

process.on('SIGTERM', () => {
  console.log('[relay] SIGTERM received — shutting down');
  process.exit(0);
});

subscribe().catch(err => {
  console.error('[relay] Fatal error:', err);
  process.exit(1);
});
