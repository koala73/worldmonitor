'use strict';

const { createHash } = require('node:crypto');
const dns = require('node:dns').promises;
const { ConvexHttpClient } = require('convex/browser');
const { Resend } = require('resend');
const { decrypt } = require('./lib/crypto.cjs');

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

if (!UPSTASH_URL || !UPSTASH_TOKEN) { console.error('[relay] UPSTASH_REDIS_REST_URL/TOKEN not set'); process.exit(1); }
if (!CONVEX_URL) { console.error('[relay] CONVEX_URL not set'); process.exit(1); }
if (!RELAY_SECRET) { console.error('[relay] RELAY_SHARED_SECRET not set'); process.exit(1); }

const convex = new ConvexHttpClient(CONVEX_URL);
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// ── Upstash REST helpers ──────────────────────────────────────────────────────

async function upstashRest(...args) {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
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
      },
      body: JSON.stringify({ userId, channelType }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) console.warn(`[relay] Deactivate failed ${userId}/${channelType}: ${res.status}`);
  } catch (err) {
    console.warn(`[relay] Deactivate request failed for ${userId}/${channelType}:`, err.message);
  }
}

// ── Private IP guard ─────────────────────────────────────────────────────────

function isPrivateIP(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc|fd)/.test(ip);
}

// ── Delivery: Telegram ────────────────────────────────────────────────────────

async function sendTelegram(userId, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 403 || res.status === 400) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 || body.description?.includes('chat not found')) {
      console.warn(`[relay] Telegram 403/400 for ${userId} — deactivating channel`);
      await deactivateChannel(userId, 'telegram');
    }
    return;
  }
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const wait = ((body.parameters?.retry_after ?? 5) + 1) * 1000;
    await new Promise(r => setTimeout(r, wait));
    return sendTelegram(userId, chatId, text); // single retry
  }
  if (!res.ok) console.warn(`[relay] Telegram send failed: ${res.status}`);
}

// ── Delivery: Slack ───────────────────────────────────────────────────────────

const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[a-zA-Z0-9]+$/;

async function sendSlack(userId, webhookEnvelope, text) {
  let webhookUrl;
  try {
    webhookUrl = decrypt(webhookEnvelope);
  } catch (err) {
    console.warn(`[relay] Slack decrypt failed for ${userId}:`, err.message);
    return;
  }
  if (!SLACK_RE.test(webhookUrl)) {
    console.warn(`[relay] Slack URL invalid for ${userId}`);
    return;
  }
  // SSRF prevention: resolve hostname and check for private IPs
  try {
    const hostname = new URL(webhookUrl).hostname;
    const addresses = await dns.resolve4(hostname);
    if (addresses.some(isPrivateIP)) {
      console.warn(`[relay] Slack URL resolves to private IP for ${userId}`);
      return;
    }
  } catch {
    console.warn(`[relay] Slack DNS resolution failed for ${userId}`);
    return;
  }
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 404 || res.status === 410) {
    console.warn(`[relay] Slack webhook gone for ${userId} — deactivating`);
    await deactivateChannel(userId, 'slack');
  } else if (!res.ok) {
    console.warn(`[relay] Slack send failed: ${res.status}`);
  }
}

// ── Delivery: Email ───────────────────────────────────────────────────────────

async function sendEmail(email, subject, text) {
  if (!resend) { console.warn('[relay] RESEND_API_KEY not set — skipping email'); return; }
  try {
    await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject,
      text,
    });
  } catch (err) {
    console.warn('[relay] Resend send failed:', err.message);
  }
}

// ── Event processing ──────────────────────────────────────────────────────────

function matchesSensitivity(ruleSensitivity, eventSeverity) {
  if (ruleSensitivity === 'all') return true;
  if (ruleSensitivity === 'high') return eventSeverity === 'high' || eventSeverity === 'critical';
  return eventSeverity === 'critical';
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
  let channels = [];
  try {
    const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RELAY_SECRET}` },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(10000),
    });
    if (chRes.ok) channels = (await chRes.json()) ?? [];
  } catch {}

  const ch = channels.find(c => c.channelType === channelType && c.verified);
  if (!ch) return;

  const text = `✅ WorldMonitor connected! You'll receive breaking news alerts here.`;
  if (channelType === 'telegram' && ch.chatId) {
    await sendTelegram(userId, ch.chatId, text);
  } else if (channelType === 'slack' && ch.webhookEnvelope) {
    await sendSlack(userId, ch.webhookEnvelope, text);
  } else if (channelType === 'email' && ch.email) {
    await sendEmail(ch.email, 'WorldMonitor Notifications Connected', text);
  }
}

async function processEvent(event) {
  if (event.eventType === 'channel_welcome') { await processWelcome(event); return; }
  console.log(`[relay] Processing event: ${event.eventType} (${event.severity ?? 'high'})`);

  let enabledRules;
  try {
    enabledRules = await convex.query('alertRules:getByEnabled', { enabled: true });
  } catch (err) {
    console.error('[relay] Failed to fetch alert rules:', err.message);
    return;
  }

  const matching = enabledRules.filter(r =>
    (r.eventTypes.length === 0 || r.eventTypes.includes(event.eventType)) &&
    matchesSensitivity(r.sensitivity, event.severity ?? 'high') &&
    (!event.variant || !r.variant || r.variant === event.variant)
  );

  if (matching.length === 0) return;

  const text = formatMessage(event);
  const subject = `WorldMonitor Alert: ${event.payload?.title ?? event.eventType}`;

  for (const rule of matching) {
    const isNew = await checkDedup(rule.userId, event.eventType, event.payload?.title ?? '');
    if (!isNew) { console.log(`[relay] Dedup hit for ${rule.userId}`); continue; }

    let channels = [];
    try {
      const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RELAY_SECRET}`,
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

    for (const ch of verifiedChannels) {
      if (ch.channelType === 'telegram' && ch.chatId) {
        await sendTelegram(rule.userId, ch.chatId, text);
      } else if (ch.channelType === 'slack' && ch.webhookEnvelope) {
        await sendSlack(rule.userId, ch.webhookEnvelope, text);
      } else if (ch.channelType === 'email' && ch.email) {
        await sendEmail(ch.email, subject, text);
      }
    }
  }
}

// ── Subscribe loop ────────────────────────────────────────────────────────────

async function subscribe() {
  console.log('[relay] Starting notification relay...');
  while (true) {
    try {
      const res = await fetch(
        `${UPSTASH_URL}/subscribe/wm:events:notify`,
        {
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
          signal: AbortSignal.timeout(35_000),
        }
      );
      if (!res.ok) {
        console.warn(`[relay] Subscribe response: ${res.status}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      const json = await res.json().catch(() => null);
      const message = json?.message;
      if (message) {
        try {
          const event = JSON.parse(message);
          await processEvent(event);
        } catch (err) {
          console.warn('[relay] Failed to parse event:', err.message);
        }
      }
    } catch (err) {
      if (err?.name !== 'TimeoutError') {
        console.warn('[relay] Subscribe error:', err.message);
        await new Promise(r => setTimeout(r, 5000));
      }
      // TimeoutError = normal long-poll timeout, reconnect immediately
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
