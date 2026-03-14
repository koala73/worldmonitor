#!/usr/bin/env node
/**
 * AIS WebSocket Relay Server
 * Proxies aisstream.io data to browsers via WebSocket
 *
 * Deploy on Railway with:
 *   AISSTREAM_API_KEY=your_key
 *
 * Local: node scripts/ais-relay.cjs
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const { readFileSync } = require('fs');
const crypto = require('crypto');
const v8 = require('v8');
const { WebSocketServer, WebSocket } = require('ws');

function requireShared(name) {
  const candidates = [path.join(__dirname, '..', 'shared', name), path.join(__dirname, 'shared', name)];
  for (const p of candidates) { try { return require(p); } catch {} }
  throw new Error(`Cannot find shared/${name}`);
}
const RSS_ALLOWED_DOMAINS = new Set(requireShared('rss-allowed-domains.cjs'));

// Log effective heap limit at startup (verifies NODE_OPTIONS=--max-old-space-size is active)
const _heapStats = v8.getHeapStatistics();
console.log(`[Relay] Heap limit: ${(_heapStats.heap_size_limit / 1024 / 1024).toFixed(0)}MB`);

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const API_KEY = process.env.AISSTREAM_API_KEY || process.env.VITE_AISSTREAM_API_KEY;
const PORT = process.env.PORT || 3004;

if (!API_KEY) {
  console.error('[Relay] Error: AISSTREAM_API_KEY environment variable not set');
  console.error('[Relay] Get a free key at https://aisstream.io');
  process.exit(1);
}

const MAX_WS_CLIENTS = 10; // Cap WS clients — app uses HTTP snapshots, not WS
const UPSTREAM_QUEUE_HIGH_WATER = Math.max(500, Number(process.env.AIS_UPSTREAM_QUEUE_HIGH_WATER || 4000));
const UPSTREAM_QUEUE_LOW_WATER = Math.max(
  100,
  Math.min(UPSTREAM_QUEUE_HIGH_WATER - 1, Number(process.env.AIS_UPSTREAM_QUEUE_LOW_WATER || 1000))
);
const UPSTREAM_QUEUE_HARD_CAP = Math.max(
  UPSTREAM_QUEUE_HIGH_WATER + 1,
  Number(process.env.AIS_UPSTREAM_QUEUE_HARD_CAP || 8000)
);
const UPSTREAM_DRAIN_BATCH = Math.max(1, Number(process.env.AIS_UPSTREAM_DRAIN_BATCH || 250));
const UPSTREAM_DRAIN_BUDGET_MS = Math.max(2, Number(process.env.AIS_UPSTREAM_DRAIN_BUDGET_MS || 20));
function safeInt(envVal, fallback, min) {
  if (envVal == null || envVal === '') return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}
const MAX_VESSELS = safeInt(process.env.AIS_MAX_VESSELS, 20000, 1000);
const MAX_VESSEL_HISTORY = safeInt(process.env.AIS_MAX_VESSEL_HISTORY, 20000, 1000);
const MAX_DENSITY_CELLS = 5000;
const MEMORY_CLEANUP_THRESHOLD_GB = (() => {
  const n = Number(process.env.RELAY_MEMORY_CLEANUP_GB);
  return Number.isFinite(n) && n > 0 ? n : 2.0;
})();
const RELAY_SHARED_SECRET = process.env.RELAY_SHARED_SECRET || '';
const RELAY_AUTH_HEADER = (process.env.RELAY_AUTH_HEADER || 'x-relay-key').toLowerCase();
const ALLOW_UNAUTHENTICATED_RELAY = process.env.ALLOW_UNAUTHENTICATED_RELAY === 'true';
const IS_PRODUCTION_RELAY = process.env.NODE_ENV === 'production'
  || !!process.env.RAILWAY_ENVIRONMENT
  || !!process.env.RAILWAY_PROJECT_ID
  || !!process.env.RAILWAY_STATIC_URL;
const RELAY_RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RELAY_RATE_LIMIT_WINDOW_MS || 60000));
const RELAY_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_RATE_LIMIT_MAX) : 1200;
const RELAY_OPENSKY_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_OPENSKY_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_OPENSKY_RATE_LIMIT_MAX) : 600;
const RELAY_RSS_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_RSS_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_RSS_RATE_LIMIT_MAX) : 300;
const RELAY_LOG_THROTTLE_MS = Math.max(1000, Number(process.env.RELAY_LOG_THROTTLE_MS || 10000));
const ALLOW_VERCEL_PREVIEW_ORIGINS = process.env.ALLOW_VERCEL_PREVIEW_ORIGINS === 'true';

// OpenSky proxy — routes through residential proxy to avoid Railway IP blocks
const OPENSKY_PROXY_AUTH = process.env.OPENSKY_PROXY_AUTH || process.env.OREF_PROXY_AUTH || '';
const OPENSKY_PROXY_ENABLED = !!OPENSKY_PROXY_AUTH;

// OREF (Israel Home Front Command) siren alerts — fetched via HTTP proxy (Israel exit)
const OREF_PROXY_AUTH = process.env.OREF_PROXY_AUTH || ''; // format: user:pass@host:port
const OREF_ALERTS_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const OREF_HISTORY_URL = 'https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json';
const OREF_POLL_INTERVAL_MS = Math.max(30_000, Number(process.env.OREF_POLL_INTERVAL_MS || 300_000));
const OREF_ENABLED = !!OREF_PROXY_AUTH;
const OREF_DATA_DIR = process.env.OREF_DATA_DIR || '';
const OREF_LOCAL_FILE = (() => {
  if (!OREF_DATA_DIR) return '';
  try {
    const stat = require('fs').statSync(OREF_DATA_DIR);
    if (!stat.isDirectory()) { console.warn(`[Relay] OREF_DATA_DIR is not a directory: ${OREF_DATA_DIR}`); return ''; }
  } catch { console.warn(`[Relay] OREF_DATA_DIR does not exist: ${OREF_DATA_DIR}`); return ''; }
  console.log(`[Relay] OREF local persistence: ${OREF_DATA_DIR}`);
  return path.join(OREF_DATA_DIR, 'oref-history.json');
})();
const RELAY_OREF_RATE_LIMIT_MAX = Number.isFinite(Number(process.env.RELAY_OREF_RATE_LIMIT_MAX))
  ? Number(process.env.RELAY_OREF_RATE_LIMIT_MAX) : 600;

if (IS_PRODUCTION_RELAY && !RELAY_SHARED_SECRET && !ALLOW_UNAUTHENTICATED_RELAY) {
  console.error('[Relay] Error: RELAY_SHARED_SECRET is required in production');
  console.error('[Relay] Set RELAY_SHARED_SECRET on Railway and Vercel to secure relay endpoints');
  console.error('[Relay] To bypass temporarily (not recommended), set ALLOW_UNAUTHENTICATED_RELAY=true');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// Upstash Redis REST helpers — persist OREF history across restarts
// ─────────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UPSTASH_ENABLED = !!(
  UPSTASH_REDIS_REST_URL &&
  UPSTASH_REDIS_REST_TOKEN &&
  UPSTASH_REDIS_REST_URL.startsWith('https://')
);
const RELAY_ENV_PREFIX = process.env.RELAY_ENV ? `${process.env.RELAY_ENV}:` : '';
const OREF_REDIS_KEY = `${RELAY_ENV_PREFIX}relay:oref:history:v1`;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

if (UPSTASH_REDIS_REST_URL && !UPSTASH_REDIS_REST_URL.startsWith('https://')) {
  console.warn('[Relay] UPSTASH_REDIS_REST_URL must start with https:// — Redis disabled');
}
if (UPSTASH_ENABLED) {
  console.log(`[Relay] Upstash Redis enabled (key: ${OREF_REDIS_KEY})`);
}

function upstashGet(key) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(null);
    const url = new URL(`/get/${encodeURIComponent(key)}`, UPSTASH_REDIS_REST_URL);
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      timeout: 5000,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return resolve(null);
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.result) return resolve(JSON.parse(parsed.result));
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function upstashSet(key, value, ttlSeconds) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.result === 'OK');
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function upstashExpire(key, ttlSeconds) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['EXPIRE', key, String(ttlSeconds)]);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.result === 1);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function upstashMGet(keys) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED || keys.length === 0) return resolve([]);
    const url = new URL('/pipeline', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(keys.map((k) => ['GET', k]));
    const req = https.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return resolve(keys.map(() => null));
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.map((r) => {
            if (!r?.result) return null;
            try { return JSON.parse(r.result); } catch { return null; }
          }));
        } catch { resolve(keys.map(() => null)); }
      });
    });
    req.on('error', () => resolve(keys.map(() => null)));
    req.on('timeout', () => { req.destroy(); resolve(keys.map(() => null)); });
    req.end(body);
  });
}

let upstreamSocket = null;
let upstreamPaused = false;
let upstreamQueue = [];
let upstreamQueueReadIndex = 0;
let upstreamDrainScheduled = false;
let clients = new Set();
let messageCount = 0;
let droppedMessages = 0;
const requestRateBuckets = new Map(); // key: route:ip -> { count, resetAt }
const logThrottleState = new Map(); // key: event key -> timestamp

// Safe response: guard against "headers already sent" crashes
function safeEnd(res, statusCode, headers, body) {
  if (res.headersSent || res.writableEnded) return false;
  try {
    res.writeHead(statusCode, headers);
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// gzip compress & send a response (reduces egress ~80% for JSON)
function sendCompressed(req, res, statusCode, headers, body) {
  if (res.headersSent || res.writableEnded) return;
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip')) {
    zlib.gzip(typeof body === 'string' ? Buffer.from(body) : body, (err, compressed) => {
      if (err || res.headersSent || res.writableEnded) {
        safeEnd(res, statusCode, headers, body);
        return;
      }
      const existingVary = String(res.getHeader('vary') || '');
      const vary = existingVary.toLowerCase().includes('accept-encoding')
        ? existingVary
        : (existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding');
      safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': vary }, compressed);
    });
  } else {
    safeEnd(res, statusCode, headers, body);
  }
}

// Pre-gzipped response: serve a cached gzip buffer directly (zero CPU per request)
function sendPreGzipped(req, res, statusCode, headers, rawBody, gzippedBody) {
  if (res.headersSent || res.writableEnded) return;
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (acceptEncoding.includes('gzip') && gzippedBody) {
    const existingVary = String(res.getHeader('vary') || '');
    const vary = existingVary.toLowerCase().includes('accept-encoding')
      ? existingVary
      : (existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding');
    safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': vary }, gzippedBody);
  } else {
    safeEnd(res, statusCode, headers, rawBody);
  }
}

// ─────────────────────────────────────────────────────────────
// Telegram OSINT ingestion (public channels) → Early Signals
// Web-first: runs on this Railway relay process, serves /telegram/feed
// Requires env:
// - TELEGRAM_API_ID
// - TELEGRAM_API_HASH
// - TELEGRAM_SESSION (StringSession)
// ─────────────────────────────────────────────────────────────
const TELEGRAM_ENABLED = Boolean(process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_SESSION);
const TELEGRAM_POLL_INTERVAL_MS = Math.max(15_000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 60_000));
const TELEGRAM_MAX_FEED_ITEMS = Math.max(50, Number(process.env.TELEGRAM_MAX_FEED_ITEMS || 200));
const TELEGRAM_MAX_TEXT_CHARS = Math.max(200, Number(process.env.TELEGRAM_MAX_TEXT_CHARS || 800));

const telegramState = {
  client: null,
  channels: [],
  cursorByHandle: Object.create(null),
  items: [],
  lastPollAt: 0,
  lastError: null,
  startedAt: Date.now(),
};

const orefState = {
  lastAlerts: [],
  lastAlertsJson: '[]',
  lastPollAt: 0,
  lastError: null,
  historyCount24h: 0,
  totalHistoryCount: 0,
  history: [],
  bootstrapSource: null,
  _persistVersion: 0,
  _lastPersistedVersion: 0,
  _persistInFlight: false,
};

function loadTelegramChannels() {
  // Product-managed curated list lives in repo root under data/ (shared by web + desktop).
  // Relay is executed from scripts/, so resolve ../data.
  const p = path.join(__dirname, '..', 'data', 'telegram-channels.json');
  const set = String(process.env.TELEGRAM_CHANNEL_SET || 'full').toLowerCase();
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const bucket = raw?.channels?.[set];
    const channels = Array.isArray(bucket) ? bucket : [];

    telegramState.channels = channels
      .filter(c => c && typeof c.handle === 'string' && c.handle.length > 1)
      .map(c => ({
        handle: String(c.handle).replace(/^@/, ''),
        label: c.label ? String(c.label) : undefined,
        topic: c.topic ? String(c.topic) : undefined,
        region: c.region ? String(c.region) : undefined,
        tier: c.tier != null ? Number(c.tier) : undefined,
        enabled: c.enabled !== false,
        maxMessages: c.maxMessages != null ? Number(c.maxMessages) : undefined,
      }))
      .filter(c => c.enabled);

    if (!telegramState.channels.length) {
      console.warn(`[Relay] Telegram channel set "${set}" is empty — no channels to poll`);
    }

    return telegramState.channels;
  } catch (e) {
    telegramState.channels = [];
    telegramState.lastError = `failed to load telegram-channels.json: ${e?.message || String(e)}`;
    return [];
  }
}

function normalizeTelegramMessage(msg, channel) {
  const textRaw = String(msg?.message || '');
  const text = textRaw.slice(0, TELEGRAM_MAX_TEXT_CHARS);
  const ts = msg?.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();
  return {
    id: `${channel.handle}:${msg.id}`,
    source: 'telegram',
    channel: channel.handle,
    channelTitle: channel.label || channel.handle,
    url: `https://t.me/${channel.handle}/${msg.id}`,
    ts,
    text,
    topic: channel.topic || 'other',
    tags: [channel.region].filter(Boolean),
    earlySignal: true,
  };
}

let telegramPermanentlyDisabled = false;

async function initTelegramClientIfNeeded() {
  if (!TELEGRAM_ENABLED) return false;
  if (telegramState.client) return true;
  if (telegramPermanentlyDisabled) return false;

  const apiId = parseInt(String(process.env.TELEGRAM_API_ID || ''), 10);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '');
  const sessionStr = String(process.env.TELEGRAM_SESSION || '');

  if (!apiId || !apiHash || !sessionStr) return false;

  try {
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions/index.js');

    const client = new TelegramClient(new StringSession(sessionStr), apiId, apiHash, {
      connectionRetries: 3,
    });

    await client.connect();
    telegramState.client = client;
    telegramState.lastError = null;
    console.log('[Relay] Telegram client connected');
    return true;
  } catch (e) {
    const em = e?.message || String(e);
    if (e?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package|Directory import/.test(em)) {
      telegramPermanentlyDisabled = true;
      telegramState.lastError = 'telegram package not installed';
      console.warn('[Relay] Telegram package not installed — disabling permanently for this session');
      return false;
    }
    if (/AUTH_KEY_DUPLICATED/.test(em)) {
      telegramPermanentlyDisabled = true;
      telegramState.lastError = 'session invalidated (AUTH_KEY_DUPLICATED) — generate a new TELEGRAM_SESSION';
      console.error('[Relay] Telegram session permanently invalidated (AUTH_KEY_DUPLICATED). Generate a new session with: node scripts/telegram/session-auth.mjs');
      return false;
    }
    telegramState.lastError = `telegram init failed: ${em}`;
    console.warn('[Relay] Telegram init failed:', telegramState.lastError);
    return false;
  }
}

const TELEGRAM_CHANNEL_TIMEOUT_MS = 15_000; // 15s timeout per channel (getEntity + getMessages)
const TELEGRAM_POLL_CYCLE_TIMEOUT_MS = 180_000; // 3min max for entire poll cycle

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

async function pollTelegramOnce() {
  const ok = await initTelegramClientIfNeeded();
  if (!ok) return;

  const channels = telegramState.channels.length ? telegramState.channels : loadTelegramChannels();
  if (!channels.length) return;

  const client = telegramState.client;
  const newItems = [];
  const pollStart = Date.now();
  let channelsPolled = 0;
  let channelsFailed = 0;
  let mediaSkipped = 0;

  for (const channel of channels) {
    if (Date.now() - pollStart > TELEGRAM_POLL_CYCLE_TIMEOUT_MS) {
      console.warn(`[Relay] Telegram poll cycle timeout (${Math.round(TELEGRAM_POLL_CYCLE_TIMEOUT_MS / 1000)}s), polled ${channelsPolled}/${channels.length} channels`);
      break;
    }

    const handle = channel.handle;
    const minId = telegramState.cursorByHandle[handle] || 0;

    try {
      const entity = await withTimeout(client.getEntity(handle), TELEGRAM_CHANNEL_TIMEOUT_MS, `getEntity(${handle})`);
      const msgs = await withTimeout(
        client.getMessages(entity, {
          limit: Math.max(1, Math.min(50, channel.maxMessages || 25)),
          minId,
        }),
        TELEGRAM_CHANNEL_TIMEOUT_MS,
        `getMessages(${handle})`
      );

      for (const msg of msgs) {
        if (!msg || !msg.id) continue;
        if (!msg.message) { mediaSkipped++; continue; }
        const item = normalizeTelegramMessage(msg, channel);
        newItems.push(item);
        if (!telegramState.cursorByHandle[handle] || msg.id > telegramState.cursorByHandle[handle]) {
          telegramState.cursorByHandle[handle] = msg.id;
        }
      }

      channelsPolled++;
      await new Promise(r => setTimeout(r, Math.max(300, Number(process.env.TELEGRAM_RATE_LIMIT_MS || 800))));
    } catch (e) {
      const em = e?.message || String(e);
      channelsFailed++;
      telegramState.lastError = `poll ${handle} failed: ${em}`;
      console.warn('[Relay] Telegram poll error:', telegramState.lastError);
      if (/AUTH_KEY_DUPLICATED/.test(em)) {
        telegramPermanentlyDisabled = true;
        telegramState.lastError = 'session invalidated (AUTH_KEY_DUPLICATED) — generate a new TELEGRAM_SESSION';
        console.error('[Relay] Telegram session permanently invalidated (AUTH_KEY_DUPLICATED). Generate a new session with: node scripts/telegram/session-auth.mjs');
        try { telegramState.client?.disconnect(); } catch {}
        telegramState.client = null;
        break;
      }
      if (/FLOOD_WAIT/.test(em)) {
        const wait = parseInt(em.match(/(\d+)/)?.[1] || '60', 10);
        console.warn(`[Relay] Telegram FLOOD_WAIT ${wait}s — stopping poll cycle early`);
        break;
      }
    }
  }

  if (newItems.length) {
    const seen = new Set();
    telegramState.items = [...newItems, ...telegramState.items]
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
      .slice(0, TELEGRAM_MAX_FEED_ITEMS);
  }

  telegramState.lastPollAt = Date.now();
  const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
  console.log(`[Relay] Telegram poll: ${channelsPolled}/${channels.length} channels, ${newItems.length} new msgs, ${telegramState.items.length} total, ${channelsFailed} errors, ${mediaSkipped} media-only skipped (${elapsed}s)`);
}

let telegramPollInFlight = false;
let telegramPollStartedAt = 0;

function guardedTelegramPoll() {
  if (telegramPollInFlight) {
    const stuck = Date.now() - telegramPollStartedAt;
    if (stuck > TELEGRAM_POLL_CYCLE_TIMEOUT_MS + 30_000) {
      console.warn(`[Relay] Telegram poll stuck for ${Math.round(stuck / 1000)}s — force-clearing in-flight flag`);
      telegramPollInFlight = false;
    } else {
      return;
    }
  }
  telegramPollInFlight = true;
  telegramPollStartedAt = Date.now();
  pollTelegramOnce()
    .catch(e => console.warn('[Relay] Telegram poll error:', e?.message || e))
    .finally(() => { telegramPollInFlight = false; });
}

const TELEGRAM_STARTUP_DELAY_MS = Math.max(0, Number(process.env.TELEGRAM_STARTUP_DELAY_MS || 60_000));

function startTelegramPollLoop() {
  if (!TELEGRAM_ENABLED) return;
  loadTelegramChannels();
  if (TELEGRAM_STARTUP_DELAY_MS > 0) {
    console.log(`[Relay] Telegram connect delayed ${TELEGRAM_STARTUP_DELAY_MS}ms (waiting for old container to disconnect)`);
    setTimeout(() => {
      guardedTelegramPoll();
      setInterval(guardedTelegramPoll, TELEGRAM_POLL_INTERVAL_MS).unref?.();
      console.log('[Relay] Telegram poll loop started');
    }, TELEGRAM_STARTUP_DELAY_MS);
  } else {
    guardedTelegramPoll();
    setInterval(guardedTelegramPoll, TELEGRAM_POLL_INTERVAL_MS).unref?.();
    console.log('[Relay] Telegram poll loop started');
  }
}

// ─────────────────────────────────────────────────────────────
// OREF Siren Alerts (Israel Home Front Command)
// Polls oref.org.il via HTTP CONNECT tunnel through residential proxy (Israel exit)
// ─────────────────────────────────────────────────────────────

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function redactOrefError(msg) {
  return String(msg || '').replace(/\/\/[^@]+@/g, '//<redacted>@');
}

function orefDateToUTC(dateStr) {
  if (!dateStr || !dateStr.includes(' ')) return new Date().toISOString();
  const [datePart, timePart] = dateStr.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  function partsAt(ms) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  const base2 = Date.UTC(y, m - 1, d, hh - 2, mm, ss);
  const base3 = Date.UTC(y, m - 1, d, hh - 3, mm, ss);
  const candidates = [];
  if (partsAt(base2) === dateStr) candidates.push(base2);
  if (partsAt(base3) === dateStr) candidates.push(base3);
  const ms = candidates.length ? Math.min(...candidates) : base2;
  return new Date(ms).toISOString();
}

function orefCurlFetch(proxyAuth, url, { toFile } = {}) {
  // Use curl via child_process — Node.js TLS fingerprint (JA3) gets blocked by Akamai,
  // but curl's fingerprint passes. curl is available on Railway (Linux) and macOS.
  // execFileSync avoids shell interpolation — safe with special chars in proxy credentials.
  const { execFileSync } = require('child_process');
  const proxyUrl = `http://${proxyAuth}`;
  const args = [
    '-sS', '--compressed', '-x', proxyUrl, '--max-time', '15',
    '-H', 'Accept: application/json',
    '-H', 'Referer: https://www.oref.org.il/',
    '-H', 'X-Requested-With: XMLHttpRequest',
  ];
  if (toFile) {
    // Write directly to disk — avoids stdout buffer overflow (ENOBUFS) for large responses
    args.push('-o', toFile);
    args.push(url);
    execFileSync('curl', args, { timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
    return require('fs').readFileSync(toFile, 'utf8');
  }
  args.push(url);
  const result = execFileSync('curl', args, { encoding: 'utf8', timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'] });
  return result;
}

async function orefFetchAlerts() {
  if (!OREF_ENABLED) return;
  try {
    const raw = orefCurlFetch(OREF_PROXY_AUTH, OREF_ALERTS_URL);
    const cleaned = stripBom(raw).trim();

    let alerts = [];
    if (cleaned && cleaned !== '[]' && cleaned !== 'null') {
      try {
        const parsed = JSON.parse(cleaned);
        alerts = Array.isArray(parsed) ? parsed : [parsed];
      } catch { alerts = []; }
    }

    const newJson = JSON.stringify(alerts);
    const changed = newJson !== orefState.lastAlertsJson;

    orefState.lastAlerts = alerts;
    orefState.lastAlertsJson = newJson;
    orefState.lastPollAt = Date.now();
    orefState.lastError = null;

    if (changed && alerts.length > 0) {
      orefState.history.push({
        alerts,
        timestamp: new Date().toISOString(),
      });
      orefState._persistVersion++;
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    orefState.historyCount24h = orefState.history
      .filter(h => new Date(h.timestamp).getTime() > cutoff)
      .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
    const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const beforeLen = orefState.history.length;
    orefState.history = orefState.history.filter(
      h => new Date(h.timestamp).getTime() > purgeCutoff
    );
    if (orefState.history.length !== beforeLen) orefState._persistVersion++;
    orefState.totalHistoryCount = orefState.history.reduce((sum, h) => {
      return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
    }, 0);

    orefPersistHistory().catch(() => {});
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    orefState.lastError = redactOrefError(stderr || err.message);
    console.warn('[Relay] OREF poll error:', orefState.lastError);
  }
}

async function orefBootstrapHistoryFromUpstream() {
  const tmpFile = require('path').join(require('os').tmpdir(), `oref-history-${Date.now()}.json`);
  let raw;
  try {
    raw = orefCurlFetch(OREF_PROXY_AUTH, OREF_HISTORY_URL, { toFile: tmpFile });
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch {}
  }
  const cleaned = stripBom(raw).trim();
  if (!cleaned || cleaned === '[]') return;

  const allRecords = JSON.parse(cleaned);
  const records = allRecords.slice(0, 500);
  const waves = new Map();
  for (const r of records) {
    const key = r.alertDate;
    if (!waves.has(key)) waves.set(key, []);
    waves.get(key).push(r);
  }
  const history = [];
  let totalAlertRecords = 0;
  for (const [dateStr, recs] of waves) {
    const iso = orefDateToUTC(dateStr);
    const byType = new Map();
    let typeIdx = 0;
    for (const r of recs) {
      const k = `${r.category}|${r.title}`;
      if (!byType.has(k)) {
        byType.set(k, {
          id: `${r.category}-${typeIdx++}-${dateStr.replace(/[^0-9]/g, '')}`,
          cat: String(r.category),
          title: r.title,
          data: [],
          desc: '',
          alertDate: dateStr,
        });
      }
      byType.get(k).data.push(r.data);
      totalAlertRecords++;
    }
    history.push({ alerts: [...byType.values()], timestamp: new Date(iso).toISOString() });
  }
  history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  orefState.history = history;
  orefState.totalHistoryCount = totalAlertRecords;
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  orefState.historyCount24h = history
    .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
    .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
  orefState.bootstrapSource = 'upstream';
  if (history.length > 0) orefState._persistVersion++;
  console.log(`[Relay] OREF history bootstrap: ${totalAlertRecords} records across ${history.length} waves`);
  orefSaveLocalHistory();
}

const OREF_PERSIST_MAX_WAVES = 200;
const OREF_PERSIST_TTL_SECONDS = 7 * 24 * 60 * 60;

async function orefPersistHistory() {
  if (!UPSTASH_ENABLED) return;
  if (orefState._persistVersion === orefState._lastPersistedVersion) return;
  if (orefState._persistInFlight) return;
  orefState._persistInFlight = true;
  const versionAtStart = orefState._persistVersion;
  try {
    let waves = orefState.history;
    if (waves.length > OREF_PERSIST_MAX_WAVES) {
      console.warn(`[Relay] OREF persist: truncating ${waves.length} waves to ${OREF_PERSIST_MAX_WAVES}`);
      waves = waves.slice(-OREF_PERSIST_MAX_WAVES);
    }
    const payload = {
      history: waves,
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      activeAlertCount: orefState.lastAlerts?.length || 0,
      persistedAt: new Date().toISOString(),
    };
    const ok = await upstashSet(OREF_REDIS_KEY, payload, OREF_PERSIST_TTL_SECONDS);
    if (ok) {
      orefState._lastPersistedVersion = versionAtStart;
    }
    orefSaveLocalHistory();
  } finally {
    orefState._persistInFlight = false;
  }
}

function orefLoadLocalHistory() {
  if (!OREF_LOCAL_FILE) return null;
  try {
    const raw = require('fs').readFileSync(OREF_LOCAL_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.history) || data.history.length === 0) return null;
    const valid = data.history.every(
      h => Array.isArray(h.alerts) && typeof h.timestamp === 'string'
    );
    if (!valid) return null;
    const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = data.history.filter(
      h => new Date(h.timestamp).getTime() > purgeCutoff
    );
    if (filtered.length === 0) {
      console.log('[Relay] OREF local file data all stale (>7d)');
      return null;
    }
    console.log(`[Relay] OREF local file: ${filtered.length} waves (saved ${data.savedAt || 'unknown'})`);
    return filtered;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[Relay] OREF local file read error:', err.message);
    return null;
  }
}

function orefSaveLocalHistory() {
  if (!OREF_LOCAL_FILE) return;
  try {
    const fs = require('fs');
    let waves = orefState.history;
    if (waves.length > OREF_PERSIST_MAX_WAVES) {
      waves = waves.slice(-OREF_PERSIST_MAX_WAVES);
    }
    const payload = JSON.stringify({
      history: waves,
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      savedAt: new Date().toISOString(),
    });
    const tmpPath = OREF_LOCAL_FILE + '.tmp';
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, OREF_LOCAL_FILE);
  } catch (err) {
    console.warn('[Relay] OREF local file save error:', err.message);
  }
}

async function orefBootstrapHistoryWithRetry() {
  // Phase 0: local file (Railway volume — instant, no network)
  if (OREF_LOCAL_FILE) {
    const local = orefLoadLocalHistory();
    if (local && local.length > 0) {
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      orefState.history = local;
      orefState.totalHistoryCount = local.reduce((sum, h) => {
        return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
      }, 0);
      orefState.historyCount24h = local
        .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
        .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
      const newest = local[local.length - 1];
      orefState.lastAlertsJson = JSON.stringify(newest.alerts);
      orefState.bootstrapSource = 'local-file';
      console.log(`[Relay] OREF history loaded from local file: ${orefState.totalHistoryCount} records across ${local.length} waves`);
      return;
    }
  }

  // Phase 1: try Redis first
  try {
    const cached = await upstashGet(OREF_REDIS_KEY);
    if (cached && Array.isArray(cached.history) && cached.history.length > 0) {
      const valid = cached.history.every(
        h => Array.isArray(h.alerts) && typeof h.timestamp === 'string'
      );
      if (valid) {
        const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
        const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const filtered = cached.history.filter(
          h => new Date(h.timestamp).getTime() > purgeCutoff
        );
        if (filtered.length > 0) {
          orefState.history = filtered;
          orefState.totalHistoryCount = filtered.reduce((sum, h) => {
            return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
          }, 0);
          orefState.historyCount24h = filtered
            .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
            .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
          const newest = filtered[filtered.length - 1];
          orefState.lastAlertsJson = JSON.stringify(newest.alerts);
          orefState.bootstrapSource = 'redis';
          console.log(`[Relay] OREF history loaded from Redis: ${orefState.totalHistoryCount} records across ${filtered.length} waves (persisted ${cached.persistedAt || 'unknown'})`);
          return;
        }
        console.log('[Relay] OREF Redis data all stale (>7d) — falling through to upstream');
      }
    }
  } catch (err) {
    console.warn('[Relay] OREF Redis bootstrap failed:', err?.message || err);
  }

  // Phase 2: upstream with retry + exponential backoff
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 3000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await orefBootstrapHistoryFromUpstream();
      if (UPSTASH_ENABLED) {
        await orefPersistHistory().catch(() => {});
      }
      console.log(`[Relay] OREF upstream bootstrap succeeded on attempt ${attempt}`);
      return;
    } catch (err) {
      const msg = redactOrefError(err?.message || String(err));
      console.warn(`[Relay] OREF upstream bootstrap attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  orefState.bootstrapSource = null;
  console.warn('[Relay] OREF bootstrap exhausted all attempts — starting with empty history');
}

async function startOrefPollLoop() {
  if (!OREF_ENABLED) {
    console.log('[Relay] OREF disabled (no OREF_PROXY_AUTH)');
    return;
  }
  await orefBootstrapHistoryWithRetry();
  console.log(`[Relay] OREF bootstrap complete (source: ${orefState.bootstrapSource || 'none'}, redis: ${UPSTASH_ENABLED})`);
  orefFetchAlerts().catch(e => console.warn('[Relay] OREF initial poll error:', e?.message || e));
  setInterval(() => {
    orefFetchAlerts().catch(e => console.warn('[Relay] OREF poll error:', e?.message || e));
  }, OREF_POLL_INTERVAL_MS).unref?.();
  console.log(`[Relay] OREF poll loop started (interval ${OREF_POLL_INTERVAL_MS}ms)`);
}

// ─────────────────────────────────────────────────────────────
// UCDP GED Events — fetch paginated conflict data, write to Redis
// ─────────────────────────────────────────────────────────────
const UCDP_ACCESS_TOKEN = (process.env.UCDP_ACCESS_TOKEN || process.env.UC_DP_KEY || '').trim();
const UCDP_REDIS_KEY = 'conflict:ucdp-events:v1';
const UCDP_PAGE_SIZE = 1000;
const UCDP_MAX_PAGES = 6;
const UCDP_MAX_EVENTS = 2000; // TODO: review cap after observing real map density & panel usage
const UCDP_TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const UCDP_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const UCDP_TTL_SECONDS = 86400; // 24h safety net
const UCDP_VIOLENCE_TYPE_MAP = { 1: 'UCDP_VIOLENCE_TYPE_STATE_BASED', 2: 'UCDP_VIOLENCE_TYPE_NON_STATE', 3: 'UCDP_VIOLENCE_TYPE_ONE_SIDED' };

function ucdpFetchPage(version, page) {
  return new Promise((resolve, reject) => {
    const pageUrl = new URL(`https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`);
    const headers = { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    if (UCDP_ACCESS_TOKEN) headers['x-ucdp-access-token'] = UCDP_ACCESS_TOKEN;
    const req = https.request(pageUrl, { method: 'GET', headers, timeout: 30000 }, (resp) => {
      if (resp.statusCode === 401 || resp.statusCode === 403) {
        resp.resume();
        return reject(new Error(`UCDP ${version} page ${page}: HTTP ${resp.statusCode} — API token required (set UCDP_ACCESS_TOKEN env var)`));
      }
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return reject(new Error(`UCDP ${version} page ${page}: HTTP ${resp.statusCode}`));
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (typeof parsed === 'string') return reject(new Error(`UCDP ${version} page ${page}: ${parsed}`));
          resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UCDP timeout')); });
    req.end();
  });
}

async function ucdpDiscoverVersion() {
  const year = new Date().getFullYear() - 2000;
  const candidates = [...new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1'])];
  // Race all candidates — first valid result wins (avoids 30s hang on broken versions)
  const attempts = candidates.map(async (v) => {
    const p0 = await ucdpFetchPage(v, 0);
    if (!Array.isArray(p0?.Result) || p0.Result.length === 0) throw new Error(`${v}: no results`);
    return { version: v, page0: p0 };
  });
  try {
    return await Promise.any(attempts);
  } catch (aggErr) {
    const reasons = aggErr.errors?.map(e => e?.message).join('; ') || aggErr.message;
    throw new Error(`No valid UCDP GED version found (${reasons})`);
  }
}

async function seedUcdpEvents() {
  try {
    const { version, page0 } = await ucdpDiscoverVersion();
    const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
    const newestPage = totalPages - 1;
    console.log(`[UCDP] Version ${version}, ${totalPages} total pages`);

    const FAILED = Symbol('failed');
    const fetches = [];
    for (let offset = 0; offset < UCDP_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
      const pg = newestPage - offset;
      fetches.push(pg === 0 ? Promise.resolve(page0) : ucdpFetchPage(version, pg).catch(() => FAILED));
    }
    const pageResults = await Promise.all(fetches);

    const allEvents = [];
    let latestMs = NaN;
    let failedPages = 0;
    for (const raw of pageResults) {
      if (raw === FAILED) { failedPages++; continue; }
      const events = Array.isArray(raw?.Result) ? raw.Result : [];
      allEvents.push(...events);
      for (const e of events) {
        const ms = e?.date_start ? Date.parse(String(e.date_start)) : NaN;
        if (Number.isFinite(ms) && (!Number.isFinite(latestMs) || ms > latestMs)) latestMs = ms;
      }
    }

    const filtered = allEvents.filter((e) => {
      if (!Number.isFinite(latestMs)) return true;
      const ms = e?.date_start ? Date.parse(String(e.date_start)) : NaN;
      return Number.isFinite(ms) && ms >= (latestMs - UCDP_TRAILING_WINDOW_MS);
    });

    const mapped = filtered.map((e) => ({
      id: String(e.id || ''),
      dateStart: Date.parse(e.date_start) || 0,
      dateEnd: Date.parse(e.date_end) || 0,
      location: { latitude: Number(e.latitude) || 0, longitude: Number(e.longitude) || 0 },
      country: e.country || '',
      sideA: (e.side_a || '').substring(0, 200),
      sideB: (e.side_b || '').substring(0, 200),
      deathsBest: Number(e.best) || 0,
      deathsLow: Number(e.low) || 0,
      deathsHigh: Number(e.high) || 0,
      violenceType: UCDP_VIOLENCE_TYPE_MAP[e.type_of_violence] || 'UCDP_VIOLENCE_TYPE_UNSPECIFIED',
      sourceOriginal: (e.source_original || '').substring(0, 300),
    })).sort((a, b) => b.dateStart - a.dateStart).slice(0, UCDP_MAX_EVENTS);

    const payload = { events: mapped, fetchedAt: Date.now(), version, totalRaw: allEvents.length, filteredCount: mapped.length };
    const ok = await upstashSet(UCDP_REDIS_KEY, payload, UCDP_TTL_SECONDS);
    await upstashSet('seed-meta:conflict:ucdp-events', { fetchedAt: Date.now(), recordCount: mapped.length }, 604800);
    console.log(`[UCDP] Seeded ${mapped.length} events (raw: ${allEvents.length}, failed pages: ${failedPages}, redis: ${ok ? 'OK' : 'FAIL'})`);
  } catch (e) {
    console.warn('[UCDP] Seed error:', e?.message || e);
  }
}

async function startUcdpSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[UCDP] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[UCDP] Seed loop starting (interval ${UCDP_POLL_INTERVAL_MS / 1000 / 60}min, token: ${UCDP_ACCESS_TOKEN ? 'yes' : 'no'})`);
  seedUcdpEvents().catch(e => console.warn('[UCDP] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedUcdpEvents().catch(e => console.warn('[UCDP] Seed error:', e?.message || e));
  }, UCDP_POLL_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Satellite TLE Seed — CelesTrak NORAD elements → Redis
// ─────────────────────────────────────────────────────────────
const SAT_SEED_INTERVAL_MS = 7_200_000;
const SAT_SEED_TTL = 14_400;
const SAT_GROUPS = ['military', 'resource', 'active'];

const SAT_NAME_FILTERS = [
  /^YAOGAN/i, /^GAOFEN/i, /^JILIN/i,
  /^COSMOS 2[4-9]\d{2}/i,
  /^COSMO-SKYMED/i, /^TERRASAR/i, /^PAZ$/i, /^SAR-LUPE/i,
  /^WORLDVIEW/i, /^SKYSAT/i, /^PLEIADES/i, /^KOMPSAT/i,
  /^SAPPHIRE/i, /^PRAETORIAN/i,
  /^SENTINEL/i,
  /^CARTOSAT/i,
  /^GOKTURK/i, /^RASAT/i,
  /^USA[ -]?\d/i,
  /^ZIYUAN/i,
];

function satClassify(name) {
  const n = name.toUpperCase();
  let type = 'military';
  if (/COSMO-SKYMED|TERRASAR|PAZ|SAR-LUPE|YAOGAN/i.test(n)) type = 'sar';
  else if (/WORLDVIEW|SKYSAT|PLEIADES|KOMPSAT|GAOFEN|JILIN|CARTOSAT|ZIYUAN/i.test(n)) type = 'optical';
  else if (/SAPPHIRE|PRAETORIAN|USA|GOKTURK/i.test(n)) type = 'military';

  let country = 'OTHER';
  if (/^YAOGAN|^GAOFEN|^JILIN|^ZIYUAN/i.test(n)) country = 'CN';
  else if (/^COSMOS/i.test(n)) country = 'RU';
  else if (/^WORLDVIEW|^SAPPHIRE|^PRAETORIAN|^USA|^SKYSAT/i.test(n)) country = 'US';
  else if (/^SENTINEL|^COSMO-SKYMED|^TERRASAR|^SAR-LUPE|^PAZ|^PLEIADES/i.test(n)) country = 'EU';
  else if (/^KOMPSAT/i.test(n)) country = 'KR';
  else if (/^CARTOSAT/i.test(n)) country = 'IN';
  else if (/^GOKTURK|^RASAT/i.test(n)) country = 'TR';

  return { type, country };
}

let satSeedInFlight = false;

async function seedSatelliteTLEs() {
  if (satSeedInFlight) return;
  satSeedInFlight = true;
  const t0 = Date.now();
  try {
    const byNorad = new Map();

    for (const group of SAT_GROUPS) {
      let text;
      try {
        text = await new Promise((resolve, reject) => {
          const url = new URL(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`);
          const req = https.request(url, { method: 'GET', headers: { 'User-Agent': CHROME_UA }, timeout: 15000 }, (resp) => {
            if (resp.statusCode < 200 || resp.statusCode >= 300) {
              resp.resume();
              return reject(new Error(`CelesTrak ${group}: HTTP ${resp.statusCode}`));
            }
            let data = '';
            let size = 0;
            resp.on('data', (chunk) => {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) { req.destroy(); return reject(new Error(`CelesTrak ${group}: payload > 2MB`)); }
              data += chunk;
            });
            resp.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error(`CelesTrak ${group}: timeout`)); });
          req.end();
        });
      } catch (e) {
        console.warn(`[Satellites] Skipping group ${group}:`, e?.message || e);
        continue;
      }

      const lines = text.split('\n').map(l => l.trimEnd());
      for (let i = 0; i < lines.length - 2; i++) {
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
        if (l1.length !== 69 || l2.length !== 69) continue;
        const name = lines[i].trim();
        const noradId = l1.substring(2, 7).trim();
        if (!byNorad.has(noradId)) {
          byNorad.set(noradId, { noradId, name, line1: l1, line2: l2 });
        }
        i += 2;
      }
    }

    const satellites = [];
    for (const sat of byNorad.values()) {
      if (!SAT_NAME_FILTERS.some(rx => rx.test(sat.name))) continue;
      const { type, country } = satClassify(sat.name);
      satellites.push({ ...sat, type, country });
    }

    if (satellites.length === 0) {
      console.warn('[Satellites] No matching TLEs found — skipping write');
      return;
    }

    const payload = { satellites, fetchedAt: Date.now() };
    const ok = await upstashSet('intelligence:satellites:tle:v1', payload, SAT_SEED_TTL);
    await upstashSet('seed-meta:intelligence:satellites', { fetchedAt: Date.now(), recordCount: satellites.length }, 604800);
    console.log(`[Satellites] Seeded ${satellites.length} TLEs (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[Satellites] Seed error:', e?.message || e);
  } finally {
    satSeedInFlight = false;
  }
}

async function startSatelliteSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[Satellites] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[Satellites] Seed loop starting (interval ${SAT_SEED_INTERVAL_MS / 1000 / 60}min)`);
  seedSatelliteTLEs().catch(e => console.warn('[Satellites] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedSatelliteTLEs().catch(e => console.warn('[Satellites] Seed error:', e?.message || e));
  }, SAT_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Market Data Seed — Railway fetches Yahoo/Finnhub → writes to Redis
// so Vercel handlers serve from cache (avoids Yahoo 429 from Vercel IPs)
// ─────────────────────────────────────────────────────────────
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';
const MARKET_SEED_INTERVAL_MS = 300_000; // 5 min
const MARKET_SEED_TTL = 1800; // 30 min — survives 5 missed cycles

// Must match src/config/markets.ts MARKET_SYMBOLS — update both when changing
const MARKET_SYMBOLS = [
  'AAPL', 'AMZN', 'AVGO', 'BAC', 'BRK-B', 'COST', 'GOOGL', 'HD',
  'JNJ', 'JPM', 'LLY', 'MA', 'META', 'MSFT', 'NFLX', 'NVO', 'NVDA',
  'ORCL', 'PG', 'TSLA', 'TSM', 'UNH', 'V', 'WMT', 'XOM',
  '^DJI', '^GSPC', '^IXIC',
];

const COMMODITY_SYMBOLS = ['^VIX', 'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F'];

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];

const YAHOO_ONLY = new Set(['^GSPC', '^DJI', '^IXIC', '^VIX', 'GC=F', 'CL=F', 'NG=F', 'SI=F', 'HG=F']);

function fetchYahooChartDirect(symbol) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const req = https.get(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      timeout: 10000,
    }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        logThrottled('warn', `market-yahoo-${resp.statusCode}:${symbol}`, `[Market] Yahoo ${symbol} HTTP ${resp.statusCode}`);
        return resolve(null);
      }
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          const result = data?.chart?.result?.[0];
          const meta = result?.meta;
          if (!meta) return resolve(null);
          const price = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose || meta.previousClose || price;
          const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
          const closes = result.indicators?.quote?.[0]?.close;
          const sparkline = Array.isArray(closes) ? closes.filter((v) => v != null) : [];
          resolve({ price, change, sparkline });
        } catch { resolve(null); }
      });
    });
    req.on('error', (err) => { logThrottled('warn', `market-yahoo-err:${symbol}`, `[Market] Yahoo ${symbol} error: ${err.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); logThrottled('warn', `market-yahoo-timeout:${symbol}`, `[Market] Yahoo ${symbol} timeout`); resolve(null); });
  });
}

function fetchFinnhubQuoteDirect(symbol, apiKey) {
  return new Promise((resolve) => {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const req = https.get(url, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', 'X-Finnhub-Token': apiKey },
      timeout: 10000,
    }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        return resolve(null);
      }
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.c === 0 && data.h === 0 && data.l === 0) return resolve(null);
          resolve({ price: data.c, changePercent: data.dp });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function seedMarketQuotes() {
  const quotes = [];
  const finnhubSymbols = MARKET_SYMBOLS.filter((s) => !YAHOO_ONLY.has(s));
  const yahooSymbols = MARKET_SYMBOLS.filter((s) => YAHOO_ONLY.has(s));

  if (FINNHUB_API_KEY && finnhubSymbols.length > 0) {
    const results = await Promise.all(finnhubSymbols.map((s) => fetchFinnhubQuoteDirect(s, FINNHUB_API_KEY)));
    for (let i = 0; i < finnhubSymbols.length; i++) {
      const r = results[i];
      if (r) quotes.push({ symbol: finnhubSymbols[i], name: finnhubSymbols[i], display: finnhubSymbols[i], price: r.price, change: r.changePercent, sparkline: [] });
    }
  }

  const missedFinnhub = FINNHUB_API_KEY
    ? finnhubSymbols.filter((s) => !quotes.some((q) => q.symbol === s))
    : finnhubSymbols;
  const allYahoo = [...yahooSymbols, ...missedFinnhub];

  for (const s of allYahoo) {
    if (quotes.some((q) => q.symbol === s)) continue;
    const yahoo = await fetchYahooChartDirect(s);
    if (yahoo) quotes.push({ symbol: s, name: s, display: s, price: yahoo.price, change: yahoo.change, sparkline: yahoo.sparkline });
    await sleep(150);
  }

  if (quotes.length === 0) {
    console.warn('[Market] No quotes fetched — skipping Redis write');
    return 0;
  }

  const coveredByYahoo = finnhubSymbols.every((s) => quotes.some((q) => q.symbol === s));
  const skipped = !FINNHUB_API_KEY && !coveredByYahoo;
  const payload = { quotes, finnhubSkipped: skipped, skipReason: skipped ? 'FINNHUB_API_KEY not configured' : '', rateLimited: false };
  const redisKey = `market:quotes:v1:${[...MARKET_SYMBOLS].sort().join(',')}`;
  const ok = await upstashSet(redisKey, payload, MARKET_SEED_TTL);
  // Bootstrap-friendly fixed key — frontend hydrates from /api/bootstrap without RPC
  const ok2 = await upstashSet('market:stocks-bootstrap:v1', payload, MARKET_SEED_TTL);
  const ok3 = await upstashSet('seed-meta:market:stocks', { fetchedAt: Date.now(), recordCount: quotes.length }, 604800);
  console.log(`[Market] Seeded ${quotes.length}/${MARKET_SYMBOLS.length} quotes (redis: ${ok && ok2 && ok3 ? 'OK' : 'PARTIAL'})`);
  return quotes.length;
}

async function seedCommodityQuotes() {
  const quotes = [];
  for (const s of COMMODITY_SYMBOLS) {
    const yahoo = await fetchYahooChartDirect(s);
    if (yahoo) quotes.push({ symbol: s, name: s, display: s, price: yahoo.price, change: yahoo.change, sparkline: yahoo.sparkline });
    await sleep(150);
  }

  if (quotes.length === 0) {
    console.warn('[Market] No commodity quotes fetched — skipping Redis write');
    return 0;
  }

  const payload = { quotes };
  const redisKey = `market:commodities:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const ok = await upstashSet(redisKey, payload, MARKET_SEED_TTL);
  // Also write under market:quotes:v1: key — the frontend routes commodities through
  // listMarketQuotes RPC, which constructs this key pattern (not market:commodities:v1:)
  const quotesKey = `market:quotes:v1:${[...COMMODITY_SYMBOLS].sort().join(',')}`;
  const quotesPayload = { quotes, finnhubSkipped: false, skipReason: '', rateLimited: false };
  const ok2 = await upstashSet(quotesKey, quotesPayload, MARKET_SEED_TTL);
  // Bootstrap-friendly fixed key — frontend hydrates from /api/bootstrap without RPC
  const ok3 = await upstashSet('market:commodities-bootstrap:v1', quotesPayload, MARKET_SEED_TTL);
  const ok4 = await upstashSet('seed-meta:market:commodities', { fetchedAt: Date.now(), recordCount: quotes.length }, 604800);
  console.log(`[Market] Seeded ${quotes.length}/${COMMODITY_SYMBOLS.length} commodities (redis: ${ok && ok2 && ok3 && ok4 ? 'OK' : 'PARTIAL'})`);
  return quotes.length;
}

async function seedSectorSummary() {
  const sectors = [];

  if (FINNHUB_API_KEY) {
    const results = await Promise.all(SECTOR_SYMBOLS.map((s) => fetchFinnhubQuoteDirect(s, FINNHUB_API_KEY)));
    for (let i = 0; i < SECTOR_SYMBOLS.length; i++) {
      const r = results[i];
      if (r) sectors.push({ symbol: SECTOR_SYMBOLS[i], name: SECTOR_SYMBOLS[i], change: r.changePercent });
    }
  }

  if (sectors.length === 0) {
    for (const s of SECTOR_SYMBOLS) {
      const yahoo = await fetchYahooChartDirect(s);
      if (yahoo) sectors.push({ symbol: s, name: s, change: yahoo.change });
      await sleep(150);
    }
  }

  if (sectors.length === 0) {
    console.warn('[Market] No sector data fetched — skipping Redis write');
    return 0;
  }

  const payload = { sectors };
  const ok = await upstashSet('market:sectors:v1', payload, MARKET_SEED_TTL);
  // Also write under market:quotes:v1: key — the frontend routes sectors through
  // fetchMultipleStocks → listMarketQuotes RPC, which constructs this key pattern
  const quotesKey = `market:quotes:v1:${[...SECTOR_SYMBOLS].sort().join(',')}`;
  const sectorQuotes = sectors.map((s) => ({
    symbol: s.symbol, name: s.name, display: s.name,
    price: 0, change: s.change, sparkline: [],
  }));
  const quotesPayload = { quotes: sectorQuotes, finnhubSkipped: false, skipReason: '', rateLimited: false };
  const ok2 = await upstashSet(quotesKey, quotesPayload, MARKET_SEED_TTL);
  const ok3 = await upstashSet('seed-meta:market:sectors', { fetchedAt: Date.now(), recordCount: sectors.length }, 604800);
  console.log(`[Market] Seeded ${sectors.length}/${SECTOR_SYMBOLS.length} sectors (redis: ${ok && ok2 && ok3 ? 'OK' : 'PARTIAL'})`);
  return sectors.length;
}

// Gulf Quotes — Yahoo Finance (14 symbols: indices, currencies, oil)
const GULF_SYMBOLS = [
  { symbol: '^TASI.SR', name: 'Tadawul All Share', country: 'Saudi Arabia', flag: '\u{1F1F8}\u{1F1E6}', type: 'index' },
  { symbol: 'DFMGI.AE', name: 'Dubai Financial Market', country: 'UAE', flag: '\u{1F1E6}\u{1F1EA}', type: 'index' },
  { symbol: 'UAE', name: 'Abu Dhabi (iShares)', country: 'UAE', flag: '\u{1F1E6}\u{1F1EA}', type: 'index' },
  { symbol: 'QAT', name: 'Qatar (iShares)', country: 'Qatar', flag: '\u{1F1F6}\u{1F1E6}', type: 'index' },
  { symbol: 'GULF', name: 'Gulf Dividend (WisdomTree)', country: 'Kuwait', flag: '\u{1F1F0}\u{1F1FC}', type: 'index' },
  { symbol: '^MSM', name: 'Muscat MSM 30', country: 'Oman', flag: '\u{1F1F4}\u{1F1F2}', type: 'index' },
  { symbol: 'SARUSD=X', name: 'Saudi Riyal', country: 'Saudi Arabia', flag: '\u{1F1F8}\u{1F1E6}', type: 'currency' },
  { symbol: 'AEDUSD=X', name: 'UAE Dirham', country: 'UAE', flag: '\u{1F1E6}\u{1F1EA}', type: 'currency' },
  { symbol: 'QARUSD=X', name: 'Qatari Riyal', country: 'Qatar', flag: '\u{1F1F6}\u{1F1E6}', type: 'currency' },
  { symbol: 'KWDUSD=X', name: 'Kuwaiti Dinar', country: 'Kuwait', flag: '\u{1F1F0}\u{1F1FC}', type: 'currency' },
  { symbol: 'BHDUSD=X', name: 'Bahraini Dinar', country: 'Bahrain', flag: '\u{1F1E7}\u{1F1ED}', type: 'currency' },
  { symbol: 'OMRUSD=X', name: 'Omani Rial', country: 'Oman', flag: '\u{1F1F4}\u{1F1F2}', type: 'currency' },
  { symbol: 'CL=F', name: 'WTI Crude', country: '', flag: '\u{1F6E2}\u{FE0F}', type: 'oil' },
  { symbol: 'BZ=F', name: 'Brent Crude', country: '', flag: '\u{1F6E2}\u{FE0F}', type: 'oil' },
];
const GULF_SEED_TTL = 5400; // 90min — survives 1 missed cycle

async function seedGulfQuotes() {
  const quotes = [];
  for (const meta of GULF_SYMBOLS) {
    const yahoo = await fetchYahooChartDirect(meta.symbol);
    if (yahoo) {
      quotes.push({
        symbol: meta.symbol, name: meta.name, country: meta.country,
        flag: meta.flag, type: meta.type,
        price: yahoo.price, change: +(yahoo.change).toFixed(2), sparkline: yahoo.sparkline,
      });
    }
    await sleep(150);
  }
  if (quotes.length === 0) { console.warn('[Gulf] No quotes fetched — skipping'); return 0; }
  const payload = { quotes, rateLimited: false };
  const ok1 = await upstashSet('market:gulf-quotes:v1', payload, GULF_SEED_TTL);
  const ok2 = await upstashSet('seed-meta:market:gulf-quotes', { fetchedAt: Date.now(), recordCount: quotes.length }, 604800);
  console.log(`[Gulf] Seeded ${quotes.length}/${GULF_SYMBOLS.length} quotes (redis: ${ok1 && ok2 ? 'OK' : 'PARTIAL'})`);
  return quotes.length;
}

// ETF Flows — Yahoo Finance (10 BTC spot ETFs)
const ETF_LIST = [
  { ticker: 'IBIT', issuer: 'BlackRock' }, { ticker: 'FBTC', issuer: 'Fidelity' },
  { ticker: 'ARKB', issuer: 'ARK/21Shares' }, { ticker: 'BITB', issuer: 'Bitwise' },
  { ticker: 'GBTC', issuer: 'Grayscale' }, { ticker: 'HODL', issuer: 'VanEck' },
  { ticker: 'BRRR', issuer: 'Valkyrie' }, { ticker: 'EZBC', issuer: 'Franklin' },
  { ticker: 'BTCO', issuer: 'Invesco' }, { ticker: 'BTCW', issuer: 'WisdomTree' },
];
const ETF_SEED_TTL = 5400; // 90min

function parseEtfChart(chart, ticker, issuer) {
  const result = chart?.chart?.result?.[0];
  if (!result) return null;
  const closes = (result.indicators?.quote?.[0]?.close || []).filter((v) => v != null);
  const volumes = (result.indicators?.quote?.[0]?.volume || []).filter((v) => v != null);
  if (closes.length < 2) return null;
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const priceChange = prev ? ((price - prev) / prev) * 100 : 0;
  const vol = volumes.length > 0 ? volumes[volumes.length - 1] : 0;
  const avgVol = volumes.length > 1 ? volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1) : vol;
  const volumeRatio = avgVol > 0 ? vol / avgVol : 1;
  const direction = priceChange > 0.1 ? 'inflow' : priceChange < -0.1 ? 'outflow' : 'neutral';
  return { ticker, issuer, price: +price.toFixed(2), priceChange: +priceChange.toFixed(2), volume: vol, avgVolume: Math.round(avgVol), volumeRatio: +volumeRatio.toFixed(2), direction, estFlow: Math.round(vol * price * (priceChange > 0 ? 1 : -1) * 0.1) };
}

async function seedEtfFlows() {
  const etfs = [];
  for (const { ticker, issuer } of ETF_LIST) {
    try {
      const raw = await new Promise((resolve) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`;
        const req = https.get(url, { headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' }, timeout: 10000 }, (resp) => {
          if (resp.statusCode !== 200) { resp.resume(); return resolve(null); }
          let body = '';
          resp.on('data', (chunk) => { body += chunk; });
          resp.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      const parsed = raw ? parseEtfChart(raw, ticker, issuer) : null;
      if (parsed) etfs.push(parsed);
    } catch {}
    await sleep(150);
  }
  if (etfs.length === 0) { console.warn('[ETF] No data fetched — skipping'); return 0; }
  const totalVolume = etfs.reduce((s, e) => s + e.volume, 0);
  const totalEstFlow = etfs.reduce((s, e) => s + e.estFlow, 0);
  const payload = {
    timestamp: new Date().toISOString(),
    summary: { etfCount: etfs.length, totalVolume, totalEstFlow, netDirection: totalEstFlow > 0 ? 'NET INFLOW' : totalEstFlow < 0 ? 'NET OUTFLOW' : 'NEUTRAL', inflowCount: etfs.filter((e) => e.direction === 'inflow').length, outflowCount: etfs.filter((e) => e.direction === 'outflow').length },
    etfs, rateLimited: false,
  };
  const ok1 = await upstashSet('market:etf-flows:v1', payload, ETF_SEED_TTL);
  const ok2 = await upstashSet('seed-meta:market:etf-flows', { fetchedAt: Date.now(), recordCount: etfs.length }, 604800);
  console.log(`[ETF] Seeded ${etfs.length}/${ETF_LIST.length} ETFs (redis: ${ok1 && ok2 ? 'OK' : 'PARTIAL'})`);
  return etfs.length;
}

// Crypto Quotes — CoinGecko → CoinPaprika fallback
const _cryptoCfg = requireShared('crypto.json');
const CRYPTO_IDS = _cryptoCfg.ids;
const CRYPTO_META = _cryptoCfg.meta;
const CRYPTO_PAPRIKA_MAP = _cryptoCfg.coinpaprika;
const CRYPTO_SEED_TTL = 3600; // 1h

async function fetchCryptoCoinPaprika() {
  const data = await cyberHttpGetJson('https://api.coinpaprika.com/v1/tickers?quotes=USD', { Accept: 'application/json' }, 15000);
  if (!Array.isArray(data)) throw new Error('CoinPaprika returned non-array');
  const paprikaIds = new Set(CRYPTO_IDS.map((id) => CRYPTO_PAPRIKA_MAP[id]).filter(Boolean));
  const reverseMap = Object.fromEntries(Object.entries(CRYPTO_PAPRIKA_MAP).map(([g, p]) => [p, g]));
  return data.filter((t) => paprikaIds.has(t.id)).map((t) => ({
    id: reverseMap[t.id] || t.id, current_price: t.quotes.USD.price,
    price_change_percentage_24h: t.quotes.USD.percent_change_24h,
    sparkline_in_7d: undefined, symbol: t.symbol.toLowerCase(), name: t.name,
  }));
}

async function seedCryptoQuotes() {
  let data;
  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    const base = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    const headers = { Accept: 'application/json' };
    if (apiKey) headers['x-cg-pro-api-key'] = apiKey;
    const url = `${base}/coins/markets?vs_currency=usd&ids=${CRYPTO_IDS.join(',')}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
    data = await cyberHttpGetJson(url, headers, 15000);
    if (!Array.isArray(data) || data.length === 0) throw new Error('CoinGecko returned no data');
  } catch (err) {
    console.warn(`[Crypto] CoinGecko failed: ${err.message} — trying CoinPaprika`);
    try { data = await fetchCryptoCoinPaprika(); } catch (e2) { console.warn(`[Crypto] CoinPaprika also failed: ${e2.message} — skipping`); return 0; }
  }
  const quotes = [];
  for (const id of CRYPTO_IDS) {
    const coin = data.find((c) => c.id === id);
    if (!coin) continue;
    const meta = CRYPTO_META[id];
    const prices = coin.sparkline_in_7d?.price;
    quotes.push({ name: meta?.name || id, symbol: meta?.symbol || id.toUpperCase(), price: coin.current_price ?? 0, change: coin.price_change_percentage_24h ?? 0, sparkline: prices && prices.length > 24 ? prices.slice(-48) : (prices || []) });
  }
  if (quotes.length === 0 || quotes.every((q) => q.price === 0)) { console.warn('[Crypto] No valid quotes — skipping'); return 0; }
  const ok1 = await upstashSet('market:crypto:v1', { quotes }, CRYPTO_SEED_TTL);
  const ok2 = await upstashSet('seed-meta:market:crypto', { fetchedAt: Date.now(), recordCount: quotes.length }, 604800);
  console.log(`[Crypto] Seeded ${quotes.length}/${CRYPTO_IDS.length} quotes (redis: ${ok1 && ok2 ? 'OK' : 'PARTIAL'})`);
  return quotes.length;
}

// Stablecoin Markets — CoinGecko → CoinPaprika fallback
const STABLECOIN_IDS = 'tether,usd-coin,dai,first-digital-usd,ethena-usde';
const STABLECOIN_PAPRIKA_MAP = { tether: 'usdt-tether', 'usd-coin': 'usdc-usd-coin', dai: 'dai-dai', 'first-digital-usd': 'fdusd-first-digital-usd', 'ethena-usde': 'usde-ethena-usde' };
const STABLECOIN_SEED_TTL = 3600; // 1h

async function fetchStablecoinCoinPaprika() {
  const data = await cyberHttpGetJson('https://api.coinpaprika.com/v1/tickers?quotes=USD', { Accept: 'application/json' }, 15000);
  if (!Array.isArray(data)) throw new Error('CoinPaprika returned non-array');
  const ids = STABLECOIN_IDS.split(',');
  const paprikaIds = new Set(ids.map((id) => STABLECOIN_PAPRIKA_MAP[id]).filter(Boolean));
  const reverseMap = Object.fromEntries(Object.entries(STABLECOIN_PAPRIKA_MAP).map(([g, p]) => [p, g]));
  return data.filter((t) => paprikaIds.has(t.id)).map((t) => ({
    id: reverseMap[t.id] || t.id, current_price: t.quotes.USD.price,
    price_change_percentage_24h: t.quotes.USD.percent_change_24h,
    price_change_percentage_7d_in_currency: t.quotes.USD.percent_change_7d,
    market_cap: t.quotes.USD.market_cap, total_volume: t.quotes.USD.volume_24h,
    symbol: t.symbol.toLowerCase(), name: t.name, image: '',
  }));
}

async function seedStablecoinMarkets() {
  let data;
  try {
    const apiKey = process.env.COINGECKO_API_KEY;
    const base = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    const headers = { Accept: 'application/json' };
    if (apiKey) headers['x-cg-pro-api-key'] = apiKey;
    const url = `${base}/coins/markets?vs_currency=usd&ids=${STABLECOIN_IDS}&order=market_cap_desc&sparkline=false&price_change_percentage=7d`;
    data = await cyberHttpGetJson(url, headers, 15000);
    if (!Array.isArray(data) || data.length === 0) throw new Error('CoinGecko returned no data');
  } catch (err) {
    console.warn(`[Stablecoin] CoinGecko failed: ${err.message} — trying CoinPaprika`);
    try { data = await fetchStablecoinCoinPaprika(); } catch (e2) { console.warn(`[Stablecoin] CoinPaprika also failed: ${e2.message} — skipping`); return 0; }
  }
  const stablecoins = data.map((coin) => {
    const price = coin.current_price || 0;
    const deviation = Math.abs(price - 1.0);
    const pegStatus = deviation <= 0.005 ? 'ON PEG' : deviation <= 0.01 ? 'SLIGHT DEPEG' : 'DEPEGGED';
    return { id: coin.id, symbol: (coin.symbol || '').toUpperCase(), name: coin.name, price, deviation: +(deviation * 100).toFixed(3), pegStatus, marketCap: coin.market_cap || 0, volume24h: coin.total_volume || 0, change24h: coin.price_change_percentage_24h || 0, change7d: coin.price_change_percentage_7d_in_currency || 0, image: coin.image || '' };
  });
  const totalMarketCap = stablecoins.reduce((s, c) => s + c.marketCap, 0);
  const totalVolume24h = stablecoins.reduce((s, c) => s + c.volume24h, 0);
  const depeggedCount = stablecoins.filter((c) => c.pegStatus === 'DEPEGGED').length;
  const payload = { timestamp: new Date().toISOString(), summary: { totalMarketCap, totalVolume24h, coinCount: stablecoins.length, depeggedCount, healthStatus: depeggedCount === 0 ? 'HEALTHY' : depeggedCount === 1 ? 'CAUTION' : 'WARNING' }, stablecoins };
  const ok1 = await upstashSet('market:stablecoins:v1', payload, STABLECOIN_SEED_TTL);
  const ok2 = await upstashSet('seed-meta:market:stablecoins', { fetchedAt: Date.now(), recordCount: stablecoins.length }, 604800);
  console.log(`[Stablecoin] Seeded ${stablecoins.length} coins (redis: ${ok1 && ok2 ? 'OK' : 'PARTIAL'})`);
  return stablecoins.length;
}

async function seedAllMarketData() {
  const t0 = Date.now();
  const q = await seedMarketQuotes();
  const c = await seedCommodityQuotes();
  const s = await seedSectorSummary();
  const g = await seedGulfQuotes();
  const e = await seedEtfFlows();
  const cr = await seedCryptoQuotes();
  const sc = await seedStablecoinMarkets();
  console.log(`[Market] Seed complete: ${q} quotes, ${c} commodities, ${s} sectors, ${g} gulf, ${e} etf, ${cr} crypto, ${sc} stablecoins (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

async function startMarketDataSeedLoop() {
  if (process.env.DISABLE_RELAY_MARKET_SEED) {
    console.log('[Market] Relay market seeding disabled via DISABLE_RELAY_MARKET_SEED');
    return;
  }
  if (!UPSTASH_ENABLED) {
    console.log('[Market] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[Market] Seed loop starting (interval ${MARKET_SEED_INTERVAL_MS / 1000 / 60}min, finnhub: ${FINNHUB_API_KEY ? 'yes' : 'no'})`);
  seedAllMarketData().catch((e) => console.warn('[Market] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedAllMarketData().catch((e) => console.warn('[Market] Seed error:', e?.message || e));
  }, MARKET_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Aviation Seed — Railway fetches AviationStack → writes to Redis
// so Vercel handler serves from cache (avoids 114 API calls per miss)
// ─────────────────────────────────────────────────────────────
const AVIATIONSTACK_API_KEY = process.env.AVIATIONSTACK_API || '';
const AVIATION_SEED_INTERVAL_MS = 30 * 60 * 1000; // 30min
const AVIATION_SEED_TTL = 3600; // 1h — survives 1 missed cycle
const AVIATION_REDIS_KEY = 'aviation:delays:intl:v3';
const AVIATION_BATCH_CONCURRENCY = 10;
const AVIATION_MIN_FLIGHTS_FOR_CLOSURE = 10;
const RESOLVED_STATUSES = new Set(['cancelled', 'landed', 'active', 'arrived', 'diverted']);

// Must match src/config/airports.ts AVIATIONSTACK_AIRPORTS — update both when changing
const AVIATIONSTACK_AIRPORTS = [
  'YYZ', 'YVR', 'MEX', 'GRU', 'EZE', 'BOG', 'SCL',
  'LHR', 'CDG', 'FRA', 'AMS', 'MAD', 'FCO', 'MUC', 'BCN', 'ZRH', 'IST', 'VIE', 'CPH',
  'DUB', 'LIS', 'ATH', 'WAW',
  'HND', 'NRT', 'PEK', 'PVG', 'HKG', 'SIN', 'ICN', 'BKK', 'SYD', 'DEL', 'BOM', 'KUL',
  'CAN', 'TPE', 'MNL',
  'DXB', 'DOH', 'AUH', 'RUH', 'CAI', 'TLV', 'AMM', 'KWI', 'CMN',
  'JNB', 'NBO', 'LOS', 'ADD', 'CPT',
];

// Airport metadata needed for alert construction (inlined from airports.ts)
const AIRPORT_META = {
  YYZ: { icao: 'CYYZ', name: 'Toronto Pearson', city: 'Toronto', country: 'Canada', lat: 43.6777, lon: -79.6248, region: 'americas' },
  MEX: { icao: 'MMMX', name: 'Mexico City International', city: 'Mexico City', country: 'Mexico', lat: 19.4363, lon: -99.0721, region: 'americas' },
  GRU: { icao: 'SBGR', name: 'São Paulo–Guarulhos', city: 'São Paulo', country: 'Brazil', lat: -23.4356, lon: -46.4731, region: 'americas' },
  EZE: { icao: 'SAEZ', name: 'Ministro Pistarini', city: 'Buenos Aires', country: 'Argentina', lat: -34.8222, lon: -58.5358, region: 'americas' },
  BOG: { icao: 'SKBO', name: 'El Dorado International', city: 'Bogotá', country: 'Colombia', lat: 4.7016, lon: -74.1469, region: 'americas' },
  LHR: { icao: 'EGLL', name: 'London Heathrow', city: 'London', country: 'UK', lat: 51.4700, lon: -0.4543, region: 'europe' },
  CDG: { icao: 'LFPG', name: 'Paris Charles de Gaulle', city: 'Paris', country: 'France', lat: 49.0097, lon: 2.5479, region: 'europe' },
  FRA: { icao: 'EDDF', name: 'Frankfurt Airport', city: 'Frankfurt', country: 'Germany', lat: 50.0379, lon: 8.5622, region: 'europe' },
  AMS: { icao: 'EHAM', name: 'Amsterdam Schiphol', city: 'Amsterdam', country: 'Netherlands', lat: 52.3105, lon: 4.7683, region: 'europe' },
  MAD: { icao: 'LEMD', name: 'Adolfo Suárez Madrid–Barajas', city: 'Madrid', country: 'Spain', lat: 40.4983, lon: -3.5676, region: 'europe' },
  FCO: { icao: 'LIRF', name: 'Leonardo da Vinci–Fiumicino', city: 'Rome', country: 'Italy', lat: 41.8003, lon: 12.2389, region: 'europe' },
  MUC: { icao: 'EDDM', name: 'Munich Airport', city: 'Munich', country: 'Germany', lat: 48.3537, lon: 11.7750, region: 'europe' },
  BCN: { icao: 'LEBL', name: 'Barcelona–El Prat', city: 'Barcelona', country: 'Spain', lat: 41.2974, lon: 2.0833, region: 'europe' },
  ZRH: { icao: 'LSZH', name: 'Zurich Airport', city: 'Zurich', country: 'Switzerland', lat: 47.4647, lon: 8.5492, region: 'europe' },
  IST: { icao: 'LTFM', name: 'Istanbul Airport', city: 'Istanbul', country: 'Turkey', lat: 41.2753, lon: 28.7519, region: 'europe' },
  VIE: { icao: 'LOWW', name: 'Vienna International', city: 'Vienna', country: 'Austria', lat: 48.1103, lon: 16.5697, region: 'europe' },
  CPH: { icao: 'EKCH', name: 'Copenhagen Airport', city: 'Copenhagen', country: 'Denmark', lat: 55.6180, lon: 12.6508, region: 'europe' },
  HND: { icao: 'RJTT', name: 'Tokyo Haneda', city: 'Tokyo', country: 'Japan', lat: 35.5494, lon: 139.7798, region: 'apac' },
  NRT: { icao: 'RJAA', name: 'Narita International', city: 'Tokyo', country: 'Japan', lat: 35.7720, lon: 140.3929, region: 'apac' },
  PEK: { icao: 'ZBAA', name: 'Beijing Capital', city: 'Beijing', country: 'China', lat: 40.0799, lon: 116.6031, region: 'apac' },
  PVG: { icao: 'ZSPD', name: 'Shanghai Pudong', city: 'Shanghai', country: 'China', lat: 31.1443, lon: 121.8083, region: 'apac' },
  HKG: { icao: 'VHHH', name: 'Hong Kong International', city: 'Hong Kong', country: 'China', lat: 22.3080, lon: 113.9185, region: 'apac' },
  SIN: { icao: 'WSSS', name: 'Singapore Changi', city: 'Singapore', country: 'Singapore', lat: 1.3644, lon: 103.9915, region: 'apac' },
  ICN: { icao: 'RKSI', name: 'Incheon International', city: 'Seoul', country: 'South Korea', lat: 37.4602, lon: 126.4407, region: 'apac' },
  BKK: { icao: 'VTBS', name: 'Suvarnabhumi Airport', city: 'Bangkok', country: 'Thailand', lat: 13.6900, lon: 100.7501, region: 'apac' },
  SYD: { icao: 'YSSY', name: 'Sydney Kingsford Smith', city: 'Sydney', country: 'Australia', lat: -33.9461, lon: 151.1772, region: 'apac' },
  DEL: { icao: 'VIDP', name: 'Indira Gandhi International', city: 'Delhi', country: 'India', lat: 28.5562, lon: 77.1000, region: 'apac' },
  BOM: { icao: 'VABB', name: 'Chhatrapati Shivaji Maharaj', city: 'Mumbai', country: 'India', lat: 19.0896, lon: 72.8656, region: 'apac' },
  KUL: { icao: 'WMKK', name: 'Kuala Lumpur International', city: 'Kuala Lumpur', country: 'Malaysia', lat: 2.7456, lon: 101.7099, region: 'apac' },
  DXB: { icao: 'OMDB', name: 'Dubai International', city: 'Dubai', country: 'UAE', lat: 25.2532, lon: 55.3657, region: 'mena' },
  DOH: { icao: 'OTHH', name: 'Hamad International', city: 'Doha', country: 'Qatar', lat: 25.2731, lon: 51.6081, region: 'mena' },
  AUH: { icao: 'OMAA', name: 'Abu Dhabi International', city: 'Abu Dhabi', country: 'UAE', lat: 24.4330, lon: 54.6511, region: 'mena' },
  RUH: { icao: 'OERK', name: 'King Khalid International', city: 'Riyadh', country: 'Saudi Arabia', lat: 24.9576, lon: 46.6988, region: 'mena' },
  CAI: { icao: 'HECA', name: 'Cairo International', city: 'Cairo', country: 'Egypt', lat: 30.1219, lon: 31.4056, region: 'mena' },
  TLV: { icao: 'LLBG', name: 'Ben Gurion Airport', city: 'Tel Aviv', country: 'Israel', lat: 32.0055, lon: 34.8854, region: 'mena' },
  JNB: { icao: 'FAOR', name: 'O.R. Tambo International', city: 'Johannesburg', country: 'South Africa', lat: -26.1392, lon: 28.2460, region: 'africa' },
  NBO: { icao: 'HKJK', name: 'Jomo Kenyatta International', city: 'Nairobi', country: 'Kenya', lat: -1.3192, lon: 36.9278, region: 'africa' },
  LOS: { icao: 'DNMM', name: 'Murtala Muhammed International', city: 'Lagos', country: 'Nigeria', lat: 6.5774, lon: 3.3212, region: 'africa' },
  ADD: { icao: 'HAAB', name: 'Bole International', city: 'Addis Ababa', country: 'Ethiopia', lat: 8.9779, lon: 38.7993, region: 'africa' },
  CPT: { icao: 'FACT', name: 'Cape Town International', city: 'Cape Town', country: 'South Africa', lat: -33.9715, lon: 18.6021, region: 'africa' },
  // Added airports
  YVR: { icao: 'CYVR', name: 'Vancouver International', city: 'Vancouver', country: 'Canada', lat: 49.1947, lon: -123.1792, region: 'americas' },
  SCL: { icao: 'SCEL', name: 'Arturo Merino Benítez', city: 'Santiago', country: 'Chile', lat: -33.3930, lon: -70.7858, region: 'americas' },
  DUB: { icao: 'EIDW', name: 'Dublin Airport', city: 'Dublin', country: 'Ireland', lat: 53.4264, lon: -6.2499, region: 'europe' },
  LIS: { icao: 'LPPT', name: 'Humberto Delgado Airport', city: 'Lisbon', country: 'Portugal', lat: 38.7756, lon: -9.1354, region: 'europe' },
  ATH: { icao: 'LGAV', name: 'Athens International', city: 'Athens', country: 'Greece', lat: 37.9364, lon: 23.9445, region: 'europe' },
  WAW: { icao: 'EPWA', name: 'Warsaw Chopin Airport', city: 'Warsaw', country: 'Poland', lat: 52.1657, lon: 20.9671, region: 'europe' },
  CAN: { icao: 'ZGGG', name: 'Guangzhou Baiyun International', city: 'Guangzhou', country: 'China', lat: 23.3924, lon: 113.2988, region: 'apac' },
  TPE: { icao: 'RCTP', name: 'Taiwan Taoyuan International', city: 'Taipei', country: 'Taiwan', lat: 25.0797, lon: 121.2342, region: 'apac' },
  MNL: { icao: 'RPLL', name: 'Ninoy Aquino International', city: 'Manila', country: 'Philippines', lat: 14.5086, lon: 121.0197, region: 'apac' },
  AMM: { icao: 'OJAI', name: 'Queen Alia International', city: 'Amman', country: 'Jordan', lat: 31.7226, lon: 35.9932, region: 'mena' },
  KWI: { icao: 'OKBK', name: 'Kuwait International', city: 'Kuwait City', country: 'Kuwait', lat: 29.2266, lon: 47.9689, region: 'mena' },
  CMN: { icao: 'GMMN', name: 'Mohammed V International', city: 'Casablanca', country: 'Morocco', lat: 33.3675, lon: -7.5898, region: 'mena' },
};

const REGION_MAP = {
  americas: 'AIRPORT_REGION_AMERICAS',
  europe: 'AIRPORT_REGION_EUROPE',
  apac: 'AIRPORT_REGION_APAC',
  mena: 'AIRPORT_REGION_MENA',
  africa: 'AIRPORT_REGION_AFRICA',
};

const DELAY_TYPE_MAP = {
  ground_stop: 'FLIGHT_DELAY_TYPE_GROUND_STOP',
  ground_delay: 'FLIGHT_DELAY_TYPE_GROUND_DELAY',
  departure_delay: 'FLIGHT_DELAY_TYPE_DEPARTURE_DELAY',
  arrival_delay: 'FLIGHT_DELAY_TYPE_ARRIVAL_DELAY',
  general: 'FLIGHT_DELAY_TYPE_GENERAL',
  closure: 'FLIGHT_DELAY_TYPE_CLOSURE',
};

const SEVERITY_MAP = {
  normal: 'FLIGHT_DELAY_SEVERITY_NORMAL',
  minor: 'FLIGHT_DELAY_SEVERITY_MINOR',
  moderate: 'FLIGHT_DELAY_SEVERITY_MODERATE',
  major: 'FLIGHT_DELAY_SEVERITY_MAJOR',
  severe: 'FLIGHT_DELAY_SEVERITY_SEVERE',
};

function aviationDetermineSeverity(avgDelay, delayedPct) {
  if (avgDelay >= 60 || (delayedPct && delayedPct >= 60)) return 'severe';
  if (avgDelay >= 45 || (delayedPct && delayedPct >= 45)) return 'major';
  if (avgDelay >= 30 || (delayedPct && delayedPct >= 30)) return 'moderate';
  if (avgDelay >= 15 || (delayedPct && delayedPct >= 15)) return 'minor';
  return 'normal';
}

function fetchAviationStackSingle(apiKey, iata) {
  return new Promise((resolve) => {
    const today = new Date().toISOString().slice(0, 10);
    const url = `https://api.aviationstack.com/v1/flights?access_key=${apiKey}&dep_iata=${iata}&flight_date=${today}&limit=100`;
    const req = https.get(url, {
      headers: { 'User-Agent': CHROME_UA },
      timeout: 5000,
      family: 4,
    }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        logThrottled('warn', `aviation-http-${resp.statusCode}:${iata}`, `[Aviation] ${iata}: HTTP ${resp.statusCode}`);
        return resolve({ ok: false, alert: null });
      }
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) {
            logThrottled('warn', `aviation-api-err:${iata}`, `[Aviation] ${iata}: API error: ${json.error.message}`);
            return resolve({ ok: false, alert: null });
          }
          const flights = json?.data ?? [];
          const alert = aviationAggregateFlights(iata, flights);
          resolve({ ok: true, alert });
        } catch { resolve({ ok: false, alert: null }); }
      });
    });
    req.on('error', (err) => {
      logThrottled('warn', `aviation-err:${iata}`, `[Aviation] ${iata}: fetch error: ${err.message}`);
      resolve({ ok: false, alert: null });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, alert: null }); });
  });
}

function aviationAggregateFlights(iata, flights) {
  if (flights.length === 0) return null;
  const meta = AIRPORT_META[iata];
  if (!meta) return null;

  let delayed = 0, cancelled = 0, totalDelay = 0, resolved = 0;
  for (const f of flights) {
    if (RESOLVED_STATUSES.has(f.flight_status || '')) resolved++;
    if (f.flight_status === 'cancelled') cancelled++;
    if (f.departure?.delay && f.departure.delay > 0) {
      delayed++;
      totalDelay += f.departure.delay;
    }
  }

  const total = resolved >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE ? resolved : flights.length;
  const cancelledPct = (cancelled / total) * 100;
  const delayedPct = (delayed / total) * 100;
  const avgDelay = delayed > 0 ? Math.round(totalDelay / delayed) : 0;

  let severity, delayType, reason;
  if (cancelledPct >= 80 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'severe'; delayType = 'closure';
    reason = 'Airport closure / airspace restrictions';
  } else if (cancelledPct >= 50 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'major'; delayType = 'ground_stop';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (cancelledPct >= 20 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'moderate'; delayType = 'ground_delay';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (cancelledPct >= 10 && total >= AVIATION_MIN_FLIGHTS_FOR_CLOSURE) {
    severity = 'minor'; delayType = 'general';
    reason = `${Math.round(cancelledPct)}% flights cancelled`;
  } else if (avgDelay > 0) {
    severity = aviationDetermineSeverity(avgDelay, delayedPct);
    delayType = avgDelay >= 60 ? 'ground_delay' : 'general';
    reason = `Avg ${avgDelay}min delay, ${Math.round(delayedPct)}% delayed`;
  } else {
    return null;
  }
  if (severity === 'normal') return null;

  return {
    id: `avstack-${iata}`,
    iata,
    icao: meta.icao,
    name: meta.name,
    city: meta.city,
    country: meta.country,
    location: { latitude: meta.lat, longitude: meta.lon },
    region: REGION_MAP[meta.region] || 'AIRPORT_REGION_UNSPECIFIED',
    delayType: DELAY_TYPE_MAP[delayType] || 'FLIGHT_DELAY_TYPE_GENERAL',
    severity: SEVERITY_MAP[severity] || 'FLIGHT_DELAY_SEVERITY_NORMAL',
    avgDelayMinutes: avgDelay,
    delayedFlightsPct: Math.round(delayedPct),
    cancelledFlights: cancelled,
    totalFlights: total,
    reason,
    source: 'FLIGHT_DELAY_SOURCE_AVIATIONSTACK',
    updatedAt: Date.now(),
  };
}

async function seedAviationDelays() {
  if (!AVIATIONSTACK_API_KEY) {
    console.log('[Aviation] No AVIATIONSTACK_API key — skipping seed');
    return;
  }

  const t0 = Date.now();
  const alerts = [];
  let succeeded = 0, failed = 0;
  const deadline = Date.now() + 50_000;

  for (let i = 0; i < AVIATIONSTACK_AIRPORTS.length; i += AVIATION_BATCH_CONCURRENCY) {
    if (Date.now() >= deadline) {
      console.warn(`[Aviation] Deadline hit after ${succeeded + failed}/${AVIATIONSTACK_AIRPORTS.length} airports`);
      break;
    }
    const chunk = AVIATIONSTACK_AIRPORTS.slice(i, i + AVIATION_BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((iata) => fetchAviationStackSingle(AVIATIONSTACK_API_KEY, iata))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.ok) { succeeded++; if (r.value.alert) alerts.push(r.value.alert); }
        else failed++;
      } else {
        failed++;
      }
    }
  }

  const healthy = AVIATIONSTACK_AIRPORTS.length < 5 || failed <= succeeded;
  if (!healthy) {
    console.warn(`[Aviation] Systemic failure: ${failed}/${failed + succeeded} airports failed — preserving existing cache`);
    return;
  }

  const ok = await upstashSet(AVIATION_REDIS_KEY, { alerts }, AVIATION_SEED_TTL);
  await upstashSet('seed-meta:aviation:intl', { fetchedAt: Date.now(), recordCount: alerts.length }, 604800);
  console.log(`[Aviation] Seeded ${alerts.length} alerts (${succeeded} ok, ${failed} failed, redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function startAviationSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[Aviation] Disabled (no Upstash Redis)');
    return;
  }
  if (!AVIATIONSTACK_API_KEY) {
    console.log('[Aviation] Disabled (no AVIATIONSTACK_API key)');
    return;
  }
  console.log(`[Aviation] Seed loop starting (interval ${AVIATION_SEED_INTERVAL_MS / 1000 / 60 / 60}h, airports: ${AVIATIONSTACK_AIRPORTS.length})`);
  seedAviationDelays().catch((e) => console.warn('[Aviation] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedAviationDelays().catch((e) => console.warn('[Aviation] Seed error:', e?.message || e));
  }, AVIATION_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// NOTAM Closures Seed — Railway fetches ICAO NOTAMs → writes to Redis
// so Vercel handler and map layer serve from cache (ICAO API times out from edge)
// ─────────────────────────────────────────────────────────────
const NOTAM_SEED_INTERVAL_MS = 30 * 60 * 1000; // 30min
const NOTAM_SEED_TTL = 3600; // 1h — survives 1 missed cycle
const NOTAM_REDIS_KEY = 'aviation:notam:closures:v2';
const NOTAM_CLOSURE_QCODES = new Set(['FA', 'AH', 'AL', 'AW', 'AC', 'AM']);
const NOTAM_MONITORED_ICAO = [
  // MENA
  'OEJN', 'OERK', 'OEMA', 'OEDF', 'OMDB', 'OMAA', 'OMSJ',
  'OTHH', 'OBBI', 'OOMS', 'OKBK', 'OLBA', 'OJAI', 'OSDI',
  'ORBI', 'OIIE', 'OISS', 'OIMM', 'OIKB', 'HECA', 'GMMN',
  'DTTA', 'DAAG', 'HLLT',
  // Europe
  'EGLL', 'LFPG', 'EDDF', 'EHAM', 'LEMD', 'LIRF', 'LTFM',
  'LSZH', 'LOWW', 'EKCH', 'ENGM', 'ESSA', 'EFHK', 'EPWA',
  // Americas
  'KJFK', 'KLAX', 'KORD', 'KATL', 'KDFW', 'KDEN', 'KSFO',
  'CYYZ', 'MMMX', 'SBGR', 'SCEL', 'SKBO',
  // APAC
  'RJTT', 'RKSI', 'VHHH', 'WSSS', 'VTBS', 'VIDP', 'YSSY',
  'ZBAA', 'ZPPP', 'WMKK',
  // Africa
  'FAOR', 'DNMM', 'HKJK', 'GABS',
];

function fetchIcaoNotams() {
  return new Promise((resolve) => {
    if (!ICAO_API_KEY) return resolve([]);
    const locations = NOTAM_MONITORED_ICAO.join(',');
    const apiUrl = `https://dataservices.icao.int/api/notams-realtime-list?api_key=${ICAO_API_KEY}&format=json&locations=${locations}`;
    const req = https.get(apiUrl, {
      headers: { 'User-Agent': CHROME_UA },
      timeout: 30000,
    }, (resp) => {
      if (resp.statusCode !== 200) {
        console.warn(`[NOTAM-Seed] ICAO HTTP ${resp.statusCode}`);
        resp.resume();
        return resolve([]);
      }
      const ct = resp.headers['content-type'] || '';
      if (ct.includes('text/html')) {
        console.warn('[NOTAM-Seed] ICAO returned HTML (challenge page)');
        resp.resume();
        return resolve([]);
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(Array.isArray(data) ? data : []);
        } catch {
          console.warn('[NOTAM-Seed] Invalid JSON from ICAO');
          resolve([]);
        }
      });
    });
    req.on('error', (err) => { console.warn(`[NOTAM-Seed] Fetch error: ${err.message}`); resolve([]); });
    req.on('timeout', () => { req.destroy(); console.warn('[NOTAM-Seed] Timeout (30s)'); resolve([]); });
  });
}

async function seedNotamClosures() {
  if (!ICAO_API_KEY) {
    console.log('[NOTAM-Seed] No ICAO_API_KEY — skipping');
    return;
  }

  const t0 = Date.now();
  const notams = await fetchIcaoNotams();
  if (notams.length === 0) {
    await upstashExpire(NOTAM_REDIS_KEY, NOTAM_SEED_TTL);
    await upstashSet('seed-meta:aviation:notam', { fetchedAt: Date.now(), recordCount: 0 }, 604800);
    console.log('[NOTAM-Seed] No NOTAMs received — refreshed data key TTL, preserving existing cache');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const closedSet = new Set();
  const reasons = {};

  for (const n of notams) {
    const icao = n.itema || n.location || '';
    if (!icao || !NOTAM_MONITORED_ICAO.includes(icao)) continue;
    if (n.endvalidity && n.endvalidity < now) continue;

    const code23 = (n.code23 || '').toUpperCase();
    const code45 = (n.code45 || '').toUpperCase();
    const text = (n.iteme || '').toUpperCase();
    const isClosureCode = NOTAM_CLOSURE_QCODES.has(code23) &&
      (code45 === 'LC' || code45 === 'AS' || code45 === 'AU' || code45 === 'XX' || code45 === 'AW');
    const isClosureText = /\b(AD CLSD|AIRPORT CLOSED|AIRSPACE CLOSED|AD NOT AVBL|CLSD TO ALL)\b/.test(text);

    if (isClosureCode || isClosureText) {
      closedSet.add(icao);
      reasons[icao] = n.iteme || 'Airport closure (NOTAM)';
    }
  }

  const closedIcaos = [...closedSet];
  const payload = { closedIcaos, reasons };
  const ok = await upstashSet(NOTAM_REDIS_KEY, payload, NOTAM_SEED_TTL);
  await upstashSet('seed-meta:aviation:notam', { fetchedAt: Date.now(), recordCount: closedIcaos.length }, 604800);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[NOTAM-Seed] ${notams.length} raw NOTAMs, ${closedIcaos.length} closures (redis: ${ok ? 'OK' : 'FAIL'}) in ${elapsed}s`);
}

function startNotamSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[NOTAM-Seed] Disabled (no Upstash Redis)');
    return;
  }
  if (!ICAO_API_KEY) {
    console.log('[NOTAM-Seed] Disabled (no ICAO_API_KEY)');
    return;
  }
  console.log(`[NOTAM-Seed] Seed loop starting (interval ${NOTAM_SEED_INTERVAL_MS / 1000 / 60}min, airports: ${NOTAM_MONITORED_ICAO.length})`);
  seedNotamClosures().catch((e) => console.warn('[NOTAM-Seed] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedNotamClosures().catch((e) => console.warn('[NOTAM-Seed] Seed error:', e?.message || e));
  }, NOTAM_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Cyber Threat Intelligence Seed — Railway fetches IOC feeds → writes to Redis
// so Vercel handler (list-cyber-threats) serves from cache instead of live fetches
// ─────────────────────────────────────────────────────────────
const URLHAUS_AUTH_KEY = process.env.URLHAUS_AUTH_KEY || '';
const OTX_API_KEY = process.env.OTX_API_KEY || '';
const ABUSEIPDB_API_KEY = process.env.ABUSEIPDB_API_KEY || '';
const CYBER_SEED_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h — matches IOC feed update cadence
const CYBER_SEED_TTL = 10800; // 3h — survives 1 missed cycle
const CYBER_RPC_KEY = 'cyber:threats:v2'; // must match handler REDIS_CACHE_KEY in list-cyber-threats.ts
const CYBER_BOOTSTRAP_KEY = 'cyber:threats-bootstrap:v2';
const CYBER_MAX_CACHED = 2000;
const CYBER_GEO_MAX = 200;
const CYBER_GEO_CONCURRENCY = 12;
const CYBER_GEO_TIMEOUT_MS = 20_000;
const CYBER_SOURCE_TIMEOUT_MS = 15_000; // longer than Vercel edge budget — OK on Railway

const CYBER_COUNTRY_CENTROIDS = {
  US:[39.8,-98.6],CA:[56.1,-106.3],MX:[23.6,-102.6],BR:[-14.2,-51.9],AR:[-38.4,-63.6],
  GB:[55.4,-3.4],DE:[51.2,10.5],FR:[46.2,2.2],IT:[41.9,12.6],ES:[40.5,-3.7],
  NL:[52.1,5.3],BE:[50.5,4.5],SE:[60.1,18.6],NO:[60.5,8.5],FI:[61.9,25.7],
  DK:[56.3,9.5],PL:[51.9,19.1],CZ:[49.8,15.5],AT:[47.5,14.6],CH:[46.8,8.2],
  PT:[39.4,-8.2],IE:[53.1,-8.2],RO:[45.9,25.0],HU:[47.2,19.5],BG:[42.7,25.5],
  HR:[45.1,15.2],SK:[48.7,19.7],UA:[48.4,31.2],RU:[61.5,105.3],BY:[53.7,28.0],
  TR:[39.0,35.2],GR:[39.1,21.8],RS:[44.0,21.0],CN:[35.9,104.2],JP:[36.2,138.3],
  KR:[35.9,127.8],IN:[20.6,79.0],PK:[30.4,69.3],BD:[23.7,90.4],ID:[-0.8,113.9],
  TH:[15.9,101.0],VN:[14.1,108.3],PH:[12.9,121.8],MY:[4.2,101.9],SG:[1.4,103.8],
  TW:[23.7,121.0],HK:[22.4,114.1],AU:[-25.3,133.8],NZ:[-40.9,174.9],
  ZA:[-30.6,22.9],NG:[9.1,8.7],EG:[26.8,30.8],KE:[-0.02,37.9],ET:[9.1,40.5],
  MA:[31.8,-7.1],DZ:[28.0,1.7],TN:[33.9,9.5],GH:[7.9,-1.0],
  SA:[23.9,45.1],AE:[23.4,53.8],IL:[31.0,34.9],IR:[32.4,53.7],IQ:[33.2,43.7],
  KW:[29.3,47.5],QA:[25.4,51.2],BH:[26.0,50.6],JO:[30.6,36.2],LB:[33.9,35.9],
  CL:[-35.7,-71.5],CO:[4.6,-74.3],PE:[-9.2,-75.0],VE:[6.4,-66.6],
  KZ:[48.0,68.0],UZ:[41.4,64.6],GE:[42.3,43.4],AZ:[40.1,47.6],AM:[40.1,45.0],
  LT:[55.2,23.9],LV:[56.9,24.1],EE:[58.6,25.0],
  HN:[15.2,-86.2],GT:[15.8,-90.2],PA:[8.5,-80.8],CR:[9.7,-84.0],
  SN:[14.5,-14.5],CM:[7.4,12.4],CI:[7.5,-5.5],TZ:[-6.4,34.9],UG:[1.4,32.3],
};

const CYBER_THREAT_TYPE_MAP = { c2_server:'CYBER_THREAT_TYPE_C2_SERVER', malware_host:'CYBER_THREAT_TYPE_MALWARE_HOST', phishing:'CYBER_THREAT_TYPE_PHISHING', malicious_url:'CYBER_THREAT_TYPE_MALICIOUS_URL' };
const CYBER_SOURCE_MAP = { feodo:'CYBER_THREAT_SOURCE_FEODO', urlhaus:'CYBER_THREAT_SOURCE_URLHAUS', c2intel:'CYBER_THREAT_SOURCE_C2INTEL', otx:'CYBER_THREAT_SOURCE_OTX', abuseipdb:'CYBER_THREAT_SOURCE_ABUSEIPDB' };
const CYBER_INDICATOR_MAP = { ip:'CYBER_THREAT_INDICATOR_TYPE_IP', domain:'CYBER_THREAT_INDICATOR_TYPE_DOMAIN', url:'CYBER_THREAT_INDICATOR_TYPE_URL' };
const CYBER_SEVERITY_MAP = { low:'CRITICALITY_LEVEL_LOW', medium:'CRITICALITY_LEVEL_MEDIUM', high:'CRITICALITY_LEVEL_HIGH', critical:'CRITICALITY_LEVEL_CRITICAL' };
const CYBER_SEVERITY_RANK = { CRITICALITY_LEVEL_CRITICAL:4, CRITICALITY_LEVEL_HIGH:3, CRITICALITY_LEVEL_MEDIUM:2, CRITICALITY_LEVEL_LOW:1, CRITICALITY_LEVEL_UNSPECIFIED:0 };

function cyberClean(v, max) { if (typeof v !== 'string') return ''; return v.trim().replace(/\s+/g, ' ').slice(0, max || 120); }
function cyberToNum(v) { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; }
function cyberValidCoords(lat, lon) { return lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180; }
function cyberIsIPv4(v) { if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return false; return v.split('.').map(Number).every((n) => Number.isInteger(n) && n >= 0 && n <= 255); }
function cyberIsIPv6(v) { return /^[0-9a-f:]+$/i.test(v) && v.includes(':'); }
function cyberIsIp(v) { return cyberIsIPv4(v) || cyberIsIPv6(v); }
function cyberNormCountry(v) { const r = cyberClean(String(v ?? ''), 64); if (!r) return ''; if (/^[a-z]{2}$/i.test(r)) return r.toUpperCase(); return r; }
function cyberToMs(v) {
  if (!v) return 0;
  const raw = cyberClean(String(v), 80); if (!raw) return 0;
  const d1 = new Date(raw); if (!isNaN(d1.getTime())) return d1.getTime();
  const d2 = new Date(raw.replace(' UTC', 'Z').replace(' GMT', 'Z').replace(' ', 'T'));
  return isNaN(d2.getTime()) ? 0 : d2.getTime();
}
function cyberNormTags(input, max) {
  const tags = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[;,|]/g) : [];
  const out = []; const seen = new Set();
  for (const t of tags) { const c = cyberClean(String(t ?? ''), 40).toLowerCase(); if (!c || seen.has(c)) continue; seen.add(c); out.push(c); if (out.length >= (max || 8)) break; }
  return out;
}
function cyberDjb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff; return h; }
function cyberCentroid(cc, seed) {
  const c = CYBER_COUNTRY_CENTROIDS[cc ? cc.toUpperCase() : '']; if (!c) return null;
  const k = seed || cc;
  return { lat: c[0] + (((cyberDjb2(k) & 0xffff) / 0xffff) - 0.5) * 2, lon: c[1] + (((cyberDjb2(k + ':lon') & 0xffff) / 0xffff) - 0.5) * 2 };
}
function cyberSanitize(t) {
  const ind = cyberClean(t.indicator, 255); if (!ind) return null;
  if ((t.indicatorType || 'ip') === 'ip' && !cyberIsIp(ind)) return null;
  return { id: cyberClean(t.id, 255) || `${t.source||'feodo'}:${t.indicatorType||'ip'}:${ind}`, type: t.type||'malicious_url', source: t.source||'feodo', indicator: ind, indicatorType: t.indicatorType||'ip', lat: t.lat??null, lon: t.lon??null, country: t.country||'', severity: t.severity||'medium', malwareFamily: cyberClean(t.malwareFamily, 80), tags: t.tags||[], firstSeen: t.firstSeen||0, lastSeen: t.lastSeen||0 };
}
function cyberDedupe(threats) {
  const map = new Map();
  for (const t of threats) {
    const key = `${t.source}:${t.indicatorType}:${t.indicator}`;
    const ex = map.get(key);
    if (!ex) { map.set(key, t); continue; }
    if ((t.lastSeen || t.firstSeen) >= (ex.lastSeen || ex.firstSeen)) map.set(key, { ...ex, ...t, tags: cyberNormTags([...ex.tags, ...t.tags]) });
  }
  return Array.from(map.values());
}
function cyberToProto(t) {
  return { id: t.id, type: CYBER_THREAT_TYPE_MAP[t.type]||'CYBER_THREAT_TYPE_UNSPECIFIED', source: CYBER_SOURCE_MAP[t.source]||'CYBER_THREAT_SOURCE_UNSPECIFIED', indicator: t.indicator, indicatorType: CYBER_INDICATOR_MAP[t.indicatorType]||'CYBER_THREAT_INDICATOR_TYPE_UNSPECIFIED', location: cyberValidCoords(t.lat, t.lon) ? { latitude: t.lat, longitude: t.lon } : undefined, country: t.country, severity: CYBER_SEVERITY_MAP[t.severity]||'CRITICALITY_LEVEL_UNSPECIFIED', malwareFamily: t.malwareFamily, tags: t.tags, firstSeenAt: t.firstSeen, lastSeenAt: t.lastSeen };
}

function cyberHttpGetJson(url, reqHeaders, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': CHROME_UA, ...reqHeaders }, timeout: timeoutMs || 10000 }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) { resp.resume(); return resolve(null); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function cyberHttpGetText(url, reqHeaders, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': CHROME_UA, ...reqHeaders }, timeout: timeoutMs || 10000 }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) { resp.resume(); return resolve(null); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const CYBER_GEO_CACHE_MAX = 2048;
const cyberGeoCache = new Map();
function cyberGeoCacheSet(ip, geo) {
  if (cyberGeoCache.size >= CYBER_GEO_CACHE_MAX) {
    cyberGeoCache.delete(cyberGeoCache.keys().next().value);
  }
  cyberGeoCache.set(ip, geo);
}
async function cyberGeoLookup(ip) {
  if (cyberGeoCache.has(ip)) return cyberGeoCache.get(ip);
  const d1 = await cyberHttpGetJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {}, 3000);
  if (d1?.loc) {
    const [latS, lonS] = d1.loc.split(',');
    const lat = parseFloat(latS), lon = parseFloat(lonS);
    if (cyberValidCoords(lat, lon)) { const r = { lat, lon, country: String(d1.country||'').slice(0,2).toUpperCase() }; cyberGeoCacheSet(ip, r); return r; }
  }
  const d2 = await cyberHttpGetJson(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`, {}, 3000);
  if (d2) {
    const lat = parseFloat(d2.latitude), lon = parseFloat(d2.longitude);
    if (cyberValidCoords(lat, lon)) { const r = { lat, lon, country: String(d2.countryCode||d2.countryName||'').slice(0,2).toUpperCase() }; cyberGeoCacheSet(ip, r); return r; }
  }
  return null;
}
async function cyberHydrateGeo(threats) {
  const needsGeo = []; const seen = new Set();
  for (const t of threats) {
    if (cyberValidCoords(t.lat, t.lon) || t.indicatorType !== 'ip') continue;
    const ip = t.indicator.toLowerCase();
    if (!cyberIsIp(ip) || seen.has(ip)) continue;
    seen.add(ip); needsGeo.push(ip);
  }
  if (needsGeo.length === 0) return threats;
  const queue = [...needsGeo.slice(0, CYBER_GEO_MAX)];
  const resolved = new Map();
  let timedOut = false;
  // timedOut flag stops workers from dequeuing new IPs; in-flight requests may still
  // complete up to ~3s after the flag fires (per-request timeout). Acceptable overshoot.
  const timeoutId = setTimeout(() => { timedOut = true; }, CYBER_GEO_TIMEOUT_MS);
  const workers = Array.from({ length: Math.min(CYBER_GEO_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0 && !timedOut) {
      const ip = queue.shift(); if (!ip) break;
      const geo = await cyberGeoLookup(ip);
      if (geo) resolved.set(ip, geo);
    }
  });
  try { await Promise.all(workers); } catch { /* ignore */ }
  clearTimeout(timeoutId);
  return threats.map((t) => {
    if (cyberValidCoords(t.lat, t.lon)) return t;
    if (t.indicatorType !== 'ip') return t;
    const geo = resolved.get(t.indicator.toLowerCase());
    if (geo) return { ...t, lat: geo.lat, lon: geo.lon, country: t.country || geo.country };
    const cen = cyberCentroid(t.country, t.indicator);
    return cen ? { ...t, lat: cen.lat, lon: cen.lon } : t;
  });
}

async function cyberFetchFeodo(limit, cutoffMs) {
  try {
    const payload = await cyberHttpGetJson('https://feodotracker.abuse.ch/downloads/ipblocklist.json', { Accept: 'application/json' }, CYBER_SOURCE_TIMEOUT_MS);
    if (!payload) return [];
    const records = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
    const out = [];
    for (const r of records) {
      const ip = cyberClean(r?.ip_address || r?.dst_ip || r?.ip || r?.ioc || r?.host, 80).toLowerCase();
      if (!cyberIsIp(ip)) continue;
      const status = cyberClean(r?.status || r?.c2_status || '', 30).toLowerCase();
      if (status && status !== 'online' && status !== 'offline') continue;
      const firstSeen = cyberToMs(r?.first_seen || r?.first_seen_utc || r?.dateadded);
      const lastSeen = cyberToMs(r?.last_online || r?.last_seen || r?.last_seen_utc || r?.first_seen || r?.first_seen_utc);
      if ((lastSeen || firstSeen) && (lastSeen || firstSeen) < cutoffMs) continue;
      const malwareFamily = cyberClean(r?.malware || r?.malware_family || r?.family, 80);
      const sev = status === 'online' ? (/emotet|qakbot|trickbot|dridex|ransom/i.test(malwareFamily) ? 'critical' : 'high') : 'medium';
      const t = cyberSanitize({ id: `feodo:${ip}`, type: 'c2_server', source: 'feodo', indicator: ip, indicatorType: 'ip', lat: cyberToNum(r?.latitude ?? r?.lat), lon: cyberToNum(r?.longitude ?? r?.lon), country: cyberNormCountry(r?.country || r?.country_code), severity: sev, malwareFamily, tags: cyberNormTags(['botnet', 'c2', ...(r?.tags||[])]), firstSeen, lastSeen });
      if (t) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
  } catch (e) { console.warn('[Cyber] Feodo fetch failed:', e?.message || e); return []; }
}
async function cyberFetchUrlhaus(limit, cutoffMs) {
  if (!URLHAUS_AUTH_KEY) return [];
  try {
    const payload = await cyberHttpGetJson(`https://urlhaus-api.abuse.ch/v1/urls/recent/limit/${limit}/`, { Accept: 'application/json', 'Auth-Key': URLHAUS_AUTH_KEY }, CYBER_SOURCE_TIMEOUT_MS);
    if (!payload) return [];
    const rows = Array.isArray(payload?.urls) ? payload.urls : (Array.isArray(payload?.data) ? payload.data : []);
    const out = [];
    for (const r of rows) {
      const rawUrl = cyberClean(r?.url || r?.ioc || '', 1024);
      const status = cyberClean(r?.url_status || r?.status || '', 30).toLowerCase();
      if (status && status !== 'online') continue;
      const tags = cyberNormTags(r?.tags);
      let hostname = ''; try { hostname = new URL(rawUrl).hostname.toLowerCase(); } catch {}
      const recordIp = cyberClean(r?.host || r?.ip_address || r?.ip, 80).toLowerCase();
      const ipCandidate = cyberIsIp(recordIp) ? recordIp : (cyberIsIp(hostname) ? hostname : '');
      const indType = ipCandidate ? 'ip' : (hostname ? 'domain' : 'url');
      const indicator = ipCandidate || hostname || rawUrl; if (!indicator) continue;
      const firstSeen = cyberToMs(r?.dateadded || r?.firstseen || r?.first_seen);
      const lastSeen = cyberToMs(r?.last_online || r?.last_seen || r?.dateadded);
      if ((lastSeen || firstSeen) && (lastSeen || firstSeen) < cutoffMs) continue;
      const threat = cyberClean(r?.threat || r?.threat_type || '', 40).toLowerCase();
      const allTags = tags.join(' ');
      const type = (threat.includes('phish') || allTags.includes('phish')) ? 'phishing' : (threat.includes('malware') || threat.includes('payload') || allTags.includes('malware')) ? 'malware_host' : 'malicious_url';
      const sev = type === 'phishing' ? 'medium' : (tags.includes('ransomware') || tags.includes('botnet')) ? 'critical' : 'high';
      const t = cyberSanitize({ id: `urlhaus:${indType}:${indicator}`, type, source: 'urlhaus', indicator, indicatorType: indType, lat: cyberToNum(r?.latitude ?? r?.lat), lon: cyberToNum(r?.longitude ?? r?.lon), country: cyberNormCountry(r?.country || r?.country_code), severity: sev, malwareFamily: cyberClean(r?.threat, 80), tags, firstSeen, lastSeen });
      if (t) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
  } catch (e) { console.warn('[Cyber] URLhaus fetch failed:', e?.message || e); return []; }
}
async function cyberFetchC2Intel(limit) {
  try {
    const text = await cyberHttpGetText('https://raw.githubusercontent.com/drb-ra/C2IntelFeeds/master/feeds/IPC2s-30day.csv', { Accept: 'text/plain' }, CYBER_SOURCE_TIMEOUT_MS);
    if (!text) return [];
    const out = [];
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const ci = line.indexOf(','); if (ci < 0) continue;
      const ip = cyberClean(line.slice(0, ci), 80).toLowerCase(); if (!cyberIsIp(ip)) continue;
      const desc = cyberClean(line.slice(ci + 1), 200);
      const malwareFamily = desc.replace(/^Possible\s+/i, '').replace(/\s+C2\s+IP$/i, '').trim() || 'Unknown';
      const tags = ['c2']; const descLow = desc.toLowerCase();
      if (descLow.includes('cobaltstrike') || descLow.includes('cobalt strike')) tags.push('cobaltstrike');
      if (descLow.includes('metasploit')) tags.push('metasploit');
      if (descLow.includes('sliver')) tags.push('sliver');
      if (descLow.includes('brute ratel') || descLow.includes('bruteratel')) tags.push('bruteratel');
      const t = cyberSanitize({ id: `c2intel:${ip}`, type: 'c2_server', source: 'c2intel', indicator: ip, indicatorType: 'ip', lat: null, lon: null, country: '', severity: /cobaltstrike|cobalt.strike|brute.?ratel/i.test(desc) ? 'high' : 'medium', malwareFamily, tags: cyberNormTags(tags), firstSeen: 0, lastSeen: 0 });
      if (t) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
  } catch (e) { console.warn('[Cyber] C2Intel fetch failed:', e?.message || e); return []; }
}
async function cyberFetchOtx(limit, days) {
  if (!OTX_API_KEY) return [];
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const payload = await cyberHttpGetJson(`https://otx.alienvault.com/api/v1/indicators/export?type=IPv4&modified_since=${encodeURIComponent(since)}`, { Accept: 'application/json', 'X-OTX-API-KEY': OTX_API_KEY }, CYBER_SOURCE_TIMEOUT_MS);
    if (!payload) return [];
    const results = Array.isArray(payload?.results) ? payload.results : (Array.isArray(payload) ? payload : []);
    const out = [];
    for (const r of results) {
      const ip = cyberClean(r?.indicator || r?.ip || '', 80).toLowerCase(); if (!cyberIsIp(ip)) continue;
      const tags = cyberNormTags(r?.tags || []);
      const t = cyberSanitize({ id: `otx:${ip}`, type: tags.some((tt) => /c2|botnet/.test(tt)) ? 'c2_server' : 'malware_host', source: 'otx', indicator: ip, indicatorType: 'ip', lat: null, lon: null, country: '', severity: tags.some((tt) => /ransomware|apt|c2|botnet/.test(tt)) ? 'high' : 'medium', malwareFamily: cyberClean(r?.title || r?.description || '', 200), tags, firstSeen: cyberToMs(r?.created), lastSeen: cyberToMs(r?.modified || r?.created) });
      if (t) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
  } catch (e) { console.warn('[Cyber] OTX fetch failed:', e?.message || e); return []; }
}
async function cyberFetchAbuseIpDb(limit) {
  if (!ABUSEIPDB_API_KEY) return [];
  try {
    const payload = await cyberHttpGetJson(`https://api.abuseipdb.com/api/v2/blacklist?confidenceMinimum=90&limit=${Math.min(limit, 500)}`, { Accept: 'application/json', Key: ABUSEIPDB_API_KEY }, CYBER_SOURCE_TIMEOUT_MS);
    if (!payload) return [];
    const records = Array.isArray(payload?.data) ? payload.data : [];
    const out = [];
    for (const r of records) {
      const ip = cyberClean(r?.ipAddress || r?.ip || '', 80).toLowerCase(); if (!cyberIsIp(ip)) continue;
      const score = cyberToNum(r?.abuseConfidenceScore) ?? 0;
      const t = cyberSanitize({ id: `abuseipdb:${ip}`, type: 'malware_host', source: 'abuseipdb', indicator: ip, indicatorType: 'ip', lat: cyberToNum(r?.latitude ?? r?.lat), lon: cyberToNum(r?.longitude ?? r?.lon), country: cyberNormCountry(r?.countryCode || r?.country), severity: score >= 95 ? 'critical' : (score >= 80 ? 'high' : 'medium'), malwareFamily: '', tags: cyberNormTags([`score:${score}`]), firstSeen: 0, lastSeen: cyberToMs(r?.lastReportedAt) });
      if (t) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
  } catch (e) { console.warn('[Cyber] AbuseIPDB fetch failed:', e?.message || e); return []; }
}

async function seedCyberThreats() {
  const t0 = Date.now();
  const days = 14;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const MAX_LIMIT = 1000;

  const [feodo, urlhaus, c2intel, otx, abuseipdb] = await Promise.all([
    cyberFetchFeodo(MAX_LIMIT, cutoffMs),
    cyberFetchUrlhaus(MAX_LIMIT, cutoffMs),
    cyberFetchC2Intel(MAX_LIMIT),
    cyberFetchOtx(MAX_LIMIT, days),
    cyberFetchAbuseIpDb(MAX_LIMIT),
  ]);

  if (feodo.length + urlhaus.length + c2intel.length + otx.length + abuseipdb.length === 0) {
    console.warn('[Cyber] All sources returned 0 threats — skipping Redis write');
    return 0;
  }

  const combined = cyberDedupe([...feodo, ...urlhaus, ...c2intel, ...otx, ...abuseipdb]);
  const hydrated = await cyberHydrateGeo(combined);
  const geoCount = hydrated.filter((t) => cyberValidCoords(t.lat, t.lon)).length;
  console.log(`[Cyber] Geo resolved: ${geoCount}/${hydrated.length}`);

  // Sort geo-resolved first, then by severity/recency
  hydrated.sort((a, b) => {
    const aGeo = cyberValidCoords(a.lat, a.lon) ? 0 : 1;
    const bGeo = cyberValidCoords(b.lat, b.lon) ? 0 : 1;
    if (aGeo !== bGeo) return aGeo - bGeo;
    const bySev = (CYBER_SEVERITY_RANK[CYBER_SEVERITY_MAP[b.severity]||'']||0) - (CYBER_SEVERITY_RANK[CYBER_SEVERITY_MAP[a.severity]||'']||0);
    return bySev !== 0 ? bySev : (b.lastSeen || b.firstSeen) - (a.lastSeen || a.firstSeen);
  });

  const threats = hydrated.slice(0, CYBER_MAX_CACHED).map(cyberToProto);
  if (threats.length === 0) {
    console.warn('[Cyber] No threats from any source — skipping Redis write');
    return 0;
  }

  const payload = { threats };
  const ok1 = await upstashSet(CYBER_RPC_KEY, payload, CYBER_SEED_TTL);
  const ok2 = await upstashSet(CYBER_BOOTSTRAP_KEY, payload, CYBER_SEED_TTL);
  const ok3 = await upstashSet('seed-meta:cyber:threats', { fetchedAt: Date.now(), recordCount: threats.length }, 604800);
  console.log(`[Cyber] Seeded ${threats.length} threats (feodo:${feodo.length} urlhaus:${urlhaus.length} c2intel:${c2intel.length} otx:${otx.length} abuseipdb:${abuseipdb.length} redis:${ok1 && ok2 && ok3 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return threats.length;
}

async function startCyberThreatsSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[Cyber] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[Cyber] Seed loop starting (interval ${CYBER_SEED_INTERVAL_MS / 1000 / 60 / 60}h, urlhaus:${URLHAUS_AUTH_KEY ? 'yes' : 'no'} otx:${OTX_API_KEY ? 'yes' : 'no'} abuseipdb:${ABUSEIPDB_API_KEY ? 'yes' : 'no'})`);
  seedCyberThreats().catch((e) => console.warn('[Cyber] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedCyberThreats().catch((e) => console.warn('[Cyber] Seed error:', e?.message || e));
  }, CYBER_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Positive Events Seed — Railway fetches GDELT GEO API → writes to Redis
// so Vercel handler serves from cache (avoids 25s edge timeout on slow GDELT)
// ─────────────────────────────────────────────────────────────
const POSITIVE_EVENTS_INTERVAL_MS = 900_000; // 15 min
const POSITIVE_EVENTS_TTL = 2700; // 3× interval
const POSITIVE_EVENTS_RPC_KEY = 'positive-events:geo:v1';
const POSITIVE_EVENTS_BOOTSTRAP_KEY = 'positive-events:geo-bootstrap:v1';
const POSITIVE_EVENTS_MAX = 500;

const POSITIVE_QUERIES = [
  '(breakthrough OR discovery OR "renewable energy")',
  '(conservation OR "poverty decline" OR "humanitarian aid")',
  '("good news" OR volunteer OR donation OR charity)',
];

// Mirrors CATEGORY_KEYWORDS from src/services/positive-classifier.ts — keep in sync
const POSITIVE_CATEGORY_KEYWORDS = [
  ['clinical trial', 'science-health'], ['study finds', 'science-health'],
  ['researchers', 'science-health'], ['scientists', 'science-health'],
  ['breakthrough', 'science-health'], ['discovery', 'science-health'],
  ['cure', 'science-health'], ['vaccine', 'science-health'],
  ['treatment', 'science-health'], ['medical', 'science-health'],
  ['endangered species', 'nature-wildlife'], ['conservation', 'nature-wildlife'],
  ['wildlife', 'nature-wildlife'], ['species', 'nature-wildlife'],
  ['marine', 'nature-wildlife'], ['forest', 'nature-wildlife'],
  ['renewable', 'climate-wins'], ['solar', 'climate-wins'],
  ['wind energy', 'climate-wins'], ['electric vehicle', 'climate-wins'],
  ['emissions', 'climate-wins'], ['carbon', 'climate-wins'],
  ['clean energy', 'climate-wins'], ['climate', 'climate-wins'],
  ['robot', 'innovation-tech'], ['technology', 'innovation-tech'],
  ['startup', 'innovation-tech'], ['innovation', 'innovation-tech'],
  ['artificial intelligence', 'innovation-tech'],
  ['volunteer', 'humanity-kindness'], ['donated', 'humanity-kindness'],
  ['charity', 'humanity-kindness'], ['rescued', 'humanity-kindness'],
  ['hero', 'humanity-kindness'], ['kindness', 'humanity-kindness'],
  [' art ', 'culture-community'], ['music', 'culture-community'],
  ['festival', 'culture-community'], ['education', 'culture-community'],
];

function classifyPositiveName(name) {
  const lower = ` ${name.toLowerCase()} `;
  for (const [kw, cat] of POSITIVE_CATEGORY_KEYWORDS) {
    if (lower.includes(kw)) return cat;
  }
  return 'humanity-kindness';
}

function fetchGdeltGeoPositive(query) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({ query, maxrows: '500' });
    const req = https.get(`https://api.gdeltproject.org/api/v1/gkg_geojson?${params}`, {
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      timeout: 15000,
    }, (resp) => {
      if (resp.statusCode !== 200) { resp.resume(); return resolve([]); }
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          const features = Array.isArray(data?.features) ? data.features : [];
          const locationMap = new Map();
          for (const f of features) {
            const name = String(f.properties?.name || '').substring(0, 200);
            if (!name) continue;
            if (name.startsWith('ERROR:') || name.includes('unknown error')) continue;
            const coords = f.geometry?.coordinates;
            if (!Array.isArray(coords) || coords.length < 2) continue;
            const [lon, lat] = coords;
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
            const key = `${lat.toFixed(1)}:${lon.toFixed(1)}`;
            const existing = locationMap.get(key);
            if (existing) { existing.count++; }
            else { locationMap.set(key, { latitude: lat, longitude: lon, name, count: 1 }); }
          }
          const events = [];
          for (const [, loc] of locationMap) {
            if (loc.count < 3) continue;
            events.push({ latitude: loc.latitude, longitude: loc.longitude, name: loc.name, category: classifyPositiveName(loc.name), count: loc.count, timestamp: Date.now() });
          }
          resolve(events);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

let positiveEventsInFlight = false;

async function seedPositiveEvents() {
  if (positiveEventsInFlight) return;
  positiveEventsInFlight = true;
  const t0 = Date.now();
  try {
    const allEvents = [];
    const seenNames = new Set();
    let anyQuerySucceeded = false;

    for (let i = 0; i < POSITIVE_QUERIES.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 5_500)); // GDELT rate limit: 1 req per 5s
      try {
        const events = await fetchGdeltGeoPositive(POSITIVE_QUERIES[i]);
        anyQuerySucceeded = true;
        for (const e of events) {
          if (!seenNames.has(e.name)) {
            seenNames.add(e.name);
            allEvents.push(e);
          }
        }
      } catch { /* individual query failure is non-fatal */ }
    }

    if (!anyQuerySucceeded) {
      console.warn('[PositiveEvents] All queries failed — preserving last good data');
      return;
    }

    const capped = allEvents.slice(0, POSITIVE_EVENTS_MAX);
    const payload = { events: capped, fetchedAt: Date.now() };
    const ok1 = await upstashSet(POSITIVE_EVENTS_RPC_KEY, payload, POSITIVE_EVENTS_TTL);
    const ok2 = await upstashSet(POSITIVE_EVENTS_BOOTSTRAP_KEY, payload, POSITIVE_EVENTS_TTL);
    const ok3 = await upstashSet('seed-meta:positive-events:geo', { fetchedAt: Date.now(), recordCount: capped.length }, 604800);
    console.log(`[PositiveEvents] Seeded ${capped.length} events (redis: ${ok1 && ok2 && ok3 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[PositiveEvents] Seed error:', e?.message || e);
  } finally {
    positiveEventsInFlight = false;
  }
}

async function startPositiveEventsSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[PositiveEvents] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[PositiveEvents] Seed loop starting (interval ${POSITIVE_EVENTS_INTERVAL_MS / 1000 / 60}min)`);
  seedPositiveEvents().catch((e) => console.warn('[PositiveEvents] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedPositiveEvents().catch((e) => console.warn('[PositiveEvents] Seed error:', e?.message || e));
  }, POSITIVE_EVENTS_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// AI Classification Seed — batch-classify digest titles via LLM → Redis
// Clients get pre-classified items from digest, zero classify-event RPCs
// ─────────────────────────────────────────────────────────────
const CLASSIFY_SEED_INTERVAL_MS = 15 * 60 * 1000;
const CLASSIFY_CACHE_TTL = 86400;
const CLASSIFY_SKIP_TTL = 1800;
const CLASSIFY_BATCH_SIZE = 50;
const CLASSIFY_VARIANTS = ['full', 'tech', 'finance', 'happy', 'commodity'];
const CLASSIFY_VARIANT_STAGGER_MS = 3 * 60 * 1000;

const CLASSIFY_VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const CLASSIFY_VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
];

const CLASSIFY_SYSTEM_PROMPT = `You classify news headlines by threat level and category. Return ONLY a JSON array, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Input: numbered lines "index|Title"
Output: [{"i":0,"l":"high","c":"conflict"}, ...]

Focus: geopolitical events, conflicts, disasters, diplomacy. Classify by real-world severity and impact.`;

function classifyCacheKey(title) {
  const hash = crypto.createHash('sha256').update(title.toLowerCase()).digest('hex').slice(0, 16);
  return `classify:sebuf:v1:${hash}`;
}

function classifyFetchLlm(titles, apiKey, apiUrl, model) {
  return new Promise((resolve) => {
    const sanitized = titles.map((t) => t.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, 200).trim());
    const prompt = sanitized.map((t, i) => `${i}|${t}`).join('\n');
    const bodyStr = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      max_tokens: titles.length * 40,
    });

    const parsed = new URL(apiUrl);
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.request(parsed, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': CHROME_UA,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
      timeout: 30000,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return resolve(null);
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const json = JSON.parse(data);
          const raw = json?.choices?.[0]?.message?.content?.trim();
          if (!raw) return resolve(null);
          const match = raw.match(/\[[\s\S]*\]/);
          if (!match) return resolve(null);
          resolve(JSON.parse(match[0]));
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(bodyStr);
  });
}

let classifyInFlight = false;

async function seedClassifyForVariant(variant, apiKey, apiUrl, model) {
  const digestUrl = `https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=${variant}&lang=en`;
  let digest;
  try {
    const resp = await new Promise((resolve, reject) => {
      const req = https.get(digestUrl, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        timeout: 15000,
      }, resolve);
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    if (resp.statusCode !== 200) { resp.resume(); return { total: 0, classified: 0, skipped: 0 }; }
    const body = await new Promise((resolve) => {
      let d = '';
      resp.on('data', (c) => { d += c; });
      resp.on('end', () => resolve(d));
    });
    digest = JSON.parse(body);
  } catch {
    return { total: 0, classified: 0, skipped: 0 };
  }

  const allTitles = new Set();
  if (digest?.categories) {
    for (const bucket of Object.values(digest.categories)) {
      for (const item of bucket?.items ?? []) {
        if (item?.title) allTitles.add(item.title);
      }
    }
  }
  if (allTitles.size === 0) return { total: 0, classified: 0, skipped: 0 };

  const titleArr = [...allTitles];
  const cacheKeys = titleArr.map((t) => classifyCacheKey(t));

  const cached = await upstashMGet(cacheKeys);
  const misses = [];
  for (let i = 0; i < titleArr.length; i++) {
    if (!cached[i]) misses.push(titleArr[i]);
  }

  if (misses.length === 0) return { total: titleArr.length, classified: 0, skipped: 0 };

  let classified = 0;
  let skipped = 0;

  for (let b = 0; b < misses.length; b += CLASSIFY_BATCH_SIZE) {
    const chunk = misses.slice(b, b + CLASSIFY_BATCH_SIZE);
    const llmResult = await classifyFetchLlm(chunk, apiKey, apiUrl, model);

    if (!Array.isArray(llmResult)) {
      for (const title of chunk) {
        await upstashSet(classifyCacheKey(title), { level: '_skip', timestamp: Date.now() }, CLASSIFY_SKIP_TTL);
        skipped++;
      }
      continue;
    }

    const classifiedSet = new Set();
    for (const entry of llmResult) {
      const idx = entry?.i;
      if (typeof idx !== 'number' || idx < 0 || idx >= chunk.length) continue;
      if (classifiedSet.has(idx)) continue;
      const level = CLASSIFY_VALID_LEVELS.includes(entry?.l) ? entry.l : null;
      const category = CLASSIFY_VALID_CATEGORIES.includes(entry?.c) ? entry.c : null;
      if (!level || !category) continue;
      classifiedSet.add(idx);
      await upstashSet(classifyCacheKey(chunk[idx]), { level, category, timestamp: Date.now() }, CLASSIFY_CACHE_TTL);
      classified++;
    }

    for (let i = 0; i < chunk.length; i++) {
      if (!classifiedSet.has(i)) {
        await upstashSet(classifyCacheKey(chunk[i]), { level: '_skip', timestamp: Date.now() }, CLASSIFY_SKIP_TTL);
        skipped++;
      }
    }
  }

  return { total: titleArr.length, classified, skipped };
}

async function seedClassify() {
  if (classifyInFlight) return;
  classifyInFlight = true;
  const t0 = Date.now();
  try {
    const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
    const apiUrl = process.env.LLM_API_URL || 'https://api.groq.com/openai/v1/chat/completions';
    const model = process.env.LLM_MODEL || 'llama-3.1-8b-instant';
    if (!apiKey) {
      console.log('[Classify] Skipped — no LLM_API_KEY or GROQ_API_KEY');
      return;
    }
    const isProd = process.env.RAILWAY_ENVIRONMENT === 'production';
    if (isProd && !apiUrl.startsWith('https://') && !apiUrl.startsWith('http://localhost')) {
      console.warn('[Classify] LLM_API_URL must be HTTPS in production — skipping');
      return;
    }

    let totalClassified = 0;
    let totalSkipped = 0;
    for (let v = 0; v < CLASSIFY_VARIANTS.length; v++) {
      if (v > 0) await new Promise((r) => setTimeout(r, CLASSIFY_VARIANT_STAGGER_MS));
      try {
        const stats = await seedClassifyForVariant(CLASSIFY_VARIANTS[v], apiKey, apiUrl, model);
        totalClassified += stats.classified;
        totalSkipped += stats.skipped;
        console.log(`[Classify] ${CLASSIFY_VARIANTS[v]}: ${stats.total} titles, ${stats.classified} classified, ${stats.skipped} skipped`);
      } catch (e) {
        console.warn(`[Classify] ${CLASSIFY_VARIANTS[v]} error:`, e?.message || e);
      }
    }

    await upstashSet('seed-meta:classify', { fetchedAt: Date.now(), recordCount: totalClassified }, 604800);
    console.log(`[Classify] Done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${totalClassified} classified, ${totalSkipped} skipped`);
  } catch (e) {
    console.warn('[Classify] Seed error:', e?.message || e);
  } finally {
    classifyInFlight = false;
  }
}

async function startClassifySeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[Classify] Disabled (no Upstash Redis)');
    return;
  }
  const apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY;
  console.log(`[Classify] Seed loop starting (interval ${CLASSIFY_SEED_INTERVAL_MS / 1000 / 60}min, apiKey:${apiKey ? 'yes' : 'no'})`);
  seedClassify().catch((e) => console.warn('[Classify] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedClassify().catch((e) => console.warn('[Classify] Seed error:', e?.message || e));
  }, CLASSIFY_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Service Statuses Seed — warm-pings Vercel RPC every 15 min
// so service statuses are always cached (TTL is 30 min).
// ─────────────────────────────────────────────────────────────
const SERVICE_STATUSES_SEED_INTERVAL_MS = 15 * 60 * 1000; // 15 min (TTL/2)
const SERVICE_STATUSES_RPC_URL = 'https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses';

async function seedServiceStatuses() {
  try {
    const resp = await fetch(SERVICE_STATUSES_RPC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CHROME_UA,
        Origin: 'https://worldmonitor.app',
      },
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.warn(`[ServiceStatuses] Seed ping failed: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const count = data?.statuses?.length || 0;
    console.log(`[ServiceStatuses] Seed ping OK — ${count} statuses`);
  } catch (e) {
    console.warn('[ServiceStatuses] Seed ping error:', e?.message || e);
  }
}

function startServiceStatusesSeedLoop() {
  console.log(`[ServiceStatuses] Seed loop starting (interval ${SERVICE_STATUSES_SEED_INTERVAL_MS / 1000 / 60}min)`);
  seedServiceStatuses().catch((e) => console.warn('[ServiceStatuses] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedServiceStatuses().catch((e) => console.warn('[ServiceStatuses] Seed error:', e?.message || e));
  }, SERVICE_STATUSES_SEED_INTERVAL_MS).unref?.();
}


// ─────────────────────────────────────────────────────────────
// Theater Posture Seed — fetches OpenSky directly via localhost
// proxy, computes military postures, writes to Redis.
// Eliminates circular dependency on Vercel RPC.
// ─────────────────────────────────────────────────────────────
const THEATER_POSTURE_SEED_INTERVAL_MS = 600_000; // 10 min
const THEATER_POSTURE_LIVE_KEY = 'theater-posture:sebuf:v1';
const THEATER_POSTURE_STALE_KEY = 'theater-posture:sebuf:stale:v1';
const THEATER_POSTURE_BACKUP_KEY = 'theater-posture:sebuf:backup:v1';
const THEATER_POSTURE_LIVE_TTL = 900;    // 15 min
const THEATER_POSTURE_STALE_TTL = 86400; // 24h
const THEATER_POSTURE_BACKUP_TTL = 604800; // 7d

const THEATER_MIL_PREFIXES = [
  'RCH', 'REACH', 'MOOSE', 'EVAC', 'DUSTOFF', 'PEDRO',
  'DUKE', 'HAVOC', 'KNIFE', 'WARHAWK', 'VIPER', 'RAGE', 'FURY',
  'SHELL', 'TEXACO', 'ARCO', 'ESSO', 'PETRO',
  'SENTRY', 'AWACS', 'MAGIC', 'DISCO', 'DARKSTAR',
  'COBRA', 'PYTHON', 'RAPTOR', 'EAGLE', 'HAWK', 'TALON',
  'BOXER', 'OMNI', 'TOPCAT', 'SKULL', 'REAPER', 'HUNTER',
  'ARMY', 'NAVY', 'USAF', 'USMC', 'USCG',
  'CNV', 'EXEC',
  'NATO', 'GAF', 'RRF', 'RAF', 'FAF', 'IAF', 'RNLAF', 'BAF', 'DAF', 'HAF', 'PAF',
  'SWORD', 'LANCE', 'ARROW', 'SPARTAN',
  'RSAF', 'EMIRI', 'UAEAF', 'KAF', 'QAF', 'BAHAF', 'OMAAF',
  'IRIAF', 'IRGC',
  'TUAF',
  'RSD', 'RFF', 'VKS',
  'CHN', 'PLAAF', 'PLA',
];
const THEATER_MIL_SHORT_PREFIXES = ['AE', 'RF', 'TF', 'PAT', 'SAM', 'OPS', 'CTF', 'IRG', 'TAF'];
const THEATER_AIRLINE_CODES = new Set([
  'SVA', 'QTR', 'THY', 'UAE', 'ETD', 'GFA', 'MEA', 'RJA', 'KAC', 'ELY',
  'IAW', 'IRA', 'MSR', 'SYR', 'PGT', 'AXB', 'FDB', 'KNE', 'FAD', 'ADY', 'OMA',
  'ABQ', 'ABY', 'NIA', 'FJA', 'SWR', 'HZA', 'OMS', 'EGF', 'NOS', 'SXD',
]);

function theaterIsMilCallsign(callsign) {
  if (!callsign) return false;
  const cs = callsign.toUpperCase().trim();
  for (const prefix of THEATER_MIL_PREFIXES) {
    if (cs.startsWith(prefix)) return true;
  }
  for (const prefix of THEATER_MIL_SHORT_PREFIXES) {
    if (cs.startsWith(prefix) && cs.length > prefix.length && /\d/.test(cs.charAt(prefix.length))) return true;
  }
  if (/^[A-Z]{3}\d{1,2}$/.test(cs)) {
    const prefix = cs.slice(0, 3);
    if (!THEATER_AIRLINE_CODES.has(prefix)) return true;
  }
  return false;
}

function theaterDetectAircraftType(callsign) {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(cs)) return 'tanker';
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(cs)) return 'awacs';
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(cs)) return 'transport';
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO|RC|U2|SR)/.test(cs)) return 'reconnaissance';
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(cs)) return 'bomber';
  if (/^(BOLT|VIPER|RAPTOR|BRONCO|EAGLE|HORNET|FALCON|STRIKE|TANGO|FURY)/.test(cs)) return 'fighter';
  return 'unknown';
}

const POSTURE_THEATERS = [
  { id: 'iran-theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
];

const THEATER_QUERY_REGIONS = [
  { name: 'WESTERN', lamin: 10, lamax: 66, lomin: 9, lomax: 66 },
  { name: 'PACIFIC', lamin: 4, lamax: 44, lomin: 104, lomax: 133 },
];

async function fetchTheaterFlightsFromOpenSky() {
  const seenIds = new Set();
  const allFlights = [];
  for (const region of THEATER_QUERY_REGIONS) {
    const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
    const resp = await fetch(`http://localhost:${PORT}/opensky?${params}`, {
      headers: { 'User-Agent': CHROME_UA, ...(RELAY_SHARED_SECRET ? { 'x-relay-key': RELAY_SHARED_SECRET } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`OpenSky proxy ${resp.status} for ${region.name}`);
    const data = await resp.json();
    if (!data.states) continue;
    for (const state of data.states) {
      const [icao24, callsign, , , , lon, lat, altitude, onGround, velocity, heading] = state;
      if (lat == null || lon == null || onGround) continue;
      if (!theaterIsMilCallsign(callsign)) continue;
      if (seenIds.has(icao24)) continue;
      seenIds.add(icao24);
      allFlights.push({
        id: icao24,
        callsign: (callsign || '').trim(),
        lat, lon,
        altitude: altitude || 0,
        heading: heading || 0,
        speed: velocity || 0,
        aircraftType: theaterDetectAircraftType(callsign),
      });
    }
  }
  return allFlights;
}

async function fetchTheaterFlightsFromWingbits() {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) return null;
  const areas = POSTURE_THEATERS.map((t) => ({
    alias: t.id,
    by: 'box',
    la: (t.bounds.north + t.bounds.south) / 2,
    lo: (t.bounds.east + t.bounds.west) / 2,
    w: Math.abs(t.bounds.east - t.bounds.west) * 60,
    h: Math.abs(t.bounds.north - t.bounds.south) * 60,
    unit: 'nm',
  }));
  try {
    const resp = await fetch('https://customer-api.wingbits.com/v1/flights', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify(areas),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const flights = [];
    const seenIds = new Set();
    for (const areaResult of data) {
      const flightList = Array.isArray(areaResult.data) ? areaResult.data
        : Array.isArray(areaResult.flights) ? areaResult.flights
        : Array.isArray(areaResult) ? areaResult : [];
      for (const f of flightList) {
        const icao24 = f.h || f.icao24 || f.id;
        if (!icao24 || seenIds.has(icao24)) continue;
        seenIds.add(icao24);
        const callsign = (f.f || f.callsign || f.flight || '').trim();
        if (!theaterIsMilCallsign(callsign)) continue;
        flights.push({
          id: icao24, callsign,
          lat: f.la || f.latitude || f.lat,
          lon: f.lo || f.longitude || f.lon || f.lng,
          altitude: f.ab || f.altitude || f.alt || 0,
          heading: f.th || f.heading || f.track || 0,
          speed: f.gs || f.groundSpeed || f.speed || f.velocity || 0,
          aircraftType: theaterDetectAircraftType(callsign),
        });
      }
    }
    return flights;
  } catch {
    return null;
  }
}

function calculateTheaterPostures(flights) {
  return POSTURE_THEATERS.map((theater) => {
    const tf = flights.filter(
      (f) => f.lat >= theater.bounds.south && f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west && f.lon <= theater.bounds.east,
    );
    const total = tf.length;
    const tankers = tf.filter((f) => f.aircraftType === 'tanker').length;
    const awacs = tf.filter((f) => f.aircraftType === 'awacs').length;
    const fighters = tf.filter((f) => f.aircraftType === 'fighter').length;
    const postureLevel = total >= theater.thresholds.critical ? 'critical'
      : total >= theater.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = tankers >= theater.strikeIndicators.minTankers &&
      awacs >= theater.strikeIndicators.minAwacs && fighters >= theater.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (tankers > 0) ops.push('aerial_refueling');
    if (awacs > 0) ops.push('airborne_early_warning');
    return {
      theater: theater.id, postureLevel, activeFlights: total,
      trackedVessels: 0, activeOperations: ops, assessedAt: Date.now(),
    };
  });
}
async function seedTheaterPosture() {
  const t0 = Date.now();
  let flights = [];
  try {
    flights = await fetchTheaterFlightsFromOpenSky();
  } catch (e) {
    console.warn(`[TheaterPosture] OpenSky failed: ${e?.message || e}`);
  }
  if (flights.length === 0) {
    const wb = await fetchTheaterFlightsFromWingbits();
    if (wb && wb.length > 0) flights = wb;
  }
  if (flights.length === 0) {
    console.warn('[TheaterPosture] No military flights from OpenSky or Wingbits — skipping');
    return;
  }
  const theaters = calculateTheaterPostures(flights);
  const payload = { theaters };
  const ok1 = await upstashSet(THEATER_POSTURE_LIVE_KEY, payload, THEATER_POSTURE_LIVE_TTL);
  const ok2 = await upstashSet(THEATER_POSTURE_STALE_KEY, payload, THEATER_POSTURE_STALE_TTL);
  const ok3 = await upstashSet(THEATER_POSTURE_BACKUP_KEY, payload, THEATER_POSTURE_BACKUP_TTL);
  await upstashSet('seed-meta:theater-posture', { fetchedAt: Date.now(), recordCount: flights.length }, 604800);
  const elevated = theaters.filter((t) => t.postureLevel !== 'normal').length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[TheaterPosture] Seeded ${flights.length} mil flights, ${theaters.length} theaters (${elevated} elevated), redis: ${ok1 && ok2 && ok3 ? 'OK' : 'PARTIAL'} [${elapsed}s]`);
}

function startTheaterPostureSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[TheaterPosture] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[TheaterPosture] Seed loop starting (interval ${THEATER_POSTURE_SEED_INTERVAL_MS / 1000 / 60}min)`);
  // Delay initial seed 30s to let the relay's OpenSky proxy start up
  setTimeout(() => {
    seedTheaterPosture().catch((e) => console.warn('[TheaterPosture] Initial seed error:', e?.message || e));
    setInterval(() => {
      seedTheaterPosture().catch((e) => console.warn('[TheaterPosture] Seed error:', e?.message || e));
    }, THEATER_POSTURE_SEED_INTERVAL_MS).unref?.();
  }, 30_000);
}

// ─────────────────────────────────────────────────────────────
// CII Risk Scores warm-ping — keeps RPC cache fresh so
// bootstrap stale key never expires.
// The RPC handler itself refreshes the stale key on every call.
// ─────────────────────────────────────────────────────────────
const CII_WARM_PING_INTERVAL_MS = 8 * 60 * 1000; // 8 min (live cache TTL is 10 min)
const CII_RPC_URL = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';

async function seedCiiWarmPing() {
  try {
    const resp = await fetch(CII_RPC_URL, {
      headers: {
        'User-Agent': CHROME_UA,
        Origin: 'https://worldmonitor.app',
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) {
      console.warn(`[CII] Warm-ping failed: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const count = data?.ciiScores?.length || 0;
    console.log(`[CII] Warm-ping OK: ${count} scores`);
  } catch (e) {
    console.warn('[CII] Warm-ping error:', e?.message || e);
  }
}

function startCiiWarmPingLoop() {
  console.log(`[CII] Warm-ping loop starting (interval ${CII_WARM_PING_INTERVAL_MS / 1000 / 60}min)`);
  seedCiiWarmPing().catch((e) => console.warn('[CII] Initial warm-ping error:', e?.message || e));
  setInterval(() => {
    seedCiiWarmPing().catch((e) => console.warn('[CII] Warm-ping error:', e?.message || e));
  }, CII_WARM_PING_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Weather Alerts Seed — NWS API → Redis every 15 min
// ─────────────────────────────────────────────────────────────
const WEATHER_SEED_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const WEATHER_REDIS_KEY = 'weather:alerts:v1';
const WEATHER_CACHE_TTL = 900;
let weatherSeedInFlight = false;

async function seedWeatherAlerts() {
  if (weatherSeedInFlight) return;
  weatherSeedInFlight = true;
  const t0 = Date.now();
  try {
    const resp = await fetch('https://api.weather.gov/alerts/active', {
      headers: { Accept: 'application/geo+json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.warn(`[Weather] Seed failed: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const features = data.features || [];
    const alerts = features
      .filter((f) => f?.properties?.severity !== 'Unknown')
      .slice(0, 50)
      .map((f) => {
        const p = f.properties;
        let coords = [];
        try {
          const g = f.geometry;
          if (g?.type === 'Polygon') coords = g.coordinates[0]?.map((c) => [c[0], c[1]]) || [];
          else if (g?.type === 'MultiPolygon') coords = g.coordinates[0]?.[0]?.map((c) => [c[0], c[1]]) || [];
        } catch { /* ignore */ }
        const centroid = coords.length > 0
          ? [coords.reduce((s, c) => s + c[0], 0) / coords.length, coords.reduce((s, c) => s + c[1], 0) / coords.length]
          : undefined;
        return {
          id: f.id || '', event: p.event || '', severity: p.severity || 'Unknown',
          headline: p.headline || '', description: (p.description || '').slice(0, 500),
          areaDesc: p.areaDesc || '', onset: p.onset || '', expires: p.expires || '',
          coordinates: coords, centroid,
        };
      });
    if (alerts.length === 0) {
      console.warn('[Weather] No alerts returned — preserving last good data');
      return;
    }
    const payload = { alerts };
    const ok1 = await upstashSet(WEATHER_REDIS_KEY, payload, WEATHER_CACHE_TTL);
    const ok2 = await upstashSet('seed-meta:weather:alerts', { fetchedAt: Date.now(), recordCount: alerts.length }, 604800);
    console.log(`[Weather] Seeded ${alerts.length} alerts (redis: ${ok1 && ok2 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[Weather] Seed error:', e?.message || e);
  } finally {
    weatherSeedInFlight = false;
  }
}

async function startWeatherSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[Weather] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[Weather] Seed loop starting (interval ${WEATHER_SEED_INTERVAL_MS / 1000 / 60}min)`);
  seedWeatherAlerts().catch((e) => console.warn('[Weather] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedWeatherAlerts().catch((e) => console.warn('[Weather] Seed error:', e?.message || e));
  }, WEATHER_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// USASpending Seed — federal awards → Redis every 60 min
// ─────────────────────────────────────────────────────────────
const SPENDING_SEED_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SPENDING_REDIS_KEY = 'economic:spending:v1';
const SPENDING_CACHE_TTL = 3600;
let spendingSeedInFlight = false;

function getDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

const AWARD_TYPE_MAP = {
  A: 'contract', B: 'contract', C: 'contract', D: 'contract',
  '02': 'grant', '03': 'grant', '04': 'grant', '05': 'grant', '06': 'grant', '10': 'grant',
  '07': 'loan', '08': 'loan',
};

async function seedUsaSpending() {
  if (spendingSeedInFlight) return;
  spendingSeedInFlight = true;
  const t0 = Date.now();
  try {
    const periodStart = getDateDaysAgo(7);
    const periodEnd = new Date().toISOString().split('T')[0];
    const resp = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        filters: {
          time_period: [{ start_date: periodStart, end_date: periodEnd }],
          award_type_codes: ['A', 'B', 'C', 'D'],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Description', 'Start Date', 'Award Type'],
        limit: 15, order: 'desc', sort: 'Award Amount',
      }),
    });
    if (!resp.ok) {
      console.warn(`[Spending] Seed failed: HTTP ${resp.status}`);
      return;
    }
    const data = await resp.json();
    const results = data.results || [];
    const awards = results.map((r) => ({
      id: String(r['Award ID'] || ''),
      recipientName: String(r['Recipient Name'] || 'Unknown'),
      amount: Number(r['Award Amount']) || 0,
      agency: String(r['Awarding Agency'] || 'Unknown'),
      description: String(r['Description'] || '').slice(0, 200),
      startDate: String(r['Start Date'] || ''),
      awardType: AWARD_TYPE_MAP[String(r['Award Type'] || '')] || 'other',
    }));
    if (awards.length === 0) {
      console.warn('[Spending] No awards returned — preserving last good data');
      return;
    }
    const totalAmount = awards.reduce((s, a) => s + a.amount, 0);
    const payload = { awards, totalAmount, periodStart, periodEnd, fetchedAt: Date.now() };
    const ok1 = await upstashSet(SPENDING_REDIS_KEY, payload, SPENDING_CACHE_TTL);
    const ok2 = await upstashSet('seed-meta:economic:spending', { fetchedAt: Date.now(), recordCount: awards.length }, 604800);
    console.log(`[Spending] Seeded ${awards.length} awards, $${(totalAmount / 1e6).toFixed(1)}M (redis: ${ok1 && ok2 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[Spending] Seed error:', e?.message || e);
  } finally {
    spendingSeedInFlight = false;
  }
}

async function startSpendingSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[Spending] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[Spending] Seed loop starting (interval ${SPENDING_SEED_INTERVAL_MS / 1000 / 60}min)`);
  seedUsaSpending().catch((e) => console.warn('[Spending] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedUsaSpending().catch((e) => console.warn('[Spending] Seed error:', e?.message || e));
  }, SPENDING_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// Tech Events seed — Techmeme ICS + dev.events RSS → Redis
// Curated major conferences as fallback for events that may
// fall off limited RSS feeds. Vercel edge can't reach these
// sources reliably (IP blocking), so Railway fetches them.
// ─────────────────────────────────────────────────────────────

const TECH_EVENTS_SEED_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const TECH_EVENTS_TTL_SECONDS = 86400; // 24h safety net
const TECH_EVENTS_REDIS_KEY = 'research:tech-events:v1';
const TECH_EVENTS_BOOTSTRAP_KEY = 'research:tech-events-bootstrap:v1';
const TECH_EVENTS_ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
const TECH_EVENTS_RSS_URL = 'https://dev.events/rss.xml';

const TECH_EVENTS_CURATED = [
  { id: 'gitex-global-2026', title: 'GITEX Global 2026', type: 'conference', location: 'Dubai World Trade Centre, Dubai', startDate: '2026-12-07', endDate: '2026-12-11', url: 'https://www.gitex.com', source: 'curated', description: "World's largest tech & startup show" },
  { id: 'token2049-dubai-2026', title: 'TOKEN2049 Dubai 2026', type: 'conference', location: 'Dubai, UAE', startDate: '2026-04-29', endDate: '2026-04-30', url: 'https://www.token2049.com', source: 'curated', description: 'Premier crypto event in Dubai' },
  { id: 'collision-2026', title: 'Collision 2026', type: 'conference', location: 'Toronto, Canada', startDate: '2026-06-22', endDate: '2026-06-25', url: 'https://collisionconf.com', source: 'curated', description: "North America's fastest growing tech conference" },
  { id: 'web-summit-2026', title: 'Web Summit 2026', type: 'conference', location: 'Lisbon, Portugal', startDate: '2026-11-02', endDate: '2026-11-05', url: 'https://websummit.com', source: 'curated', description: "The world's premier tech conference" },
];

function techEventsParseICS(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const locationMatch = block.match(/LOCATION:(.+)/);
    const dtstartMatch = block.match(/DTSTART;VALUE=DATE:(\d+)/);
    const dtendMatch = block.match(/DTEND;VALUE=DATE:(\d+)/);
    const urlMatch = block.match(/URL:(.+)/);
    const uidMatch = block.match(/UID:(.+)/);
    if (!summaryMatch || !dtstartMatch) continue;
    const summary = summaryMatch[1].trim();
    const location = locationMatch ? locationMatch[1].trim() : '';
    const startDate = dtstartMatch[1];
    const endDate = dtendMatch ? dtendMatch[1] : startDate;
    let type = 'other';
    if (summary.startsWith('Earnings:')) type = 'earnings';
    else if (summary.startsWith('IPO')) type = 'ipo';
    else if (location) type = 'conference';
    events.push({
      id: uidMatch ? uidMatch[1].trim() : '',
      title: summary,
      type,
      location,
      startDate: `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`,
      endDate: `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`,
      url: urlMatch ? urlMatch[1].trim() : '',
      source: 'techmeme',
      description: '',
    });
  }
  return events;
}

function techEventsParseRSS(rssText) {
  const events = [];
  const itemMatches = rssText.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guidMatch = item.match(/<guid[^>]*>(.*?)<\/guid>/);
    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2]) : null;
    if (!title) continue;
    const link = linkMatch ? linkMatch[1] || '' : '';
    const description = descMatch ? (descMatch[1] ?? descMatch[2] ?? '') : '';
    const guid = guidMatch ? guidMatch[1] || '' : '';
    const dateMatch = description.match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate = null;
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]);
      if (!isNaN(parsed.getTime())) startDate = parsed.toISOString().split('T')[0];
    }
    if (!startDate) continue;
    if (new Date(startDate) < new Date(new Date().toISOString().split('T')[0])) continue;
    let location = null;
    const locMatch = description.match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i) ||
                     description.match(/Location:\s*([^<\n]+)/i);
    if (locMatch) location = locMatch[1].trim();
    if (description.toLowerCase().includes('online')) location = 'Online';
    events.push({
      id: guid || `dev-events-${title.slice(0, 20)}`,
      title,
      type: 'conference',
      location: location || '',
      startDate,
      endDate: startDate,
      url: link,
      source: 'dev.events',
      description: '',
    });
  }
  return events;
}

function techEventsFetchUrl(url) {
  return new Promise((resolve) => {
    const request = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/calendar, application/rss+xml, application/xml, text/xml, */*',
      },
      timeout: 15000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        return techEventsFetchUrl(response.headers.location).then(resolve);
      }
      if (response.statusCode !== 200) {
        resolve(null);
        response.resume();
        return;
      }
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve(data));
      response.on('error', () => resolve(null));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

let techEventsSeedInFlight = false;

async function seedTechEvents() {
  if (techEventsSeedInFlight) return;
  techEventsSeedInFlight = true;
  const t0 = Date.now();
  try {
    const [icsText, rssText] = await Promise.all([
      techEventsFetchUrl(TECH_EVENTS_ICS_URL),
      techEventsFetchUrl(TECH_EVENTS_RSS_URL),
    ]);

    let events = [];
    if (icsText) {
      const parsed = techEventsParseICS(icsText);
      events.push(...parsed);
      console.log(`[TechEvents] Techmeme ICS: ${parsed.length} events`);
    } else {
      console.warn('[TechEvents] Techmeme ICS fetch failed');
    }
    if (rssText) {
      const parsed = techEventsParseRSS(rssText);
      events.push(...parsed);
      console.log(`[TechEvents] dev.events RSS: ${parsed.length} events`);
    } else {
      console.warn('[TechEvents] dev.events RSS fetch failed');
    }

    // Add curated events that are still in the future
    const today = new Date().toISOString().split('T')[0];
    for (const curated of TECH_EVENTS_CURATED) {
      if (curated.startDate >= today) events.push(curated);
    }

    // Deduplicate by normalized title + year
    const seen = new Set();
    events = events.filter((e) => {
      const year = e.startDate.slice(0, 4);
      const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + year;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date
    events.sort((a, b) => a.startDate.localeCompare(b.startDate));

    if (events.length === 0) {
      console.warn('[TechEvents] No events from any source — preserving last good data');
      return;
    }

    const payload = {
      success: true,
      count: events.length,
      conferenceCount: events.filter((e) => e.type === 'conference').length,
      mappableCount: 0, // geocoding happens in RPC handler
      lastUpdated: new Date().toISOString(),
      events,
      error: '',
    };

    const ok1 = await upstashSet(TECH_EVENTS_REDIS_KEY, payload, TECH_EVENTS_TTL_SECONDS);
    const ok2 = await upstashSet(TECH_EVENTS_BOOTSTRAP_KEY, payload, TECH_EVENTS_TTL_SECONDS);
    const ok3 = await upstashSet('seed-meta:research:tech-events', { fetchedAt: Date.now(), recordCount: events.length }, 604800);
    console.log(`[TechEvents] Seeded ${events.length} events (redis: ${ok1 && ok2 && ok3 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[TechEvents] Seed error:', e?.message || e);
  } finally {
    techEventsSeedInFlight = false;
  }
}

async function startTechEventsSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[TechEvents] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[TechEvents] Seed loop starting (interval ${TECH_EVENTS_SEED_INTERVAL_MS / 1000 / 60 / 60}h)`);
  seedTechEvents().catch((e) => console.warn('[TechEvents] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedTechEvents().catch((e) => console.warn('[TechEvents] Seed error:', e?.message || e));
  }, TECH_EVENTS_SEED_INTERVAL_MS).unref?.();
}

// ─────────────────────────────────────────────────────────────
// World Bank Indicators seed loop (tech readiness, progress, renewable)
// ─────────────────────────────────────────────────────────────

const WB_SEED_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours (data is annual)
const WB_TTL_SECONDS = 7 * 24 * 3600; // 7 days
const WB_BOOTSTRAP_KEY = 'economic:worldbank-techreadiness:v1';
const WB_PROGRESS_KEY = 'economic:worldbank-progress:v1';
const WB_RENEWABLE_KEY = 'economic:worldbank-renewable:v1';

const WB_WEIGHTS = { internet: 30, mobile: 15, broadband: 20, rdSpend: 35 };
const WB_NORMALIZE_MAX = { internet: 100, mobile: 150, broadband: 50, rdSpend: 5 };

const WB_INDICATORS = [
  { key: 'internet',  id: 'IT.NET.USER.ZS', dateRange: '2019:2024' },
  { key: 'mobile',    id: 'IT.CEL.SETS.P2', dateRange: '2019:2024' },
  { key: 'broadband', id: 'IT.NET.BBND.P2', dateRange: '2019:2024' },
  { key: 'rdSpend',   id: 'GB.XPD.RSDV.GD.ZS', dateRange: '2018:2024' },
];

const WB_PROGRESS_INDICATORS = [
  { id: 'lifeExpectancy', code: 'SP.DYN.LE00.IN', years: 65, invertTrend: false },
  { id: 'literacy',       code: 'SE.ADT.LITR.ZS', years: 55, invertTrend: false },
  { id: 'childMortality', code: 'SH.DYN.MORT',    years: 65, invertTrend: true },
  { id: 'poverty',        code: 'SI.POV.DDAY',    years: 45, invertTrend: true },
];

const WB_RENEWABLE_REGIONS = ['1W', 'EAS', 'ECS', 'LCN', 'MEA', 'NAC', 'SAS', 'SSF'];
const WB_RENEWABLE_REGION_NAMES = {
  '1W': 'World', EAS: 'East Asia & Pacific', ECS: 'Europe & Central Asia',
  LCN: 'Latin America & Caribbean', MEA: 'Middle East & N. Africa',
  NAC: 'North America', SAS: 'South Asia', SSF: 'Sub-Saharan Africa',
};

function wbFetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'WorldMonitor-Seed/1.0', Accept: 'application/json' },
      timeout: 30000,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return reject(new Error(`WB HTTP ${resp.statusCode}`));
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('WB timeout')); });
  });
}

async function wbFetchIndicator(indicatorId, dateRange) {
  const baseUrl = `https://api.worldbank.org/v2/country/all/indicator/${indicatorId}`;
  let page = 1;
  let totalPages = 1;
  const allEntries = [];

  while (page <= totalPages) {
    const url = `${baseUrl}?format=json&date=${dateRange}&per_page=1000&page=${page}`;
    const raw = await wbFetchJson(url);
    if (!Array.isArray(raw) || raw.length < 2) break;
    totalPages = raw[0].pages || 1;
    if (Array.isArray(raw[1])) allEntries.push(...raw[1]);
    page++;
  }

  const latestByCountry = {};
  for (const entry of allEntries) {
    if (entry.value === null || entry.value === undefined) continue;
    const iso3 = entry.countryiso3code;
    if (!iso3 || iso3.length !== 3) continue;
    const year = parseInt(entry.date, 10);
    if (!latestByCountry[iso3] || year > latestByCountry[iso3].year) {
      latestByCountry[iso3] = { value: entry.value, name: entry.country?.value || iso3, year };
    }
  }
  return latestByCountry;
}

function wbNormalize(val, max) {
  if (val === undefined || val === null) return null;
  return Math.min(100, (val / max) * 100);
}

function wbComputeRankings(indicatorData) {
  const allCountries = new Set();
  for (const data of Object.values(indicatorData)) {
    Object.keys(data).forEach(c => allCountries.add(c));
  }
  const scores = [];
  for (const cc of allCountries) {
    const components = {
      internet:  wbNormalize(indicatorData.internet[cc]?.value, WB_NORMALIZE_MAX.internet),
      mobile:    wbNormalize(indicatorData.mobile[cc]?.value, WB_NORMALIZE_MAX.mobile),
      broadband: wbNormalize(indicatorData.broadband[cc]?.value, WB_NORMALIZE_MAX.broadband),
      rdSpend:   wbNormalize(indicatorData.rdSpend[cc]?.value, WB_NORMALIZE_MAX.rdSpend),
    };
    let totalWeight = 0, weightedSum = 0;
    for (const [key, weight] of Object.entries(WB_WEIGHTS)) {
      if (components[key] !== null) { weightedSum += components[key] * weight; totalWeight += weight; }
    }
    const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const name = indicatorData.internet[cc]?.name || indicatorData.mobile[cc]?.name || cc;
    scores.push({ country: cc, countryName: name, score: Math.round(score * 10) / 10, rank: 0, components });
  }
  scores.sort((a, b) => b.score - a.score);
  scores.forEach((s, i) => { s.rank = i + 1; });
  return scores;
}

async function wbFetchProgress() {
  const currentYear = new Date().getFullYear();
  const results = [];
  for (const ind of WB_PROGRESS_INDICATORS) {
    const startYear = currentYear - ind.years;
    const url = `https://api.worldbank.org/v2/country/1W/indicator/${ind.code}?format=json&date=${startYear}:${currentYear}&per_page=1000`;
    try {
      const raw = await wbFetchJson(url);
      if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
        results.push({ id: ind.id, code: ind.code, data: [], invertTrend: ind.invertTrend });
        continue;
      }
      const data = raw[1]
        .filter(e => e.value !== null && e.value !== undefined)
        .map(e => ({ year: parseInt(e.date, 10), value: e.value }))
        .filter(d => !isNaN(d.year))
        .sort((a, b) => a.year - b.year);
      results.push({ id: ind.id, code: ind.code, data, invertTrend: ind.invertTrend });
    } catch (e) {
      console.warn(`[WB] Progress ${ind.code} failed:`, e?.message);
      results.push({ id: ind.id, code: ind.code, data: [], invertTrend: ind.invertTrend });
    }
  }
  return results;
}

async function wbFetchRenewable() {
  const currentYear = new Date().getFullYear();
  const startYear = currentYear - 35;
  const codes = WB_RENEWABLE_REGIONS.join(';');
  const url = `https://api.worldbank.org/v2/country/${codes}/indicator/EG.ELC.RNEW.ZS?format=json&date=${startYear}:${currentYear}&per_page=1000`;
  try {
    const raw = await wbFetchJson(url);
    if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
      return { globalPercentage: 0, globalYear: 0, historicalData: [], regions: [] };
    }
    const entries = raw[1].filter(e => e.value !== null && e.value !== undefined);
    const byRegion = {};
    for (const e of entries) {
      const code = e.countryiso3code || e.country?.id;
      if (!code) continue;
      if (!byRegion[code]) byRegion[code] = [];
      byRegion[code].push({ year: parseInt(e.date, 10), value: e.value });
    }
    for (const arr of Object.values(byRegion)) arr.sort((a, b) => a.year - b.year);

    const worldData = byRegion['WLD'] || byRegion['1W'] || [];
    const latest = worldData.length ? worldData[worldData.length - 1] : null;
    const regions = [];
    for (const code of WB_RENEWABLE_REGIONS) {
      if (code === '1W') continue;
      const rd = byRegion[code] || [];
      if (!rd.length) continue;
      const lr = rd[rd.length - 1];
      regions.push({ code, name: WB_RENEWABLE_REGION_NAMES[code] || code, percentage: lr.value, year: lr.year });
    }
    regions.sort((a, b) => b.percentage - a.percentage);
    return { globalPercentage: latest?.value || 0, globalYear: latest?.year || 0, historicalData: worldData, regions };
  } catch (e) {
    console.warn('[WB] Renewable fetch failed:', e?.message);
    return { globalPercentage: 0, globalYear: 0, historicalData: [], regions: [] };
  }
}

async function seedWorldBank() {
  try {
    console.log('[WB] Fetching tech readiness indicators...');
    const indicatorData = {};
    for (const { key, id, dateRange } of WB_INDICATORS) {
      indicatorData[key] = await wbFetchIndicator(id, dateRange);
      console.log(`[WB]   ${id}: ${Object.keys(indicatorData[key]).length} countries`);
    }
    const rankings = wbComputeRankings(indicatorData);
    console.log(`[WB] Rankings: ${rankings.length} countries`);

    console.log('[WB] Fetching progress indicators...');
    const progressData = await wbFetchProgress();
    const progressWithData = progressData.filter(p => p.data.length > 0);
    console.log(`[WB] Progress: ${progressWithData.length}/${progressData.length} with data`);

    console.log('[WB] Fetching renewable energy...');
    const renewableData = await wbFetchRenewable();
    console.log(`[WB] Renewable: global=${renewableData.globalPercentage}%, ${renewableData.regions.length} regions`);

    if (rankings.length === 0) {
      console.warn('[WB] No rankings — aborting seed');
      return;
    }

    const metaTtl = WB_TTL_SECONDS + 3600;
    let ok = await upstashSet(WB_BOOTSTRAP_KEY, rankings, WB_TTL_SECONDS);
    console.log(`[WB] techReadiness: ${rankings.length} rankings (redis: ${ok ? 'OK' : 'FAIL'})`);
    await upstashSet(`seed-meta:${WB_BOOTSTRAP_KEY}`, { fetchedAt: Date.now(), recordCount: rankings.length }, metaTtl);

    if (progressWithData.length > 0) {
      ok = await upstashSet(WB_PROGRESS_KEY, progressData, WB_TTL_SECONDS);
      console.log(`[WB] progressData: ${progressWithData.length} indicators (redis: ${ok ? 'OK' : 'FAIL'})`);
      await upstashSet(`seed-meta:${WB_PROGRESS_KEY}`, { fetchedAt: Date.now(), recordCount: progressWithData.length }, metaTtl);
    }

    if (renewableData.historicalData.length > 0) {
      ok = await upstashSet(WB_RENEWABLE_KEY, renewableData, WB_TTL_SECONDS);
      console.log(`[WB] renewableEnergy: ${renewableData.regions.length} regions (redis: ${ok ? 'OK' : 'FAIL'})`);
      await upstashSet(`seed-meta:${WB_RENEWABLE_KEY}`, { fetchedAt: Date.now(), recordCount: renewableData.historicalData.length }, metaTtl);
    }

    console.log('[WB] Seed complete');
  } catch (e) {
    console.warn('[WB] Seed error:', e?.message || e);
  }
}

async function startWorldBankSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[WB] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[WB] Seed loop starting (interval ${WB_SEED_INTERVAL_MS / 1000 / 60 / 60}h)`);
  seedWorldBank().catch(e => console.warn('[WB] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedWorldBank().catch(e => console.warn('[WB] Seed error:', e?.message || e));
  }, WB_SEED_INTERVAL_MS).unref?.();
}

const PORTWATCH_ARCGIS_BASE = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const PORTWATCH_PAGE_SIZE = 2000;
const PORTWATCH_FETCH_TIMEOUT_MS = 30000;
const PORTWATCH_REDIS_KEY = 'supply_chain:portwatch:v1';
const PORTWATCH_TTL = 43200;
const PORTWATCH_SEED_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PORTWATCH_CHOKEPOINT_NAMES = [
  { name: 'Suez Canal', id: 'suez' },
  { name: 'Malacca Strait', id: 'malacca_strait' },
  { name: 'Strait of Hormuz', id: 'hormuz_strait' },
  { name: 'Bab el-Mandeb Strait', id: 'bab_el_mandeb' },
  { name: 'Panama Canal', id: 'panama' },
  { name: 'Taiwan Strait', id: 'taiwan_strait' },
  { name: 'Cape of Good Hope', id: 'cape_of_good_hope' },
  { name: 'Gibraltar Strait', id: 'gibraltar' },
  { name: 'Bosporus Strait', id: 'bosphorus' },
  { name: 'Korea Strait', id: 'korea_strait' },
  { name: 'Dover Strait', id: 'dover_strait' },
  { name: 'Kerch Strait', id: 'kerch_strait' },
  { name: 'Lombok Strait', id: 'lombok_strait' },
];
let portwatchSeedInFlight = false;

function pwFormatDate(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function pwComputeWowChangePct(history) {
  if (history.length < 14) return 0;
  const sorted = [...history].sort((a, b) => b.date.localeCompare(a.date));
  let thisWeek = 0;
  let lastWeek = 0;
  for (let i = 0; i < 7 && i < sorted.length; i++) thisWeek += sorted[i].total;
  for (let i = 7; i < 14 && i < sorted.length; i++) lastWeek += sorted[i].total;
  if (lastWeek === 0) return 0;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10;
}

async function pwFetchAllPages(portname, sinceEpoch) {
  const all = [];
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      where: `portname='${portname.replace(/'/g, "''")}' AND date >= ${sinceEpoch}`,
      outFields: 'date,n_tanker,n_cargo,n_total',
      f: 'json',
      resultOffset: String(offset),
      resultRecordCount: String(PORTWATCH_PAGE_SIZE),
    });
    const resp = await fetch(`${PORTWATCH_ARCGIS_BASE}?${params}`, {
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(PORTWATCH_FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
    const body = await resp.json();
    if (body.features?.length) all.push(...body.features);
    if (!body.exceededTransferLimit) break;
    offset += PORTWATCH_PAGE_SIZE;
  }
  return all;
}

function pwBuildHistory(features) {
  return features
    .filter(f => f.attributes?.date)
    .map(f => {
      const a = f.attributes;
      const tanker = Number(a.n_tanker ?? 0);
      const cargo = Number(a.n_cargo ?? 0);
      const total = Number(a.n_total ?? tanker + cargo);
      return { date: pwFormatDate(a.date), tanker, cargo, other: Math.max(0, total - tanker - cargo), total };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function seedPortWatch() {
  if (portwatchSeedInFlight) return;
  portwatchSeedInFlight = true;
  const t0 = Date.now();
  try {
    const sinceEpoch = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const result = {};
    const CONCURRENCY = 3;
    for (let i = 0; i < PORTWATCH_CHOKEPOINT_NAMES.length; i += CONCURRENCY) {
      const batch = PORTWATCH_CHOKEPOINT_NAMES.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(cp => pwFetchAllPages(cp.name, sinceEpoch)));
      for (let j = 0; j < batch.length; j++) {
        const outcome = settled[j];
        if (outcome.status !== 'fulfilled' || !outcome.value.length) continue;
        const history = pwBuildHistory(outcome.value);
        result[batch[j].id] = { history, wowChangePct: pwComputeWowChangePct(history) };
      }
    }
    if (Object.keys(result).length === 0) {
      console.warn('[PortWatch] No data fetched — skipping');
      return;
    }
    const ok = await upstashSet(PORTWATCH_REDIS_KEY, result, PORTWATCH_TTL);
    await upstashSet('seed-meta:supply_chain:portwatch', { fetchedAt: Date.now(), recordCount: Object.keys(result).length }, 604800);
    console.log(`[PortWatch] Seeded ${Object.keys(result).length} chokepoints (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[PortWatch] Seed error:', e?.message || e);
  } finally {
    portwatchSeedInFlight = false;
  }
}

async function startPortWatchSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[PortWatch] Disabled (no Upstash Redis)');
    return;
  }
  console.log(`[PortWatch] Seed loop starting (interval ${PORTWATCH_SEED_INTERVAL_MS / 1000 / 60 / 60}h)`);
  seedPortWatch().catch(e => console.warn('[PortWatch] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedPortWatch().catch(e => console.warn('[PortWatch] Seed error:', e?.message || e));
  }, PORTWATCH_SEED_INTERVAL_MS).unref?.();
}

const CORRIDOR_RISK_API_KEY = process.env.CORRIDOR_RISK_API_KEY || '';
const CORRIDOR_RISK_BASE_URL = 'https://api.corridorrisk.io/v1/corridors';
const CORRIDOR_RISK_REDIS_KEY = 'supply_chain:corridorrisk:v1';
const CORRIDOR_RISK_TTL = 7200;
const CORRIDOR_RISK_SEED_INTERVAL_MS = 60 * 60 * 1000;
const CORRIDOR_RISK_NAMES = [
  { name: 'Suez', id: 'suez' },
  { name: 'Malacca', id: 'malacca_strait' },
  { name: 'Hormuz', id: 'hormuz_strait' },
  { name: 'Bab el-Mandeb', id: 'bab_el_mandeb' },
  { name: 'Panama', id: 'panama' },
  { name: 'Taiwan', id: 'taiwan_strait' },
  { name: 'Cape of Good Hope', id: 'cape_of_good_hope' },
];
let corridorRiskSeedInFlight = false;

async function seedCorridorRisk() {
  if (!CORRIDOR_RISK_API_KEY) return;
  if (corridorRiskSeedInFlight) return;
  corridorRiskSeedInFlight = true;
  const t0 = Date.now();
  try {
    const resp = await fetch(CORRIDOR_RISK_BASE_URL, {
      headers: {
        Authorization: `Bearer ${CORRIDOR_RISK_API_KEY}`,
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.warn(`[CorridorRisk] HTTP ${resp.status}`);
      return;
    }
    const body = await resp.json();
    const corridors = Array.isArray(body) ? body : body.data;
    if (!corridors?.length) {
      console.warn('[CorridorRisk] No corridors returned — skipping');
      return;
    }
    const crNameMap = new Map(CORRIDOR_RISK_NAMES.map(c => [c.name.toLowerCase(), c.id]));
    const result = {};
    for (const corridor of corridors) {
      const name = corridor.name;
      if (!name) continue;
      const id = crNameMap.get(name.toLowerCase());
      if (!id) continue;
      result[id] = {
        riskLevel: String(corridor.risk_level ?? ''),
        incidentCount7d: Number(corridor.incident_count_7d ?? 0),
        disruptionPct: Number(corridor.disruption_pct ?? 0),
      };
    }
    if (Object.keys(result).length === 0) {
      console.warn('[CorridorRisk] No matching corridors — skipping');
      return;
    }
    const ok = await upstashSet(CORRIDOR_RISK_REDIS_KEY, result, CORRIDOR_RISK_TTL);
    await upstashSet('seed-meta:supply_chain:corridorrisk', { fetchedAt: Date.now(), recordCount: Object.keys(result).length }, 604800);
    console.log(`[CorridorRisk] Seeded ${Object.keys(result).length} corridors (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[CorridorRisk] Seed error:', e?.message || e);
  } finally {
    corridorRiskSeedInFlight = false;
  }
}

async function startCorridorRiskSeedLoop() {
  if (!UPSTASH_ENABLED) {
    console.log('[CorridorRisk] Disabled (no Upstash Redis)');
    return;
  }
  if (!CORRIDOR_RISK_API_KEY) {
    console.log('[CorridorRisk] Disabled (no CORRIDOR_RISK_API_KEY)');
    return;
  }
  console.log(`[CorridorRisk] Seed loop starting (interval ${CORRIDOR_RISK_SEED_INTERVAL_MS / 1000 / 60}min)`);
  seedCorridorRisk().catch(e => console.warn('[CorridorRisk] Initial seed error:', e?.message || e));
  setInterval(() => {
    seedCorridorRisk().catch(e => console.warn('[CorridorRisk] Seed error:', e?.message || e));
  }, CORRIDOR_RISK_SEED_INTERVAL_MS).unref?.();
}

function gzipSyncBuffer(body) {
  try {
    return zlib.gzipSync(typeof body === 'string' ? Buffer.from(body) : body);
  } catch {
    return null;
  }
}

function getClientIp(req, isPublic = false) {
  if (isPublic) {
    // Public routes: only trust CF-Connecting-IP (set by Cloudflare, not spoofable).
    // x-real-ip is excluded — client-spoofable on unauthenticated endpoints.
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();
    return req.socket?.remoteAddress || 'unknown';
  }
  // Authenticated routes: x-real-ip is safe because auth token validates the caller
  const xRealIp = req.headers['x-real-ip'];
  if (typeof xRealIp === 'string' && xRealIp.trim()) {
    return xRealIp.trim();
  }
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff) {
    const parts = xff.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length > 0) return parts[0];
  }
  return req.socket?.remoteAddress || 'unknown';
}

function safeTokenEquals(provided, expected) {
  const a = Buffer.from(provided || '');
  const b = Buffer.from(expected || '');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getRelaySecretFromRequest(req) {
  const direct = req.headers[RELAY_AUTH_HEADER];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  return '';
}

function isAuthorizedRequest(req) {
  if (!RELAY_SHARED_SECRET) return true;
  const provided = getRelaySecretFromRequest(req);
  if (!provided) return false;
  return safeTokenEquals(provided, RELAY_SHARED_SECRET);
}

function getRouteGroup(pathname) {
  if (pathname.startsWith('/opensky')) return 'opensky';
  if (pathname.startsWith('/rss')) return 'rss';
  if (pathname.startsWith('/ais/snapshot')) return 'snapshot';
  if (pathname.startsWith('/worldbank')) return 'worldbank';
  if (pathname.startsWith('/polymarket')) return 'polymarket';
  if (pathname.startsWith('/ucdp-events')) return 'ucdp-events';
  if (pathname.startsWith('/oref')) return 'oref';
  if (pathname === '/notam') return 'notam';
  if (pathname === '/yahoo-chart') return 'yahoo-chart';
  return 'other';
}

function getRateLimitForPath(pathname) {
  if (pathname.startsWith('/opensky')) return RELAY_OPENSKY_RATE_LIMIT_MAX;
  if (pathname.startsWith('/rss')) return RELAY_RSS_RATE_LIMIT_MAX;
  if (pathname.startsWith('/oref')) return RELAY_OREF_RATE_LIMIT_MAX;
  return RELAY_RATE_LIMIT_MAX;
}

function consumeRateLimit(req, pathname, isPublic = false) {
  const maxRequests = getRateLimitForPath(pathname);
  if (!Number.isFinite(maxRequests) || maxRequests <= 0) return { limited: false, limit: 0, remaining: 0, resetInMs: 0 };

  const now = Date.now();
  const ip = getClientIp(req, isPublic);
  const key = `${getRouteGroup(pathname)}:${ip}`;
  const existing = requestRateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    const next = { count: 1, resetAt: now + RELAY_RATE_LIMIT_WINDOW_MS };
    requestRateBuckets.set(key, next);
    return { limited: false, limit: maxRequests, remaining: Math.max(0, maxRequests - 1), resetInMs: next.resetAt - now };
  }

  existing.count += 1;
  const limited = existing.count > maxRequests;
  return {
    limited,
    limit: maxRequests,
    remaining: Math.max(0, maxRequests - existing.count),
    resetInMs: Math.max(0, existing.resetAt - now),
  };
}

function logThrottled(level, key, ...args) {
  const now = Date.now();
  const last = logThrottleState.get(key) || 0;
  if (now - last < RELAY_LOG_THROTTLE_MS) return;
  logThrottleState.set(key, now);
  console[level](...args);
}

const METRICS_WINDOW_SECONDS = Math.max(10, Number(process.env.RELAY_METRICS_WINDOW_SECONDS || 60));
const relayMetricsBuckets = new Map(); // key: unix second -> rolling metrics bucket
const relayMetricsLifetime = {
  openskyRequests: 0,
  openskyCacheHit: 0,
  openskyNegativeHit: 0,
  openskyDedup: 0,
  openskyDedupNeg: 0,
  openskyDedupEmpty: 0,
  openskyMiss: 0,
  openskyUpstreamFetches: 0,
  drops: 0,
};
let relayMetricsQueueMaxLifetime = 0;
let relayMetricsCurrentSec = 0;
let relayMetricsCurrentBucket = null;
let relayMetricsLastPruneSec = 0;

function createRelayMetricsBucket() {
  return {
    openskyRequests: 0,
    openskyCacheHit: 0,
    openskyNegativeHit: 0,
    openskyDedup: 0,
    openskyDedupNeg: 0,
    openskyDedupEmpty: 0,
    openskyMiss: 0,
    openskyUpstreamFetches: 0,
    drops: 0,
    queueMax: 0,
  };
}

function getMetricsNowSec() {
  return Math.floor(Date.now() / 1000);
}

function pruneRelayMetricsBuckets(nowSec = getMetricsNowSec()) {
  const minSec = nowSec - METRICS_WINDOW_SECONDS + 1;
  for (const sec of relayMetricsBuckets.keys()) {
    if (sec < minSec) relayMetricsBuckets.delete(sec);
  }
  if (relayMetricsCurrentSec < minSec) {
    relayMetricsCurrentSec = 0;
    relayMetricsCurrentBucket = null;
  }
}

function getRelayMetricsBucket(nowSec = getMetricsNowSec()) {
  if (nowSec !== relayMetricsLastPruneSec) {
    pruneRelayMetricsBuckets(nowSec);
    relayMetricsLastPruneSec = nowSec;
  }

  if (relayMetricsCurrentBucket && relayMetricsCurrentSec === nowSec) {
    return relayMetricsCurrentBucket;
  }

  let bucket = relayMetricsBuckets.get(nowSec);
  if (!bucket) {
    bucket = createRelayMetricsBucket();
    relayMetricsBuckets.set(nowSec, bucket);
  }
  relayMetricsCurrentSec = nowSec;
  relayMetricsCurrentBucket = bucket;
  return bucket;
}

function incrementRelayMetric(field, amount = 1) {
  const bucket = getRelayMetricsBucket();
  bucket[field] = (bucket[field] || 0) + amount;
  if (Object.prototype.hasOwnProperty.call(relayMetricsLifetime, field)) {
    relayMetricsLifetime[field] += amount;
  }
}

function sampleRelayQueueSize(queueSize) {
  const bucket = getRelayMetricsBucket();
  if (queueSize > bucket.queueMax) bucket.queueMax = queueSize;
  if (queueSize > relayMetricsQueueMaxLifetime) relayMetricsQueueMaxLifetime = queueSize;
}

function safeRatio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function getRelayRollingMetrics() {
  const nowSec = getMetricsNowSec();
  const minSec = nowSec - METRICS_WINDOW_SECONDS + 1;
  pruneRelayMetricsBuckets(nowSec);

  const rollup = createRelayMetricsBucket();
  for (const [sec, bucket] of relayMetricsBuckets) {
    if (sec < minSec) continue;
    rollup.openskyRequests += bucket.openskyRequests;
    rollup.openskyCacheHit += bucket.openskyCacheHit;
    rollup.openskyNegativeHit += bucket.openskyNegativeHit;
    rollup.openskyDedup += bucket.openskyDedup;
    rollup.openskyDedupNeg += bucket.openskyDedupNeg;
    rollup.openskyDedupEmpty += bucket.openskyDedupEmpty;
    rollup.openskyMiss += bucket.openskyMiss;
    rollup.openskyUpstreamFetches += bucket.openskyUpstreamFetches;
    rollup.drops += bucket.drops;
    if (bucket.queueMax > rollup.queueMax) rollup.queueMax = bucket.queueMax;
  }

  const dedupCount = rollup.openskyDedup + rollup.openskyDedupNeg + rollup.openskyDedupEmpty;
  const cacheServedCount = rollup.openskyCacheHit + rollup.openskyNegativeHit + dedupCount;

  return {
    windowSeconds: METRICS_WINDOW_SECONDS,
    generatedAt: new Date().toISOString(),
    opensky: {
      requests: rollup.openskyRequests,
      hitRatio: safeRatio(cacheServedCount, rollup.openskyRequests),
      dedupRatio: safeRatio(dedupCount, rollup.openskyRequests),
      cacheHits: rollup.openskyCacheHit,
      negativeHits: rollup.openskyNegativeHit,
      dedupHits: dedupCount,
      misses: rollup.openskyMiss,
      upstreamFetches: rollup.openskyUpstreamFetches,
      global429CooldownRemainingMs: Math.max(0, openskyGlobal429Until - Date.now()),
      requestSpacingMs: OPENSKY_REQUEST_SPACING_MS,
    },
    ais: {
      queueMax: rollup.queueMax,
      currentQueue: getUpstreamQueueSize(),
      drops: rollup.drops,
      dropsPerSec: Number((rollup.drops / METRICS_WINDOW_SECONDS).toFixed(4)),
      upstreamPaused,
    },
    lifetime: {
      openskyRequests: relayMetricsLifetime.openskyRequests,
      openskyCacheHit: relayMetricsLifetime.openskyCacheHit,
      openskyNegativeHit: relayMetricsLifetime.openskyNegativeHit,
      openskyDedup: relayMetricsLifetime.openskyDedup + relayMetricsLifetime.openskyDedupNeg + relayMetricsLifetime.openskyDedupEmpty,
      openskyMiss: relayMetricsLifetime.openskyMiss,
      openskyUpstreamFetches: relayMetricsLifetime.openskyUpstreamFetches,
      drops: relayMetricsLifetime.drops,
      queueMax: relayMetricsQueueMaxLifetime,
    },
  };
}

// AIS aggregate state for snapshot API (server-side fanout)
const GRID_SIZE = 2;
const DENSITY_WINDOW = 30 * 60 * 1000; // 30 minutes
const GAP_THRESHOLD = 60 * 60 * 1000; // 1 hour
const SNAPSHOT_INTERVAL_MS = Math.max(2000, Number(process.env.AIS_SNAPSHOT_INTERVAL_MS || 5000));
const CANDIDATE_RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_DENSITY_ZONES = 200;
const MAX_CANDIDATE_REPORTS = 1500;

const vessels = new Map();
const vesselHistory = new Map();
const densityGrid = new Map();
const candidateReports = new Map();

let snapshotSequence = 0;
let lastSnapshot = null;
let lastSnapshotAt = 0;
// Pre-serialized cache: avoids JSON.stringify + gzip per request
let lastSnapshotJson = null;       // cached JSON string (no candidates)
let lastSnapshotGzip = null;       // cached gzip buffer (no candidates)
let lastSnapshotWithCandJson = null;
let lastSnapshotWithCandGzip = null;

// Chokepoint spatial index: bucket vessels into grid cells at ingest time
// instead of O(chokepoints * vessels) on every snapshot
const chokepointBuckets = new Map(); // key: gridKey -> Set of MMSI
const vesselChokepoints = new Map(); // key: MMSI -> Set of chokepoint names

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 2 },
  { name: 'Suez Canal', lat: 30.0, lon: 32.5, radius: 1 },
  { name: 'Strait of Malacca', lat: 2.5, lon: 101.5, radius: 2 },
  { name: 'Bab el-Mandeb', lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: 'Panama Canal', lat: 9.0, lon: -79.5, radius: 1 },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 2 },
  { name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 5 },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, radius: 3 },
  { name: 'Cape of Good Hope', lat: -34.36, lon: 18.49, radius: 2 },
  { name: 'Strait of Gibraltar', lat: 35.96, lon: -5.35, radius: 1 },
  { name: 'Bosporus Strait', lat: 40.70, lon: 28.0, radius: 1.5 },
  { name: 'Korea Strait', lat: 34.0, lon: 129.0, radius: 1.5 },
  { name: 'Dover Strait', lat: 51.05, lon: 1.45, radius: 0.5 },
  { name: 'Kerch Strait', lat: 45.33, lon: 36.60, radius: 0.5 },
  { name: 'Lombok Strait', lat: -8.47, lon: 115.72, radius: 0.5 },
];

function classifyVesselType(shipType) {
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  return 'other';
}

const chokepointCrossings = new Map();
const transitCooldowns = new Map();
const transitPendingEntry = new Map();
const TRANSIT_COOLDOWN_MS = 30 * 60 * 1000;
const TRANSIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_DWELL_MS = 5 * 60 * 1000;
const CHOKEPOINT_TRANSIT_KEY = 'supply_chain:chokepoint_transits:v1';
const CHOKEPOINT_TRANSIT_TTL = 900;
const CHOKEPOINT_TRANSIT_INTERVAL_MS = 10 * 60 * 1000;

const NAVAL_PREFIX_RE = /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI)/i;

function getGridKey(lat, lon) {
  const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
  const gridLon = Math.floor(lon / GRID_SIZE) * GRID_SIZE;
  return `${gridLat},${gridLon}`;
}

function isLikelyMilitaryCandidate(meta) {
  const mmsi = String(meta?.MMSI || '');
  const shipType = Number(meta?.ShipType);
  const name = (meta?.ShipName || '').trim().toUpperCase();

  if (Number.isFinite(shipType) && (shipType === 35 || shipType === 55 || (shipType >= 50 && shipType <= 59))) {
    return true;
  }

  if (name && NAVAL_PREFIX_RE.test(name)) return true;

  if (mmsi.length >= 9) {
    const suffix = mmsi.substring(3);
    if (suffix.startsWith('00') || suffix.startsWith('99')) return true;
  }

  return false;
}

function getUpstreamQueueSize() {
  return upstreamQueue.length - upstreamQueueReadIndex;
}

function enqueueUpstreamMessage(raw) {
  upstreamQueue.push(raw);
  sampleRelayQueueSize(getUpstreamQueueSize());
}

function dequeueUpstreamMessage() {
  if (upstreamQueueReadIndex >= upstreamQueue.length) return null;
  const raw = upstreamQueue[upstreamQueueReadIndex++];
  // Compact queue periodically to avoid unbounded sparse arrays.
  if (upstreamQueueReadIndex >= 1024 && upstreamQueueReadIndex * 2 >= upstreamQueue.length) {
    upstreamQueue = upstreamQueue.slice(upstreamQueueReadIndex);
    upstreamQueueReadIndex = 0;
  }
  return raw;
}

function clearUpstreamQueue() {
  upstreamQueue = [];
  upstreamQueueReadIndex = 0;
  upstreamDrainScheduled = false;
  sampleRelayQueueSize(0);
}

function evictMapByTimestamp(map, maxSize, getTimestamp) {
  if (map.size <= maxSize) return;
  const sorted = [...map.entries()].sort((a, b) => {
    const tsA = Number(getTimestamp(a[1])) || 0;
    const tsB = Number(getTimestamp(b[1])) || 0;
    return tsA - tsB;
  });
  const removeCount = map.size - maxSize;
  for (let i = 0; i < removeCount; i++) {
    map.delete(sorted[i][0]);
  }
}

function removeVesselFromChokepoints(mmsi) {
  const previous = vesselChokepoints.get(mmsi);
  if (!previous) return;

  for (const cpName of previous) {
    const bucket = chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  vesselChokepoints.delete(mmsi);
}

function updateVesselChokepoints(mmsi, lat, lon) {
  const next = new Set();
  for (const cp of CHOKEPOINTS) {
    const dlat = lat - cp.lat;
    const dlon = lon - cp.lon;
    if (dlat * dlat + dlon * dlon <= cp.radius * cp.radius) {
      next.add(cp.name);
    }
  }

  const previous = vesselChokepoints.get(mmsi) || new Set();
  const now = Date.now();

  for (const cpName of previous) {
    if (next.has(cpName)) continue;
    const bucket = chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) chokepointBuckets.delete(cpName);

    const pendingKey = mmsi + ':' + cpName;
    const entryTs = transitPendingEntry.get(pendingKey);
    if (entryTs !== undefined && now - entryTs >= MIN_DWELL_MS) {
      const cooldownKey = mmsi + ':' + cpName;
      const lastCrossing = transitCooldowns.get(cooldownKey);
      if (!lastCrossing || now - lastCrossing >= TRANSIT_COOLDOWN_MS) {
        const vessel = vessels.get(mmsi);
        const vType = classifyVesselType(vessel?.shipType);
        let crossings = chokepointCrossings.get(cpName);
        if (!crossings) { crossings = []; chokepointCrossings.set(cpName, crossings); }
        crossings.push({ mmsi, type: vType, ts: now });
        transitCooldowns.set(cooldownKey, now);
      }
    }
    transitPendingEntry.delete(pendingKey);
  }

  for (const cpName of next) {
    if (!previous.has(cpName)) {
      transitPendingEntry.set(mmsi + ':' + cpName, now);
    }
    let bucket = chokepointBuckets.get(cpName);
    if (!bucket) {
      bucket = new Set();
      chokepointBuckets.set(cpName, bucket);
    }
    bucket.add(mmsi);
  }

  if (next.size === 0) vesselChokepoints.delete(mmsi);
  else vesselChokepoints.set(mmsi, next);
}

function processRawUpstreamMessage(raw) {
  messageCount++;
  if (messageCount % 5000 === 0) {
    const mem = process.memoryUsage();
    console.log(`[Relay] ${messageCount} msgs, ${clients.size} ws-clients, ${vessels.size} vessels, queue=${getUpstreamQueueSize()}, dropped=${droppedMessages}, rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB, cache: opensky=${openskyResponseCache.size} opensky_neg=${openskyNegativeCache.size} rss_feed=${rssResponseCache.size} rss_backoff=${rssFailureCount.size}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.MessageType === 'PositionReport') {
      processPositionReportForSnapshot(parsed);
    }
  } catch {
    // Ignore malformed upstream payloads
  }

  // Heavily throttled WS fanout: every 50th message only
  // The app primarily uses HTTP snapshot polling, WS is for rare external consumers
  if (clients.size > 0 && messageCount % 50 === 0) {
    const message = raw.toString();
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        // Per-client backpressure: skip if client buffer is backed up
        if (client.bufferedAmount < 1024 * 1024) {
          client.send(message);
        }
      }
    }
  }
}

function processPositionReportForSnapshot(data) {
  const meta = data?.MetaData;
  const pos = data?.Message?.PositionReport;
  if (!meta || !pos) return;

  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return;

  const lat = Number.isFinite(pos.Latitude) ? pos.Latitude : meta.latitude;
  const lon = Number.isFinite(pos.Longitude) ? pos.Longitude : meta.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const now = Date.now();

  vessels.set(mmsi, {
    mmsi,
    name: meta.ShipName || '',
    lat,
    lon,
    timestamp: now,
    shipType: meta.ShipType,
    heading: pos.TrueHeading,
    speed: pos.Sog,
    course: pos.Cog,
  });

  const history = vesselHistory.get(mmsi) || [];
  history.push(now);
  if (history.length > 10) history.shift();
  vesselHistory.set(mmsi, history);

  const gridKey = getGridKey(lat, lon);
  let cell = densityGrid.get(gridKey);
  if (!cell) {
    cell = {
      lat: Math.floor(lat / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      lon: Math.floor(lon / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      vessels: new Set(),
      lastUpdate: now,
      previousCount: 0,
    };
    densityGrid.set(gridKey, cell);
  }
  cell.vessels.add(mmsi);
  cell.lastUpdate = now;

  // Maintain exact chokepoint membership so moving vessels don't get "stuck" in old buckets.
  updateVesselChokepoints(mmsi, lat, lon);

  if (isLikelyMilitaryCandidate(meta)) {
    candidateReports.set(mmsi, {
      mmsi,
      name: meta.ShipName || '',
      lat,
      lon,
      shipType: meta.ShipType,
      heading: pos.TrueHeading,
      speed: pos.Sog,
      course: pos.Cog,
      timestamp: now,
    });
  }
}

function cleanupAggregates() {
  const now = Date.now();
  const cutoff = now - DENSITY_WINDOW;

  for (const [mmsi, vessel] of vessels) {
    if (vessel.timestamp < cutoff) {
      vessels.delete(mmsi);
      removeVesselFromChokepoints(mmsi);
    }
  }
  // Hard cap: if still over limit, evict oldest
  if (vessels.size > MAX_VESSELS) {
    const sorted = [...vessels.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, vessels.size - MAX_VESSELS);
    for (const [mmsi] of toRemove) {
      vessels.delete(mmsi);
      removeVesselFromChokepoints(mmsi);
    }
  }

  for (const [mmsi, history] of vesselHistory) {
    const filtered = history.filter((ts) => ts >= cutoff);
    if (filtered.length === 0) {
      vesselHistory.delete(mmsi);
    } else {
      vesselHistory.set(mmsi, filtered);
    }
  }
  // Hard cap: keep the most recent vessel histories.
  evictMapByTimestamp(vesselHistory, MAX_VESSEL_HISTORY, (history) => history[history.length - 1] || 0);

  for (const [key, cell] of densityGrid) {
    cell.previousCount = cell.vessels.size;

    for (const mmsi of cell.vessels) {
      const vessel = vessels.get(mmsi);
      if (!vessel || vessel.timestamp < cutoff) {
        cell.vessels.delete(mmsi);
      }
    }

    if (cell.vessels.size === 0 && now - cell.lastUpdate > DENSITY_WINDOW * 2) {
      densityGrid.delete(key);
    }
  }
  // Hard cap: keep the most recently updated cells.
  evictMapByTimestamp(densityGrid, MAX_DENSITY_CELLS, (cell) => cell.lastUpdate || 0);

  for (const [mmsi, report] of candidateReports) {
    if (report.timestamp < now - CANDIDATE_RETENTION_MS) {
      candidateReports.delete(mmsi);
    }
  }
  // Hard cap: keep freshest candidate reports.
  evictMapByTimestamp(candidateReports, MAX_CANDIDATE_REPORTS, (report) => report.timestamp || 0);

  // Clean chokepoint buckets: remove stale vessels
  for (const [cpName, bucket] of chokepointBuckets) {
    for (const mmsi of bucket) {
      if (vessels.has(mmsi)) continue;
      bucket.delete(mmsi);
      const memberships = vesselChokepoints.get(mmsi);
      if (memberships) {
        memberships.delete(cpName);
        if (memberships.size === 0) vesselChokepoints.delete(mmsi);
      }
    }
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  for (const [cpName, crossings] of chokepointCrossings) {
    const filtered = crossings.filter(c => now - c.ts < TRANSIT_WINDOW_MS);
    if (filtered.length === 0) chokepointCrossings.delete(cpName);
    else chokepointCrossings.set(cpName, filtered);
  }
  for (const [key, ts] of transitCooldowns) {
    if (now - ts > TRANSIT_COOLDOWN_MS) transitCooldowns.delete(key);
  }
  const pendingCutoff = 48 * 60 * 60 * 1000;
  for (const [key, ts] of transitPendingEntry) {
    if (now - ts > pendingCutoff) {
      const sep = key.indexOf(':');
      const pmsi = key.substring(0, sep);
      const cpN = key.substring(sep + 1);
      const memberships = vesselChokepoints.get(pmsi);
      if (!memberships || !memberships.has(cpN)) transitPendingEntry.delete(key);
    }
  }
}

function detectDisruptions() {
  const disruptions = [];
  const now = Date.now();

  // O(chokepoints) using pre-built spatial buckets instead of O(chokepoints × vessels)
  for (const chokepoint of CHOKEPOINTS) {
    const bucket = chokepointBuckets.get(chokepoint.name);
    const vesselCount = bucket ? bucket.size : 0;

    if (vesselCount >= 5) {
      const normalTraffic = chokepoint.radius * 10;
      const severity = vesselCount > normalTraffic * 1.5
        ? 'high'
        : vesselCount > normalTraffic
          ? 'elevated'
          : 'low';

      disruptions.push({
        id: `chokepoint-${chokepoint.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: chokepoint.name,
        type: 'chokepoint_congestion',
        lat: chokepoint.lat,
        lon: chokepoint.lon,
        severity,
        changePct: normalTraffic > 0 ? Math.round((vesselCount / normalTraffic - 1) * 100) : 0,
        windowHours: 1,
        vesselCount,
        region: chokepoint.name,
        description: `${vesselCount} vessels in ${chokepoint.name}`,
      });
    }
  }

  let darkShipCount = 0;
  for (const history of vesselHistory.values()) {
    if (history.length >= 2) {
      const lastSeen = history[history.length - 1];
      const secondLast = history[history.length - 2];
      if (lastSeen - secondLast > GAP_THRESHOLD && now - lastSeen < 10 * 60 * 1000) {
        darkShipCount++;
      }
    }
  }

  if (darkShipCount >= 1) {
    disruptions.push({
      id: 'global-gap-spike',
      name: 'AIS Gap Spike Detected',
      type: 'gap_spike',
      lat: 0,
      lon: 0,
      severity: darkShipCount > 20 ? 'high' : darkShipCount > 10 ? 'elevated' : 'low',
      changePct: darkShipCount * 10,
      windowHours: 1,
      darkShips: darkShipCount,
      description: `${darkShipCount} vessels returned after extended AIS silence`,
    });
  }

  return disruptions;
}

function calculateDensityZones() {
  const zones = [];
  const allCells = Array.from(densityGrid.values()).filter((c) => c.vessels.size >= 2);
  if (allCells.length === 0) return zones;

  const vesselCounts = allCells.map((c) => c.vessels.size);
  const maxVessels = Math.max(...vesselCounts);
  const minVessels = Math.min(...vesselCounts);

  for (const [key, cell] of densityGrid) {
    if (cell.vessels.size < 2) continue;

    const logMax = Math.log(maxVessels + 1);
    const logMin = Math.log(minVessels + 1);
    const logCurrent = Math.log(cell.vessels.size + 1);

    const intensity = logMax > logMin
      ? 0.2 + (0.8 * (logCurrent - logMin) / (logMax - logMin))
      : 0.5;

    const deltaPct = cell.previousCount > 0
      ? Math.round(((cell.vessels.size - cell.previousCount) / cell.previousCount) * 100)
      : 0;

    zones.push({
      id: `density-${key}`,
      name: `Zone ${key}`,
      lat: cell.lat,
      lon: cell.lon,
      intensity,
      deltaPct,
      shipsPerDay: cell.vessels.size * 48,
      note: cell.vessels.size >= 10 ? 'High traffic area' : undefined,
    });
  }

  return zones
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, MAX_DENSITY_ZONES);
}

function getCandidateReportsSnapshot() {
  return Array.from(candidateReports.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_CANDIDATE_REPORTS);
}

function buildSnapshot() {
  const now = Date.now();
  if (lastSnapshot && now - lastSnapshotAt < Math.floor(SNAPSHOT_INTERVAL_MS / 2)) {
    return lastSnapshot;
  }

  cleanupAggregates();
  snapshotSequence++;

  lastSnapshot = {
    sequence: snapshotSequence,
    timestamp: new Date(now).toISOString(),
    status: {
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      vessels: vessels.size,
      messages: messageCount,
      clients: clients.size,
      droppedMessages,
    },
    disruptions: detectDisruptions(),
    density: calculateDensityZones(),
  };
  lastSnapshotAt = now;

  // Pre-serialize JSON once (avoid per-request JSON.stringify)
  const basePayload = { ...lastSnapshot, candidateReports: [] };
  lastSnapshotJson = JSON.stringify(basePayload);

  const withCandPayload = { ...lastSnapshot, candidateReports: getCandidateReportsSnapshot() };
  lastSnapshotWithCandJson = JSON.stringify(withCandPayload);

  // Pre-gzip both variants asynchronously (zero CPU on request path)
  zlib.gzip(Buffer.from(lastSnapshotJson), (err, buf) => {
    if (!err) lastSnapshotGzip = buf;
  });
  zlib.gzip(Buffer.from(lastSnapshotWithCandJson), (err, buf) => {
    if (!err) lastSnapshotWithCandGzip = buf;
  });

  return lastSnapshot;
}

setInterval(() => {
  if (upstreamSocket?.readyState === WebSocket.OPEN || vessels.size > 0) {
    buildSnapshot();
  }
}, SNAPSHOT_INTERVAL_MS);

async function seedChokepointTransits() {
  const now = Date.now();
  const transits = {};
  for (const cp of CHOKEPOINTS) {
    const crossings = chokepointCrossings.get(cp.name) || [];
    const recent = crossings.filter(c => now - c.ts < TRANSIT_WINDOW_MS);
    chokepointCrossings.set(cp.name, recent);
    transits[cp.name] = {
      tanker: recent.filter(c => c.type === 'tanker').length,
      cargo: recent.filter(c => c.type === 'cargo').length,
      other: recent.filter(c => c.type === 'other').length,
      total: recent.length,
    };
  }
  const payload = { transits, fetchedAt: now };
  await upstashSet(CHOKEPOINT_TRANSIT_KEY, payload, CHOKEPOINT_TRANSIT_TTL);
  await upstashSet('seed-meta:supply_chain:chokepoint_transits', { fetchedAt: now, recordCount: Object.keys(transits).length }, 604800);
  console.log(`[Transit] Seeded ${Object.keys(transits).length} chokepoint transit counts`);
}

setTimeout(() => {
  seedChokepointTransits().catch(err => console.error('[Transit] Initial seed error:', err.message));
}, 30_000);
setInterval(() => {
  seedChokepointTransits().catch(err => console.error('[Transit] Seed error:', err.message));
}, CHOKEPOINT_TRANSIT_INTERVAL_MS).unref?.();

// UCDP GED Events cache (persistent in-memory — Railway advantage)
const UCDP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const UCDP_RELAY_MAX_PAGES = 12;
const UCDP_FETCH_TIMEOUT = 30000; // 30s per page (no Railway limit)

let ucdpCache = { data: null, timestamp: 0 };
let ucdpFetchInProgress = false;

const UCDP_RELAY_VIOLENCE_TYPE_MAP = {
  1: 'state-based',
  2: 'non-state',
  3: 'one-sided',
};

function ucdpParseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function ucdpGetMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = ucdpParseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function ucdpBuildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}

async function ucdpRelayFetchPage(version, page) {
  const url = `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json' }, timeout: UCDP_FETCH_TIMEOUT }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`UCDP API ${res.statusCode} (v${version} p${page})`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('UCDP JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UCDP timeout')); });
  });
}

async function ucdpRelayDiscoverVersion() {
  const candidates = ucdpBuildVersionCandidates();
  for (const version of candidates) {
    try {
      const page0 = await ucdpRelayFetchPage(version, 0);
      if (Array.isArray(page0?.Result)) return { version, page0 };
    } catch { /* next candidate */ }
  }
  throw new Error('No valid UCDP GED version found');
}

async function ucdpFetchAllEvents() {
  const { version, page0 } = await ucdpRelayDiscoverVersion();
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;

  let allEvents = [];
  let latestDatasetMs = NaN;

  for (let offset = 0; offset < UCDP_RELAY_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    const rawData = page === 0 ? page0 : await ucdpRelayFetchPage(version, page);
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents = allEvents.concat(events);

    const pageMaxMs = ucdpGetMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
    if (Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      if (pageMaxMs < latestDatasetMs - UCDP_TRAILING_WINDOW_MS) break;
    }
    console.log(`[UCDP] Fetched v${version} page ${page} (${events.length} events)`);
  }

  const sanitized = allEvents
    .filter(e => {
      if (!Number.isFinite(latestDatasetMs)) return true;
      const ms = ucdpParseDateMs(e?.date_start);
      return Number.isFinite(ms) && ms >= (latestDatasetMs - UCDP_TRAILING_WINDOW_MS);
    })
    .map(e => ({
      id: String(e.id || ''),
      date_start: e.date_start || '',
      date_end: e.date_end || '',
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
      country: e.country || '',
      side_a: (e.side_a || '').substring(0, 200),
      side_b: (e.side_b || '').substring(0, 200),
      deaths_best: Number(e.best) || 0,
      deaths_low: Number(e.low) || 0,
      deaths_high: Number(e.high) || 0,
      type_of_violence: UCDP_RELAY_VIOLENCE_TYPE_MAP[e.type_of_violence] || 'state-based',
      source_original: (e.source_original || '').substring(0, 300),
    }))
    .sort((a, b) => {
      const bMs = ucdpParseDateMs(b.date_start);
      const aMs = ucdpParseDateMs(a.date_start);
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });

  return {
    success: true,
    count: sanitized.length,
    data: sanitized,
    version,
    cached_at: new Date().toISOString(),
  };
}

async function handleUcdpEventsRequest(req, res) {
  const now = Date.now();

  if (ucdpCache.data && now - ucdpCache.timestamp < UCDP_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'X-Cache': 'HIT',
    }, JSON.stringify(ucdpCache.data));
  }

  if (ucdpCache.data && !ucdpFetchInProgress) {
    ucdpFetchInProgress = true;
    ucdpFetchAllEvents()
      .then(result => {
        ucdpCache = { data: result, timestamp: Date.now() };
        console.log(`[UCDP] Background refresh: ${result.count} events (v${result.version})`);
      })
      .catch(err => console.error('[UCDP] Background refresh error:', err.message))
      .finally(() => { ucdpFetchInProgress = false; });

    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'CDN-Cache-Control': 'public, max-age=600',
      'X-Cache': 'STALE',
    }, JSON.stringify(ucdpCache.data));
  }

  if (ucdpFetchInProgress) {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, count: 0, data: [], cached_at: '', message: 'Fetch in progress' }));
  }

  try {
    ucdpFetchInProgress = true;
    console.log('[UCDP] Cold fetch starting...');
    const result = await ucdpFetchAllEvents();
    ucdpCache = { data: result, timestamp: Date.now() };
    ucdpFetchInProgress = false;
    console.log(`[UCDP] Cold fetch complete: ${result.count} events (v${result.version})`);

    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'X-Cache': 'MISS',
    }, JSON.stringify(result));
  } catch (err) {
    ucdpFetchInProgress = false;
    console.error('[UCDP] Fetch error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message, count: 0, data: [] }));
  }
}

// ── Response caches (eliminates ~1.2TB/day OpenSky + ~30GB/day RSS egress) ──
const openskyResponseCache = new Map(); // key: sorted query params → { data, gzip, timestamp }
const openskyNegativeCache = new Map(); // key: cacheKey → { status, timestamp, body, gzip } — prevents retry storms on 429/5xx
const openskyInFlight = new Map(); // key: cacheKey → Promise (dedup concurrent requests)
const OPENSKY_CACHE_TTL_MS = Number(process.env.OPENSKY_CACHE_TTL_MS) || 60 * 1000; // 60s default — env-configurable
const OPENSKY_NEGATIVE_CACHE_TTL_MS = Number(process.env.OPENSKY_NEGATIVE_CACHE_TTL_MS) || 30 * 1000; // 30s — env-configurable
const OPENSKY_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.OPENSKY_CACHE_MAX_ENTRIES || 128));
const OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES || 256));
const OPENSKY_BBOX_QUANT_STEP = Number.isFinite(Number(process.env.OPENSKY_BBOX_QUANT_STEP))
  ? Math.max(0, Number(process.env.OPENSKY_BBOX_QUANT_STEP)) : 0.01;
const OPENSKY_BBOX_DECIMALS = OPENSKY_BBOX_QUANT_STEP > 0
  ? Math.min(6, ((String(OPENSKY_BBOX_QUANT_STEP).split('.')[1] || '').length || 0))
  : 6;
const OPENSKY_DEDUP_EMPTY_RESPONSE_JSON = JSON.stringify({ states: [], time: 0 });
const OPENSKY_DEDUP_EMPTY_RESPONSE_GZIP = gzipSyncBuffer(OPENSKY_DEDUP_EMPTY_RESPONSE_JSON);
const rssResponseCache = new Map(); // key: feed URL → { data, contentType, timestamp, statusCode }
const rssInFlight = new Map(); // key: feed URL → Promise (dedup concurrent requests)
const rssFailureCount = new Map(); // key: feed URL → consecutive failure count (for exponential backoff)
const rssBackoffUntil = new Map(); // key: feed URL → timestamp when backoff expires
const RSS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — RSS feeds rarely update faster
const RSS_NEGATIVE_CACHE_TTL_MS = 60 * 1000; // 1 min base — scaled by 2^failures via backoff
const RSS_MAX_NEGATIVE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min cap — stop hammering broken feeds
const RSS_CACHE_MAX_ENTRIES = 200; // hard cap — ~20 allowed domains × ~5 paths max, with headroom

function rssRecordFailure(feedUrl) {
  const prev = rssFailureCount.get(feedUrl) || 0;
  const ttl = Math.min(RSS_NEGATIVE_CACHE_TTL_MS * Math.pow(2, prev), RSS_MAX_NEGATIVE_CACHE_TTL_MS);
  rssFailureCount.set(feedUrl, prev + 1);
  rssBackoffUntil.set(feedUrl, Date.now() + ttl);
  return { failures: prev + 1, backoffSec: Math.round(ttl / 1000) };
}

function rssResetFailure(feedUrl) {
  rssFailureCount.delete(feedUrl);
  rssBackoffUntil.delete(feedUrl);
}

function setBoundedCacheEntry(cache, key, value, maxEntries) {
  if (!cache.has(key) && cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function touchCacheEntry(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

function cacheOpenSkyPositive(cacheKey, data) {
  setBoundedCacheEntry(openskyResponseCache, cacheKey, {
    data,
    gzip: gzipSyncBuffer(data),
    timestamp: Date.now(),
  }, OPENSKY_CACHE_MAX_ENTRIES);
}

function cacheOpenSkyNegative(cacheKey, status) {
  const now = Date.now();
  const body = JSON.stringify({ states: [], time: now });
  setBoundedCacheEntry(openskyNegativeCache, cacheKey, {
    status,
    timestamp: now,
    body,
    gzip: gzipSyncBuffer(body),
  }, OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES);
}

function quantizeCoordinate(value) {
  if (!OPENSKY_BBOX_QUANT_STEP) return value;
  return Math.round(value / OPENSKY_BBOX_QUANT_STEP) * OPENSKY_BBOX_QUANT_STEP;
}

function formatCoordinate(value) {
  return Number(value.toFixed(OPENSKY_BBOX_DECIMALS)).toString();
}

function normalizeOpenSkyBbox(params) {
  const keys = ['lamin', 'lomin', 'lamax', 'lomax'];
  const hasAny = keys.some(k => params.has(k));
  if (!hasAny) {
    return { cacheKey: ',,,', queryParams: [] };
  }
  if (!keys.every(k => params.has(k))) {
    return { error: 'Provide all bbox params: lamin,lomin,lamax,lomax' };
  }

  const values = {};
  for (const key of keys) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return { error: `Invalid ${key} value` };
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return { error: `Invalid ${key} value` };
    values[key] = parsed;
  }

  if (values.lamin < -90 || values.lamax > 90 || values.lomin < -180 || values.lomax > 180) {
    return { error: 'Bbox out of range' };
  }
  if (values.lamin > values.lamax || values.lomin > values.lomax) {
    return { error: 'Invalid bbox ordering' };
  }

  const normalized = {};
  for (const key of keys) normalized[key] = formatCoordinate(quantizeCoordinate(values[key]));
  return {
    cacheKey: keys.map(k => normalized[k]).join(','),
    queryParams: keys.map(k => `${k}=${encodeURIComponent(normalized[k])}`),
  };
}

// OpenSky OAuth2 token cache + mutex to prevent thundering herd
let openskyToken = null;
let openskyTokenExpiry = 0;
let openskyTokenPromise = null; // mutex: single in-flight token request
let openskyAuthCooldownUntil = 0; // backoff after repeated failures
const OPENSKY_AUTH_COOLDOWN_MS = 60000; // 1 min cooldown after auth failure

// Global OpenSky rate limiter — serializes upstream requests and enforces 429 cooldown
let openskyGlobal429Until = 0; // timestamp: block ALL upstream requests until this time
const OPENSKY_429_COOLDOWN_MS = Number(process.env.OPENSKY_429_COOLDOWN_MS) || 90 * 1000; // 90s cooldown after any 429
const OPENSKY_REQUEST_SPACING_MS = Number(process.env.OPENSKY_REQUEST_SPACING_MS) || 2000; // 2s minimum between consecutive upstream requests
let openskyLastUpstreamTime = 0;
let openskyUpstreamQueue = Promise.resolve(); // serial chain — only 1 upstream request at a time

async function getOpenSkyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  // Return cached token if still valid (with 60s buffer)
  if (openskyToken && Date.now() < openskyTokenExpiry - 60000) {
    return openskyToken;
  }

  // Cooldown: don't retry auth if it recently failed (prevents stampede)
  if (Date.now() < openskyAuthCooldownUntil) {
    return null;
  }

  // Mutex: if a token fetch is already in flight, wait for it
  if (openskyTokenPromise) {
    return openskyTokenPromise;
  }

  openskyTokenPromise = _fetchOpenSkyToken(clientId, clientSecret);
  try {
    return await openskyTokenPromise;
  } finally {
    openskyTokenPromise = null;
  }
}

function _openskyProxyConnect(targetHost, targetPort, timeoutMs = 10000) {
  if (!OPENSKY_PROXY_ENABLED) return Promise.resolve(null);
  const atIdx = OPENSKY_PROXY_AUTH.lastIndexOf('@');
  if (atIdx === -1) return Promise.resolve(null);
  const userPass = OPENSKY_PROXY_AUTH.substring(0, atIdx);
  const hostPort = OPENSKY_PROXY_AUTH.substring(atIdx + 1);
  const colonIdx = hostPort.lastIndexOf(':');
  const proxyHost = hostPort.substring(0, colonIdx);
  const proxyPort = parseInt(hostPort.substring(colonIdx + 1), 10);

  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: {
        'Host': `${targetHost}:${targetPort}`,
        'Proxy-Authorization': 'Basic ' + Buffer.from(userPass).toString('base64'),
      },
      timeout: timeoutMs,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return reject(new Error(`CONNECT ${res.statusCode}`));
      }
      const tls = require('tls');
      const tlsSocket = tls.connect({ socket, servername: targetHost }, () => {
        resolve(tlsSocket);
      });
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('CONNECT timeout')); });
    connectReq.end();
  });
}

function _attemptOpenSkyTokenFetch(clientId, clientSecret) {
  const postData = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const reqHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData),
    'User-Agent': 'WorldMonitor/1.0',
  };

  if (OPENSKY_PROXY_ENABLED) {
    return _openskyProxyConnect('auth.opensky-network.org', 443).then((tlsSocket) => {
      return new Promise((resolve) => {
        const req = https.request({
          socket: tlsSocket,
          hostname: 'auth.opensky-network.org',
          path: '/auth/realms/opensky-network/protocol/openid-connect/token',
          method: 'POST',
          headers: reqHeaders,
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.access_token) {
                resolve({ token: json.access_token, expiresIn: json.expires_in || 1800 });
              } else {
                resolve({ error: json.error || 'no_access_token', status: res.statusCode });
              }
            } catch (e) {
              resolve({ error: `parse: ${e.message}`, status: res.statusCode });
            }
          });
        });
        req.on('error', (err) => resolve({ error: `${err.code || 'UNKNOWN'}: ${err.message}` }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
        req.write(postData);
        req.end();
      });
    }).catch((err) => ({ error: `PROXY: ${err.message}` }));
  }

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'auth.opensky-network.org',
      port: 443,
      family: 4,
      path: '/auth/realms/opensky-network/protocol/openid-connect/token',
      method: 'POST',
      headers: reqHeaders,
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve({ token: json.access_token, expiresIn: json.expires_in || 1800 });
          } else {
            resolve({ error: json.error || 'no_access_token', status: res.statusCode });
          }
        } catch (e) {
          resolve({ error: `parse: ${e.message}`, status: res.statusCode });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: `${err.code || 'UNKNOWN'}: ${err.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'TIMEOUT' });
    });

    req.write(postData);
    req.end();
  });
}

const OPENSKY_AUTH_MAX_RETRIES = 3;
const OPENSKY_AUTH_RETRY_DELAYS = [0, 2000, 5000];

async function _fetchOpenSkyToken(clientId, clientSecret) {
  try {
    for (let attempt = 0; attempt < OPENSKY_AUTH_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = OPENSKY_AUTH_RETRY_DELAYS[attempt] || 5000;
        console.log(`[Relay] OpenSky auth retry ${attempt + 1}/${OPENSKY_AUTH_MAX_RETRIES} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.log('[Relay] Fetching new OpenSky OAuth2 token...');
      }

      const result = await _attemptOpenSkyTokenFetch(clientId, clientSecret);
      if (result.token) {
        openskyToken = result.token;
        openskyTokenExpiry = Date.now() + result.expiresIn * 1000;
        console.log('[Relay] OpenSky token acquired, expires in', result.expiresIn, 'seconds');
        return openskyToken;
      }
      console.error(`[Relay] OpenSky auth attempt ${attempt + 1} failed:`, result.error, result.status ? `(HTTP ${result.status})` : '');
    }

    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    console.warn(`[Relay] OpenSky auth failed after ${OPENSKY_AUTH_MAX_RETRIES} attempts, cooling down for ${OPENSKY_AUTH_COOLDOWN_MS / 1000}s`);
    return null;
  } catch (err) {
    console.error('[Relay] OpenSky token error:', err.message);
    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    return null;
  }
}

// Promisified upstream OpenSky fetch (single request)
function _openskyRawFetch(url, token) {
  const parsed = new URL(url);
  const reqHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'WorldMonitor/1.0',
    'Authorization': `Bearer ${token}`,
  };

  if (OPENSKY_PROXY_ENABLED) {
    return _openskyProxyConnect(parsed.hostname, 443, 15000).then((tlsSocket) => {
      return new Promise((resolve) => {
        const request = https.get({
          socket: tlsSocket,
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: reqHeaders,
          timeout: 15000,
        }, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => resolve({ status: response.statusCode || 502, data }));
        });
        request.on('error', (err) => resolve({ status: 0, data: null, error: err }));
        request.on('timeout', () => { request.destroy(); resolve({ status: 504, data: null, error: new Error('timeout') }); });
      });
    }).catch((err) => ({ status: 0, data: null, error: new Error(`PROXY: ${err.message}`) }));
  }

  return new Promise((resolve) => {
    const request = https.get(url, {
      family: 4,
      headers: reqHeaders,
      timeout: 15000,
    }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve({ status: response.statusCode || 502, data }));
    });
    request.on('error', (err) => resolve({ status: 0, data: null, error: err }));
    request.on('timeout', () => { request.destroy(); resolve({ status: 504, data: null, error: new Error('timeout') }); });
  });
}

// Serialized queue — ensures only 1 upstream request at a time with minimum spacing.
// Prevents 5 concurrent bbox queries from all getting 429'd.
function openskyQueuedFetch(url, token) {
  const job = openskyUpstreamQueue.then(async () => {
    if (Date.now() < openskyGlobal429Until) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    const wait = OPENSKY_REQUEST_SPACING_MS - (Date.now() - openskyLastUpstreamTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (Date.now() < openskyGlobal429Until) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    openskyLastUpstreamTime = Date.now();
    return _openskyRawFetch(url, token);
  });
  openskyUpstreamQueue = job.catch(() => {});
  return job;
}

async function handleOpenSkyRequest(req, res, PORT) {
  let cacheKey = '';
  let settleFlight = null;
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const params = url.searchParams;
    const normalizedBbox = normalizeOpenSkyBbox(params);
    if (normalizedBbox.error) {
      return safeEnd(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({
        error: normalizedBbox.error,
        time: Date.now(),
        states: [],
      }));
    }

    cacheKey = normalizedBbox.cacheKey;
    incrementRelayMetric('openskyRequests');

    // 1. Check positive cache (30s TTL)
    const cached = openskyResponseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OPENSKY_CACHE_TTL_MS) {
      incrementRelayMetric('openskyCacheHit');
      touchCacheEntry(openskyResponseCache, cacheKey, cached); // LRU
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
        'CDN-Cache-Control': 'public, max-age=15',
        'X-Cache': 'HIT',
      }, cached.data, cached.gzip);
    }

    // 2. Check negative cache — prevents retry storms when upstream returns 429/5xx
    const negCached = openskyNegativeCache.get(cacheKey);
    if (negCached && Date.now() - negCached.timestamp < OPENSKY_NEGATIVE_CACHE_TTL_MS) {
      incrementRelayMetric('openskyNegativeHit');
      touchCacheEntry(openskyNegativeCache, cacheKey, negCached); // LRU
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'NEG',
      }, negCached.body, negCached.gzip);
    }

    // 2b. Global 429 cooldown — blocks ALL bbox queries when OpenSky is rate-limiting.
    //     Without this, 5 unique bbox keys all fire simultaneously when neg cache expires,
    //     ALL get 429'd, and the cycle repeats forever with zero data flowing.
    if (Date.now() < openskyGlobal429Until) {
      incrementRelayMetric('openskyNegativeHit');
      cacheOpenSkyNegative(cacheKey, 429);
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'RATE-LIMITED',
      }, JSON.stringify({ states: [], time: Date.now() }));
    }

    // 3. Dedup concurrent requests — await in-flight and return result OR empty (never fall through)
    const existing = openskyInFlight.get(cacheKey);
    if (existing) {
      try {
        await existing;
      } catch { /* in-flight failed */ }
      const deduped = openskyResponseCache.get(cacheKey);
      if (deduped && Date.now() - deduped.timestamp < OPENSKY_CACHE_TTL_MS) {
        incrementRelayMetric('openskyDedup');
        touchCacheEntry(openskyResponseCache, cacheKey, deduped); // LRU
        return sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
          'CDN-Cache-Control': 'public, max-age=15',
          'X-Cache': 'DEDUP',
        }, deduped.data, deduped.gzip);
      }
      const dedupNeg = openskyNegativeCache.get(cacheKey);
      if (dedupNeg && Date.now() - dedupNeg.timestamp < OPENSKY_NEGATIVE_CACHE_TTL_MS) {
        incrementRelayMetric('openskyDedupNeg');
        touchCacheEntry(openskyNegativeCache, cacheKey, dedupNeg); // LRU
        return sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'CDN-Cache-Control': 'no-store',
          'X-Cache': 'DEDUP-NEG',
        }, dedupNeg.body, dedupNeg.gzip);
      }
      // In-flight completed but no cache entry (upstream failed) — return empty instead of thundering herd
      incrementRelayMetric('openskyDedupEmpty');
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'DEDUP-EMPTY',
      }, OPENSKY_DEDUP_EMPTY_RESPONSE_JSON, OPENSKY_DEDUP_EMPTY_RESPONSE_GZIP);
    }

    incrementRelayMetric('openskyMiss');

    // 4. Set in-flight BEFORE async token fetch to prevent race window
    let resolveFlight;
    let flightSettled = false;
    const flightPromise = new Promise((resolve) => { resolveFlight = resolve; });
    settleFlight = () => {
      if (flightSettled) return;
      flightSettled = true;
      resolveFlight();
    };
    openskyInFlight.set(cacheKey, flightPromise);

    const token = await getOpenSkyToken();
    if (!token) {
      // Do NOT negative-cache auth failures — they poison ALL bbox keys.
      // Only negative-cache actual upstream 429/5xx responses.
      settleFlight();
      openskyInFlight.delete(cacheKey);
      return safeEnd(res, 503, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'OpenSky not configured or auth failed', time: Date.now(), states: [] }));
    }

    let openskyUrl = 'https://opensky-network.org/api/states/all';
    if (normalizedBbox.queryParams.length > 0) {
      openskyUrl += '?' + normalizedBbox.queryParams.join('&');
    }

    logThrottled('log', `opensky-miss:${cacheKey}`, '[Relay] OpenSky request (MISS):', openskyUrl);
    incrementRelayMetric('openskyUpstreamFetches');

    // Serialized fetch — queued with spacing to prevent concurrent 429 storms
    const result = await openskyQueuedFetch(openskyUrl, token);
    const upstreamStatus = result.status || 502;

    if (upstreamStatus === 401) {
      openskyToken = null;
      openskyTokenExpiry = 0;
    }

    if (upstreamStatus === 429 && !result.rateLimited) {
      openskyGlobal429Until = Date.now() + OPENSKY_429_COOLDOWN_MS;
      console.warn(`[Relay] OpenSky 429 — global cooldown ${OPENSKY_429_COOLDOWN_MS / 1000}s (all bbox queries blocked)`);
    }

    if (upstreamStatus === 200 && result.data) {
      cacheOpenSkyPositive(cacheKey, result.data);
      openskyNegativeCache.delete(cacheKey);
    } else if (result.error) {
      logThrottled('error', `opensky-error:${cacheKey}:${result.error.code || result.error.message}`, '[Relay] OpenSky error:', result.error.message);
      cacheOpenSkyNegative(cacheKey, upstreamStatus || 500);
    } else {
      cacheOpenSkyNegative(cacheKey, upstreamStatus);
      logThrottled('warn', `opensky-upstream-${upstreamStatus}:${cacheKey}`,
        `[Relay] OpenSky upstream ${upstreamStatus} for ${openskyUrl}, negative-cached for ${OPENSKY_NEGATIVE_CACHE_TTL_MS / 1000}s`);
    }

    settleFlight();
    openskyInFlight.delete(cacheKey);

    // Serve stale cache on network errors
    if (result.error && cached) {
      return sendPreGzipped(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, cached.data, cached.gzip);
    }

    const responseData = result.data || JSON.stringify({ error: result.error?.message || 'upstream error', time: Date.now(), states: null });
    return sendCompressed(req, res, upstreamStatus, {
      'Content-Type': 'application/json',
      'Cache-Control': upstreamStatus === 200 ? 'public, max-age=30' : 'no-cache',
      'CDN-Cache-Control': upstreamStatus === 200 ? 'public, max-age=15' : 'no-store',
      'X-Cache': result.rateLimited ? 'RATE-LIMITED' : 'MISS',
    }, responseData);
  } catch (err) {
    if (settleFlight) settleFlight();
    if (!cacheKey) {
      try {
        const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        cacheKey = normalizeOpenSkyBbox(params).cacheKey || ',,,';
      } catch {
        cacheKey = ',,,';
      }
    }
    openskyInFlight.delete(cacheKey);
    safeEnd(res, 500, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: err.message, time: Date.now(), states: null }));
  }
}

// ── World Bank proxy (World Bank blocks Vercel edge IPs with 403) ──
const worldbankCache = new Map(); // key: query string → { data, timestamp }
const WORLDBANK_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — data rarely changes

function handleWorldBankRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qs = url.search || '';
  const cacheKey = qs;

  const cached = worldbankCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < WORLDBANK_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800',
      'CDN-Cache-Control': 'public, max-age=1800',
      'X-Cache': 'HIT',
    }, cached.data);
  }

  const targetUrl = `https://api.worldbank.org/v2${qs.includes('action=indicators') ? '' : '/country'}${url.pathname.replace('/worldbank', '')}${qs}`;
  // Passthrough: forward query params to the Vercel edge handler format
  // The client sends the same params as /api/worldbank, so we re-fetch from upstream
  const wbParams = new URLSearchParams(url.searchParams);
  const action = wbParams.get('action');

  if (action === 'indicators') {
    // Static response — return indicator list directly (same as api/worldbank.js)
    const indicators = {
      'IT.NET.USER.ZS': 'Internet Users (% of population)',
      'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
      'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
      'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
      'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
      'IP.PAT.RESD': 'Patent Applications (residents)',
      'IP.PAT.NRES': 'Patent Applications (non-residents)',
      'IP.TMK.TOTL': 'Trademark Applications',
      'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
      'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
      'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
      'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
      'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
      'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
      'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
      'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
    };
    const defaultCountries = [
      'USA','CHN','JPN','DEU','KOR','GBR','IND','ISR','SGP','TWN',
      'FRA','CAN','SWE','NLD','CHE','FIN','IRL','AUS','BRA','IDN',
      'ARE','SAU','QAT','BHR','EGY','TUR','MYS','THA','VNM','PHL',
      'ESP','ITA','POL','CZE','DNK','NOR','AUT','BEL','PRT','EST',
      'MEX','ARG','CHL','COL','ZAF','NGA','KEN',
    ];
    const body = JSON.stringify({ indicators, defaultCountries });
    worldbankCache.set(cacheKey, { data: body, timestamp: Date.now() });
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
      'CDN-Cache-Control': 'public, max-age=86400',
      'X-Cache': 'MISS',
    }, body);
  }

  const indicator = wbParams.get('indicator');
  if (!indicator) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing indicator parameter' }));
  }

  const country = wbParams.get('country');
  const countries = wbParams.get('countries');
  const years = parseInt(wbParams.get('years') || '5', 10);
  let countryList = country || (countries ? countries.split(',').join(';') : [
    'USA','CHN','JPN','DEU','KOR','GBR','IND','ISR','SGP','TWN',
    'FRA','CAN','SWE','NLD','CHE','FIN','IRL','AUS','BRA','IDN',
    'ARE','SAU','QAT','BHR','EGY','TUR','MYS','THA','VNM','PHL',
    'ESP','ITA','POL','CZE','DNK','NOR','AUT','BEL','PRT','EST',
    'MEX','ARG','CHL','COL','ZAF','NGA','KEN',
  ].join(';'));

  const currentYear = new Date().getFullYear();
  const startYear = currentYear - years;
  const TECH_INDICATORS = {
    'IT.NET.USER.ZS': 'Internet Users (% of population)',
    'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
    'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
    'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
    'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
    'IP.PAT.RESD': 'Patent Applications (residents)',
    'IP.PAT.NRES': 'Patent Applications (non-residents)',
    'IP.TMK.TOTL': 'Trademark Applications',
    'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
    'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
    'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
    'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
    'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
    'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
    'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
    'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
  };

  const wbUrl = `https://api.worldbank.org/v2/country/${countryList}/indicator/${encodeURIComponent(indicator)}?format=json&date=${startYear}:${currentYear}&per_page=1000`;

  console.log('[Relay] World Bank request (MISS):', indicator);

  const request = https.get(wbUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0; +https://worldmonitor.app)',
    },
    timeout: 15000,
  }, (response) => {
    if (response.statusCode !== 200) {
      safeEnd(res, response.statusCode, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `World Bank API ${response.statusCode}` }));
      return;
    }
    let rawData = '';
    response.on('data', chunk => rawData += chunk);
    response.on('end', () => {
      try {
        const parsed = JSON.parse(rawData);
        // Transform raw World Bank response to match client-expected format
        if (!parsed || !Array.isArray(parsed) || parsed.length < 2 || !parsed[1]) {
          const empty = JSON.stringify({
            indicator,
            indicatorName: TECH_INDICATORS[indicator] || indicator,
            metadata: { page: 1, pages: 1, total: 0 },
            byCountry: {}, latestByCountry: {}, timeSeries: [],
          });
          worldbankCache.set(cacheKey, { data: empty, timestamp: Date.now() });
          return sendCompressed(req, res, 200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800',
            'CDN-Cache-Control': 'public, max-age=1800',
            'X-Cache': 'MISS',
          }, empty);
        }

        const [metadata, records] = parsed;
        const transformed = {
          indicator,
          indicatorName: TECH_INDICATORS[indicator] || (records[0]?.indicator?.value || indicator),
          metadata: { page: metadata.page, pages: metadata.pages, total: metadata.total },
          byCountry: {}, latestByCountry: {}, timeSeries: [],
        };

        for (const record of records || []) {
          const cc = record.countryiso3code || record.country?.id;
          const cn = record.country?.value;
          const yr = record.date;
          const val = record.value;
          if (!cc || val === null) continue;
          if (!transformed.byCountry[cc]) transformed.byCountry[cc] = { code: cc, name: cn, values: [] };
          transformed.byCountry[cc].values.push({ year: yr, value: val });
          if (!transformed.latestByCountry[cc] || yr > transformed.latestByCountry[cc].year) {
            transformed.latestByCountry[cc] = { code: cc, name: cn, year: yr, value: val };
          }
          transformed.timeSeries.push({ countryCode: cc, countryName: cn, year: yr, value: val });
        }
        for (const c of Object.values(transformed.byCountry)) c.values.sort((a, b) => a.year - b.year);
        transformed.timeSeries.sort((a, b) => b.year - a.year || a.countryCode.localeCompare(b.countryCode));

        const body = JSON.stringify(transformed);
        worldbankCache.set(cacheKey, { data: body, timestamp: Date.now() });
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800',
          'CDN-Cache-Control': 'public, max-age=1800',
          'X-Cache': 'MISS',
        }, body);
      } catch (e) {
        console.error('[Relay] World Bank parse error:', e.message);
        safeEnd(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Parse error' }));
      }
    });
  });
  request.on('error', (err) => {
    console.error('[Relay] World Bank error:', err.message);
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
      }, cached.data);
    }
    safeEnd(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err.message }));
  });
  request.on('timeout', () => {
    request.destroy();
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
      }, cached.data);
    }
    safeEnd(res, 504, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'World Bank request timeout' }));
  });
}

// ── Polymarket proxy (Cloudflare JA3 blocks Vercel edge runtime) ──
const POLYMARKET_ENABLED = String(process.env.POLYMARKET_ENABLED || 'true').toLowerCase() !== 'false';
const polymarketCache = new Map(); // key: query string → { data, timestamp }
const polymarketInflight = new Map(); // key → Promise (dedup concurrent requests)
const POLYMARKET_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min — reduce upstream pressure
const POLYMARKET_NEG_TTL_MS = 5 * 60 * 1000; // 5 min negative cache on 429/error

// Circuit breaker — stops upstream requests after repeated failures to prevent OOM
const polymarketCircuitBreaker = { failures: 0, openUntil: 0 };
const POLYMARKET_CB_THRESHOLD = 5;
const POLYMARKET_CB_COOLDOWN_MS = 60 * 1000;

// Concurrent upstream limiter — queues excess requests instead of rejecting them
const POLYMARKET_MAX_CONCURRENT = 3;
const POLYMARKET_MAX_QUEUED = 20;
let polymarketActiveUpstream = 0;
const polymarketQueue = []; // Array of () => void (resolve-waiters)

function tripPolymarketCircuitBreaker() {
  polymarketCircuitBreaker.failures++;
  if (polymarketCircuitBreaker.failures >= POLYMARKET_CB_THRESHOLD) {
    polymarketCircuitBreaker.openUntil = Date.now() + POLYMARKET_CB_COOLDOWN_MS;
    console.error(`[Relay] Polymarket circuit OPEN — cooling down ${POLYMARKET_CB_COOLDOWN_MS / 1000}s`);
  }
}

function releasePolymarketSlot() {
  polymarketActiveUpstream--;
  if (polymarketQueue.length > 0) {
    const next = polymarketQueue.shift();
    polymarketActiveUpstream++;
    next();
  }
}

function acquirePolymarketSlot() {
  if (polymarketActiveUpstream < POLYMARKET_MAX_CONCURRENT) {
    polymarketActiveUpstream++;
    return Promise.resolve();
  }
  if (polymarketQueue.length >= POLYMARKET_MAX_QUEUED) {
    return Promise.reject(new Error('queue full'));
  }
  return new Promise((resolve) => { polymarketQueue.push(resolve); });
}

function fetchPolymarketUpstream(cacheKey, endpoint, params, tag) {
  return acquirePolymarketSlot().catch(() => 'REJECTED').then((slotResult) => {
    if (slotResult === 'REJECTED') {
      polymarketCache.set(cacheKey, { data: '[]', timestamp: Date.now() - POLYMARKET_CACHE_TTL_MS + POLYMARKET_NEG_TTL_MS });
      return null;
    }
    const gammaUrl = `https://gamma-api.polymarket.com/${endpoint}?${params}`;
    console.log('[Relay] Polymarket request (MISS):', endpoint, tag || '');

    return new Promise((resolve) => {
      let finalized = false;
      function finalize(ok) {
        if (finalized) return;
        finalized = true;
        releasePolymarketSlot();
        if (ok) {
          polymarketCircuitBreaker.failures = 0;
        } else {
          tripPolymarketCircuitBreaker();
          polymarketCache.set(cacheKey, { data: '[]', timestamp: Date.now() - POLYMARKET_CACHE_TTL_MS + POLYMARKET_NEG_TTL_MS });
        }
      }
      const request = https.get(gammaUrl, {
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
      }, (response) => {
        if (response.statusCode !== 200) {
          console.error(`[Relay] Polymarket upstream ${response.statusCode} (failures: ${polymarketCircuitBreaker.failures + 1})`);
          response.resume();
          finalize(false);
          resolve(null);
          return;
        }
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          finalize(true);
          polymarketCache.set(cacheKey, { data, timestamp: Date.now() });
          resolve(data);
        });
        response.on('error', () => { finalize(false); resolve(null); });
      });
      request.on('error', (err) => {
        console.error('[Relay] Polymarket error:', err.message);
        finalize(false);
        resolve(null);
      });
      request.on('timeout', () => {
        request.destroy();
        finalize(false);
        resolve(null);
      });
    });
  });
}

function handlePolymarketRequest(req, res) {
  if (!POLYMARKET_ENABLED) {
    return sendCompressed(req, res, 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }, JSON.stringify({ error: 'polymarket disabled', reason: 'POLYMARKET_ENABLED=false' }));
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Build canonical params FIRST so cache key is deterministic regardless of
  // query-string ordering, tag vs tag_slug alias, or varying limit values.
  // Cache key excludes limit — always fetch upstream with limit=50, slice on serve.
  // This prevents cache fragmentation from different callers (limit=20 vs limit=30).
  const endpoint = url.searchParams.get('endpoint') || 'markets';
  const requestedLimit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const upstreamLimit = 50; // canonical upstream limit for cache sharing
  const params = new URLSearchParams();
  params.set('closed', url.searchParams.get('closed') || 'false');
  params.set('order', url.searchParams.get('order') || 'volume');
  params.set('ascending', url.searchParams.get('ascending') || 'false');
  params.set('limit', String(upstreamLimit));
  const tag = url.searchParams.get('tag') || url.searchParams.get('tag_slug');
  if (tag && endpoint === 'events') params.set('tag_slug', tag.replace(/[^a-z0-9-]/gi, '').slice(0, 100));

  const cacheKey = endpoint + ':' + params.toString();

  function sliceToLimit(jsonStr) {
    if (requestedLimit >= upstreamLimit) return jsonStr;
    try {
      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) return jsonStr;
      return JSON.stringify(arr.slice(0, requestedLimit));
    } catch { return jsonStr; }
  }

  const cached = polymarketCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < POLYMARKET_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'CDN-Cache-Control': 'public, max-age=600',
      'X-Cache': 'HIT',
      'X-Polymarket-Source': 'railway-cache',
    }, sliceToLimit(cached.data));
  }

  // Circuit breaker open — serve stale cache or empty, skip upstream
  if (Date.now() < polymarketCircuitBreaker.openUntil) {
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Cache': 'STALE',
        'X-Circuit': 'OPEN',
        'X-Polymarket-Source': 'railway-stale',
      }, cached.data);
    }
    return safeEnd(res, 200, { 'Content-Type': 'application/json', 'X-Circuit': 'OPEN' }, JSON.stringify([]));
  }

  let inflight = polymarketInflight.get(cacheKey);
  if (!inflight) {
    inflight = fetchPolymarketUpstream(cacheKey, endpoint, params, tag).finally(() => {
      polymarketInflight.delete(cacheKey);
    });
    polymarketInflight.set(cacheKey, inflight);
  }

  inflight.then((data) => {
    if (data) {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600',
        'CDN-Cache-Control': 'public, max-age=600',
        'X-Cache': 'MISS',
        'X-Polymarket-Source': 'railway',
      }, sliceToLimit(data));
    } else if (cached) {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
        'X-Polymarket-Source': 'railway-stale',
      }, sliceToLimit(cached.data));
    } else {
      safeEnd(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify([]));
    }
  });
}

// Periodic cache cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of openskyResponseCache) {
    if (now - entry.timestamp > OPENSKY_CACHE_TTL_MS * 2) openskyResponseCache.delete(key);
  }
  for (const [key, entry] of openskyNegativeCache) {
    if (now - entry.timestamp > OPENSKY_NEGATIVE_CACHE_TTL_MS * 2) openskyNegativeCache.delete(key);
  }
  for (const [key, entry] of rssResponseCache) {
    if (now - entry.timestamp > RSS_CACHE_TTL_MS * 2) rssResponseCache.delete(key);
  }
  for (const [key, expiry] of rssBackoffUntil) {
    // Only clear backoff timer on expiry — preserve failureCount so
    // the next failure re-escalates immediately instead of resetting to 1min
    if (now > expiry) rssBackoffUntil.delete(key);
  }
  // Clean up failure counts when no backoff is active AND no cache entry exists.
  // Edge case: if cache is evicted (FIFO/age) right when backoff expires, failureCount
  // resets — next failure starts at 1min instead of re-escalating. Window is ~60s, acceptable.
  for (const key of rssFailureCount.keys()) {
    if (!rssBackoffUntil.has(key) && !rssResponseCache.has(key)) rssFailureCount.delete(key);
  }
  for (const [key, entry] of worldbankCache) {
    if (now - entry.timestamp > WORLDBANK_CACHE_TTL_MS * 2) worldbankCache.delete(key);
  }
  for (const [key, entry] of polymarketCache) {
    if (now - entry.timestamp > POLYMARKET_CACHE_TTL_MS * 2) polymarketCache.delete(key);
  }
  for (const [key, entry] of yahooChartCache) {
    if (now - entry.ts > YAHOO_CHART_CACHE_TTL_MS * 2) yahooChartCache.delete(key);
  }
  for (const [key, bucket] of requestRateBuckets) {
    if (now >= bucket.resetAt + RELAY_RATE_LIMIT_WINDOW_MS * 2) requestRateBuckets.delete(key);
  }
  for (const [key, ts] of logThrottleState) {
    if (now - ts > RELAY_LOG_THROTTLE_MS * 6) logThrottleState.delete(key);
  }
}, 60 * 1000);

// ── Yahoo Finance Chart Proxy ──────────────────────────────────────
const YAHOO_CHART_CACHE_TTL_MS = 300_000; // 5 min
const yahooChartCache = new Map(); // key: symbol:range:interval → { json, gzip, ts }
const YAHOO_SYMBOL_RE = /^[A-Za-z0-9^=\-\.]{1,15}$/;

function handleYahooChartRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const symbol = url.searchParams.get('symbol');
  const range = url.searchParams.get('range') || '1d';
  const interval = url.searchParams.get('interval') || '1d';

  if (!symbol || !YAHOO_SYMBOL_RE.test(symbol)) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Invalid or missing symbol parameter' }));
  }

  const cacheKey = `${symbol}:${range}:${interval}`;
  const cached = yahooChartCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < YAHOO_CHART_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
      'X-Yahoo-Source': 'relay-cache',
    }, cached.json);
  }

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
  const yahooReq = https.get(yahooUrl, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'application/json',
    },
    timeout: 10000,
  }, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => { body += chunk; });
    upstream.on('end', () => {
      if (upstream.statusCode !== 200) {
        logThrottled('warn', `yahoo-chart-upstream-${upstream.statusCode}:${symbol}`,
          `[Relay] Yahoo chart upstream ${upstream.statusCode} for ${symbol}`);
        return sendCompressed(req, res, upstream.statusCode || 502, {
          'Content-Type': 'application/json',
          'X-Yahoo-Source': 'relay-upstream-error',
        }, JSON.stringify({ error: `Yahoo upstream ${upstream.statusCode}`, symbol }));
      }
      yahooChartCache.set(cacheKey, { json: body, ts: Date.now() });
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
        'X-Yahoo-Source': 'relay-upstream',
      }, body);
    });
  });
  yahooReq.on('error', (err) => {
    logThrottled('error', `yahoo-chart-error:${symbol}`, `[Relay] Yahoo chart error for ${symbol}: ${err.message}`);
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'X-Yahoo-Source': 'relay-stale',
      }, cached.json);
    }
    sendCompressed(req, res, 502, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Yahoo upstream error', symbol }));
  });
  yahooReq.on('timeout', () => {
    yahooReq.destroy();
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'X-Yahoo-Source': 'relay-stale',
      }, cached.json);
    }
    sendCompressed(req, res, 504, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Yahoo upstream timeout', symbol }));
  });
}

// ── YouTube Live Detection (residential proxy bypass) ──────────────
const YOUTUBE_PROXY_URL = process.env.YOUTUBE_PROXY_URL || '';

function parseProxyUrl(proxyUrl) {
  if (!proxyUrl) return null;
  try {
    const u = new URL(proxyUrl);
    return {
      host: u.hostname,
      port: parseInt(u.port, 10),
      auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
    };
  } catch { return null; }
}

function ytFetchViaProxy(targetUrl, proxy) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const connectOpts = {
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: `${target.hostname}:443`, headers: {},
    };
    if (proxy.auth) {
      connectOpts.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(proxy.auth).toString('base64');
    }
    const connectReq = http.request(connectOpts);
    connectReq.on('connect', (_res, socket) => {
      const req = https.request({
        hostname: target.hostname,
        path: target.pathname + target.search,
        method: 'GET',
        headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
        socket, agent: false,
      }, (res) => {
        let stream = res;
        const enc = (res.headers['content-encoding'] || '').trim().toLowerCase();
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        }));
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    connectReq.on('error', reject);
    connectReq.setTimeout(12000, () => { connectReq.destroy(); reject(new Error('Proxy timeout')); });
    connectReq.end();
  });
}

function ytFetchDirect(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const req = https.request({
      hostname: target.hostname,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { 'User-Agent': CHROME_UA, 'Accept-Encoding': 'gzip, deflate' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return ytFetchDirect(res.headers.location).then(resolve, reject);
      }
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').trim().toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        body: Buffer.concat(chunks).toString(),
      }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('YouTube timeout')); });
    req.end();
  });
}

async function ytFetch(url) {
  const proxy = parseProxyUrl(YOUTUBE_PROXY_URL);
  if (proxy) {
    try { return await ytFetchViaProxy(url, proxy); } catch { /* fall through */ }
  }
  return ytFetchDirect(url);
}

const ytLiveCache = new Map();
const YT_CACHE_TTL = 5 * 60 * 1000;

function handleYouTubeLiveRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const channel = url.searchParams.get('channel');
  const videoIdParam = url.searchParams.get('videoId');

  if (videoIdParam && /^[A-Za-z0-9_-]{11}$/.test(videoIdParam)) {
    const cacheKey = `vid:${videoIdParam}`;
    const cached = ytLiveCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 3600000) {
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, cached.json);
    }
    ytFetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoIdParam}&format=json`)
      .then(r => {
        if (r.ok) {
          try {
            const data = JSON.parse(r.body);
            const json = JSON.stringify({ channelName: data.author_name || null, title: data.title || null, videoId: videoIdParam });
            ytLiveCache.set(cacheKey, { json, ts: Date.now() });
            return sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, json);
          } catch {}
        }
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }));
      })
      .catch(() => {
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify({ channelName: null, title: null, videoId: videoIdParam }));
      });
    return;
  }

  if (!channel) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing channel parameter' }));
  }

  const channelHandle = channel.startsWith('@') ? channel : `@${channel}`;
  const cacheKey = `ch:${channelHandle}`;
  const cached = ytLiveCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < YT_CACHE_TTL) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
    }, cached.json);
  }

  const liveUrl = `https://www.youtube.com/${channelHandle}/live`;
  ytFetch(liveUrl)
    .then(r => {
      if (!r.ok) {
        return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify({ videoId: null, channelExists: false }));
      }
      const html = r.body;
      const channelExists = html.includes('"channelId"') || html.includes('og:url');
      let channelName = null;
      const ownerMatch = html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
      if (ownerMatch) channelName = ownerMatch[1];
      else { const am = html.match(/"author"\s*:\s*"([^"]+)"/); if (am) channelName = am[1]; }

      let videoId = null;
      const detailsIdx = html.indexOf('"videoDetails"');
      if (detailsIdx !== -1) {
        const block = html.substring(detailsIdx, detailsIdx + 5000);
        const vidMatch = block.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const liveMatch = block.match(/"isLive"\s*:\s*true/);
        if (vidMatch && liveMatch) videoId = vidMatch[1];
      }

      let hlsUrl = null;
      const hlsMatch = html.match(/"hlsManifestUrl"\s*:\s*"([^"]+)"/);
      if (hlsMatch && videoId) hlsUrl = hlsMatch[1].replace(/\\u0026/g, '&');

      const json = JSON.stringify({ videoId, isLive: videoId !== null, channelExists, channelName, hlsUrl });
      ytLiveCache.set(cacheKey, { json, ts: Date.now() });
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300, s-maxage=300, stale-while-revalidate=60',
      }, json);
    })
    .catch(err => {
      console.error('[Relay] YouTube live check error:', err.message);
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify({ videoId: null, error: err.message }));
    });
}

// Periodic cleanup for YouTube cache
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of ytLiveCache) {
    const ttl = key.startsWith('vid:') ? 3600000 : YT_CACHE_TTL;
    if (now - val.ts > ttl * 2) ytLiveCache.delete(key);
  }
}, 5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────
// NOTAM proxy — ICAO API times out from Vercel edge, relay proxies
// ─────────────────────────────────────────────────────────────
const ICAO_API_KEY = process.env.ICAO_API_KEY;
const notamCache = { data: null, ts: 0 };
const NOTAM_CACHE_TTL = 30 * 60 * 1000; // 30 min

function handleNotamProxyRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const locations = url.searchParams.get('locations');
  if (!locations) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing locations parameter' }));
  }
  if (!ICAO_API_KEY) {
    return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
      JSON.stringify([]));
  }

  const cacheKey = locations.split(',').sort().join(',');
  if (notamCache.data && notamCache.key === cacheKey && Date.now() - notamCache.ts < NOTAM_CACHE_TTL) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800',
      'X-Cache': 'HIT',
    }, notamCache.data);
  }

  const apiUrl = `https://dataservices.icao.int/api/notams-realtime-list?api_key=${ICAO_API_KEY}&format=json&locations=${locations}`;

  const request = https.get(apiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    timeout: 25000,
  }, (upstream) => {
    if (upstream.statusCode !== 200) {
      console.warn(`[Relay] NOTAM upstream HTTP ${upstream.statusCode}`);
      upstream.resume();
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
    const ct = upstream.headers['content-type'] || '';
    if (ct.includes('text/html')) {
      console.warn('[Relay] NOTAM upstream returned HTML (challenge page)');
      upstream.resume();
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      try {
        JSON.parse(body); // validate JSON
        notamCache.data = body;
        notamCache.key = cacheKey;
        notamCache.ts = Date.now();
        console.log(`[Relay] NOTAM: ${body.length} bytes for ${locations}`);
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800, s-maxage=1800',
          'X-Cache': 'MISS',
        }, body);
      } catch {
        console.warn('[Relay] NOTAM: invalid JSON response');
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify([]));
      }
    });
  });

  request.on('error', (err) => {
    console.warn(`[Relay] NOTAM error: ${err.message}`);
    if (!res.headersSent) {
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
  });

  request.on('timeout', () => {
    request.destroy();
    console.warn('[Relay] NOTAM timeout (25s)');
    if (!res.headersSent) {
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
  });
}

// CORS origin allowlist — only our domains can use this relay
const ALLOWED_ORIGINS = [
  'https://worldmonitor.app',
  'https://tech.worldmonitor.app',
  'https://finance.worldmonitor.app',
  'http://localhost:5173',   // Vite dev
  'http://localhost:5174',   // Vite dev alt port
  'http://localhost:4173',   // Vite preview
  'https://localhost',       // Tauri desktop
  'tauri://localhost',       // Tauri iOS/macOS
];

function getCorsOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Wildcard: any *.worldmonitor.app subdomain (for variant subdomains)
  try {
    const url = new URL(origin);
    if (url.hostname.endsWith('.worldmonitor.app') && url.protocol === 'https:') return origin;
  } catch { /* invalid origin — fall through */ }
  // Optional: allow Vercel preview deployments when explicitly enabled.
  if (ALLOW_VERCEL_PREVIEW_ORIGINS && origin.endsWith('.vercel.app')) return origin;
  return '';
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  const corsOrigin = getCorsOrigin(req);
  // Always emit Vary: Origin on /rss (browser-direct via CDN) to prevent
  // cached no-CORS responses from being served to browser clients.
  const isRssRoute = pathname.startsWith('/rss');
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  } else if (isRssRoute) {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', `Content-Type, Authorization, ${RELAY_AUTH_HEADER}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(corsOrigin ? 204 : 403);
    return res.end();
  }

  // NOTE: With Cloudflare edge caching (CDN-Cache-Control), authenticated responses may be
  // served to unauthenticated requests from edge cache. This is acceptable — all proxied data
  // is public (RSS, WorldBank, UCDP, Polymarket, OpenSky, AIS). Auth exists for abuse
  // prevention (rate limiting), not data protection. Cloudflare WAF provides edge-level protection.
  const isPublicRoute = pathname === '/health' || pathname === '/' || isRssRoute;
  if (!isPublicRoute) {
    if (!isAuthorizedRequest(req)) {
      return safeEnd(res, 401, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'Unauthorized', time: Date.now() }));
    }
  }
  // Rate limiting applies to all non-health routes (including public /rss)
  if (pathname !== '/health' && pathname !== '/') {
    const rl = consumeRateLimit(req, pathname, isPublicRoute);
    if (rl.limited) {
      const retryAfterSec = Math.max(1, Math.ceil(rl.resetInMs / 1000));
      return safeEnd(res, 429, {
        'Content-Type': 'application/json',
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(rl.limit),
        'X-RateLimit-Remaining': String(rl.remaining),
        'X-RateLimit-Reset': String(retryAfterSec),
      }, JSON.stringify({ error: 'Too many requests', time: Date.now() }));
    }
  }

  if (pathname === '/health' || pathname === '/') {
    const mem = process.memoryUsage();
    sendCompressed(req, res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({
      status: 'ok',
      clients: clients.size,
      messages: messageCount,
      droppedMessages,
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      upstreamPaused,
      vessels: vessels.size,
      densityZones: Array.from(densityGrid.values()).filter(c => c.vessels.size >= 2).length,
      telegram: {
        enabled: TELEGRAM_ENABLED,
        channels: telegramState.channels?.length || 0,
        items: telegramState.items?.length || 0,
        lastPollAt: telegramState.lastPollAt ? new Date(telegramState.lastPollAt).toISOString() : null,
        hasError: !!telegramState.lastError,
        lastError: telegramState.lastError || null,
        pollInFlight: telegramPollInFlight,
        pollInFlightSince: telegramPollInFlight && telegramPollStartedAt ? new Date(telegramPollStartedAt).toISOString() : null,
      },
      oref: {
        enabled: OREF_ENABLED,
        alertCount: orefState.lastAlerts?.length || 0,
        historyCount24h: orefState.historyCount24h,
        totalHistoryCount: orefState.totalHistoryCount,
        historyWaves: orefState.history?.length || 0,
        lastPollAt: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : null,
        hasError: !!orefState.lastError,
        redisEnabled: UPSTASH_ENABLED,
        bootstrapSource: orefState.bootstrapSource,
      },
      memory: {
        rss: `${(mem.rss / 1024 / 1024).toFixed(0)}MB`,
        heapUsed: `${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB`,
        heapTotal: `${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB`,
      },
      cache: {
        opensky: openskyResponseCache.size,
        opensky_neg: openskyNegativeCache.size,
        rss: rssResponseCache.size,
        ucdp: ucdpCache.data ? 'warm' : 'cold',
        worldbank: worldbankCache.size,
        polymarket: polymarketCache.size,
        yahooChart: yahooChartCache.size,
        polymarketInflight: polymarketInflight.size,
      },
      auth: {
        sharedSecretEnabled: !!RELAY_SHARED_SECRET,
        authHeader: RELAY_AUTH_HEADER,
        allowVercelPreviewOrigins: ALLOW_VERCEL_PREVIEW_ORIGINS,
      },
      rateLimit: {
        windowMs: RELAY_RATE_LIMIT_WINDOW_MS,
        defaultMax: RELAY_RATE_LIMIT_MAX,
        openskyMax: RELAY_OPENSKY_RATE_LIMIT_MAX,
        rssMax: RELAY_RSS_RATE_LIMIT_MAX,
      },
    }));
  } else if (pathname === '/metrics') {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }, JSON.stringify(getRelayRollingMetrics()));
  } else if (pathname.startsWith('/ais/snapshot')) {
    // Aggregated AIS snapshot for server-side fanout — serve pre-serialized + pre-gzipped
    connectUpstream();
    buildSnapshot(); // ensures cache is warm
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const includeCandidates = url.searchParams.get('candidates') === 'true';
    const json = includeCandidates ? lastSnapshotWithCandJson : lastSnapshotJson;
    const gz = includeCandidates ? lastSnapshotWithCandGzip : lastSnapshotGzip;

    if (json) {
      sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2',
        'CDN-Cache-Control': 'public, max-age=10',
      }, json, gz);
    } else {
      // Cold start fallback
      const payload = { ...lastSnapshot, candidateReports: includeCandidates ? getCandidateReportsSnapshot() : [] };
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2',
        'CDN-Cache-Control': 'public, max-age=10',
      }, JSON.stringify(payload));
    }
  } else if (pathname === '/opensky-reset') {
    openskyToken = null;
    openskyTokenExpiry = 0;
    openskyTokenPromise = null;
    openskyAuthCooldownUntil = 0;
    openskyGlobal429Until = 0;
    openskyNegativeCache.clear();
    console.log('[Relay] OpenSky auth + rate-limit state reset via /opensky-reset');
    const tokenStart = Date.now();
    const token = await getOpenSkyToken();
    return sendCompressed(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store' }, JSON.stringify({
      reset: true,
      tokenAcquired: !!token,
      latencyMs: Date.now() - tokenStart,
      negativeCacheCleared: true,
      rateLimitCooldownCleared: true,
    }));
  } else if (pathname === '/opensky-diag') {
    // Temporary diagnostic route with safe output only (no token payloads).
    const now = Date.now();
    const hasFreshToken = !!(openskyToken && now < openskyTokenExpiry - 60000);
    const diag = { timestamp: new Date().toISOString(), steps: [] };
    const clientId = process.env.OPENSKY_CLIENT_ID;
    const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

    diag.steps.push({ step: 'env_check', hasClientId: !!clientId, hasClientSecret: !!clientSecret, proxyEnabled: OPENSKY_PROXY_ENABLED });
    diag.steps.push({
      step: 'auth_state',
      cachedToken: !!openskyToken,
      freshToken: hasFreshToken,
      tokenExpiry: openskyTokenExpiry ? new Date(openskyTokenExpiry).toISOString() : null,
      cooldownRemainingMs: Math.max(0, openskyAuthCooldownUntil - now),
      tokenFetchInFlight: !!openskyTokenPromise,
      global429CooldownRemainingMs: Math.max(0, openskyGlobal429Until - now),
      requestSpacingMs: OPENSKY_REQUEST_SPACING_MS,
    });

    if (!clientId || !clientSecret) {
      diag.steps.push({ step: 'FAILED', reason: 'Missing OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET' });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(diag, null, 2));
    }

    // Use shared token path so diagnostics respect mutex + cooldown protections.
    const tokenStart = Date.now();
    const token = await getOpenSkyToken();
    diag.steps.push({
      step: 'token_request',
      method: 'getOpenSkyToken',
      success: !!token,
      fromCache: hasFreshToken,
      latencyMs: Date.now() - tokenStart,
      cooldownRemainingMs: Math.max(0, openskyAuthCooldownUntil - Date.now()),
    });

    if (token) {
      const apiResult = await new Promise((resolve) => {
        const start = Date.now();
        const apiReq = https.get('https://opensky-network.org/api/states/all?lamin=47&lomin=5&lamax=48&lomax=6', {
          family: 4,
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
          timeout: 15000,
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => resolve({
            status: apiRes.statusCode,
            latencyMs: Date.now() - start,
            bodyLength: data.length,
            statesCount: (data.match(/"states":\s*\[/) ? 'present' : 'missing'),
          }));
        });
        apiReq.on('error', (err) => resolve({ error: err.message, code: err.code, latencyMs: Date.now() - start }));
        apiReq.on('timeout', () => { apiReq.destroy(); resolve({ error: 'timeout', latencyMs: Date.now() - start }); });
      });
      diag.steps.push({ step: 'api_request', ...apiResult });
    } else {
      diag.steps.push({ step: 'api_request', skipped: true, reason: 'No token available (auth failure or cooldown active)' });
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(diag, null, 2));
  } else if (pathname === '/telegram' || pathname.startsWith('/telegram/')) {
    // Telegram Early Signals feed (public channels)
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
      const topic = (url.searchParams.get('topic') || '').trim().toLowerCase();
      const channel = (url.searchParams.get('channel') || '').trim().toLowerCase();

      const items = Array.isArray(telegramState.items) ? telegramState.items : [];
      const filtered = items.filter((it) => {
        if (topic && String(it.topic || '').toLowerCase() !== topic) return false;
        if (channel && String(it.channel || '').toLowerCase() !== channel) return false;
        return true;
      }).slice(0, limit);

      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10',
        'CDN-Cache-Control': 'public, max-age=10',
      }, JSON.stringify({
        source: 'telegram',
        earlySignal: true,
        enabled: TELEGRAM_ENABLED,
        count: filtered.length,
        updatedAt: telegramState.lastPollAt ? new Date(telegramState.lastPollAt).toISOString() : null,
        items: filtered,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  } else if (pathname.startsWith('/rss')) {
    // Proxy RSS feeds that block Vercel IPs
    let feedUrl = '';
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      feedUrl = url.searchParams.get('url') || '';

      if (!feedUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing url parameter' }));
      }

      // Domain allowlist from shared source of truth (shared/rss-allowed-domains.js)
      const parsed = new URL(feedUrl);
      // Block deprecated/stale feed domains — stale clients still request these
      const blockedDomains = ['rsshub.app'];
      if (blockedDomains.includes(parsed.hostname)) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Feed deprecated' }));
      }
      if (!RSS_ALLOWED_DOMAINS.has(parsed.hostname)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Domain not allowed on Railway proxy' }));
      }

      // Backoff guard: if feed is in exponential backoff, don't hit upstream
      const backoffExpiry = rssBackoffUntil.get(feedUrl);
      const backoffNow = Date.now();
      if (backoffExpiry && backoffNow < backoffExpiry) {
        const rssCachedForBackoff = rssResponseCache.get(feedUrl);
        if (rssCachedForBackoff && rssCachedForBackoff.statusCode >= 200 && rssCachedForBackoff.statusCode < 300) {
          return sendCompressed(req, res, 200, {
            'Content-Type': rssCachedForBackoff.contentType || 'application/xml',
            'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store',
            'X-Cache': 'BACKOFF-STALE',
          }, rssCachedForBackoff.data);
        }
        const remainSec = Math.max(1, Math.round((backoffExpiry - backoffNow) / 1000));
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(remainSec) });
        return res.end(JSON.stringify({ error: 'Feed in backoff', retryAfterSec: remainSec }));
      }

      // Two-layer negative caching:
      // 1. Backoff guard above: exponential (1→15min) for network errors (socket hang up, timeout)
      // 2. This cache check: flat 1min TTL for non-2xx upstream responses (429, 503, etc.)
      // Both layers work correctly together — backoff handles persistent failures,
      // negative cache prevents thundering herd on transient upstream errors.
      const rssCached = rssResponseCache.get(feedUrl);
      if (rssCached) {
        const ttl = (rssCached.statusCode && rssCached.statusCode >= 200 && rssCached.statusCode < 300)
          ? RSS_CACHE_TTL_MS : RSS_NEGATIVE_CACHE_TTL_MS;
        if (Date.now() - rssCached.timestamp < ttl) {
          return sendCompressed(req, res, rssCached.statusCode || 200, {
            'Content-Type': rssCached.contentType || 'application/xml',
            'Cache-Control': rssCached.statusCode >= 200 && rssCached.statusCode < 300 ? 'public, max-age=300' : 'no-cache',
            'CDN-Cache-Control': rssCached.statusCode >= 200 && rssCached.statusCode < 300 ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
            'X-Cache': 'HIT',
          }, rssCached.data);
        }
      }

      // In-flight dedup: if another request for the same feed is already fetching,
      // wait for it and serve from cache instead of hammering upstream.
      const existing = rssInFlight.get(feedUrl);
      if (existing) {
        try {
          await existing;
          const deduped = rssResponseCache.get(feedUrl);
          if (deduped) {
            return sendCompressed(req, res, deduped.statusCode || 200, {
              'Content-Type': deduped.contentType || 'application/xml',
              'Cache-Control': deduped.statusCode >= 200 && deduped.statusCode < 300 ? 'public, max-age=300' : 'no-cache',
              'CDN-Cache-Control': deduped.statusCode >= 200 && deduped.statusCode < 300 ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
              'X-Cache': 'DEDUP',
            }, deduped.data);
          }
          // In-flight completed but nothing cached — serve 502 instead of cascading
          return safeEnd(res, 502, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Upstream fetch completed but not cached' }));
        } catch {
          // In-flight fetch failed — serve 502 instead of starting another fetch
          return safeEnd(res, 502, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Upstream fetch failed' }));
        }
      }

      logThrottled('log', `rss-miss:${feedUrl}`, '[Relay] RSS request (MISS):', feedUrl);

      const fetchPromise = new Promise((resolveInFlight, rejectInFlight) => {
      let responseHandled = false;

      const sendError = (statusCode, message) => {
        if (responseHandled || res.headersSent) return;
        responseHandled = true;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
        rejectInFlight(new Error(message));
      };

      const fetchWithRedirects = (url, redirectCount = 0) => {
        if (redirectCount > 3) {
          return sendError(502, 'Too many redirects');
        }

        const conditionalHeaders = {};
        if (rssCached?.etag) conditionalHeaders['If-None-Match'] = rssCached.etag;
        if (rssCached?.lastModified) conditionalHeaders['If-Modified-Since'] = rssCached.lastModified;

        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
          headers: {
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            ...conditionalHeaders,
          },
          timeout: 15000
        }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            const redirectUrl = response.headers.location.startsWith('http')
              ? response.headers.location
              : new URL(response.headers.location, url).href;
            const redirectHost = new URL(redirectUrl).hostname;
            if (!RSS_ALLOWED_DOMAINS.has(redirectHost)) {
              return sendError(403, 'Redirect to disallowed domain');
            }
            logThrottled('log', `rss-redirect:${feedUrl}:${redirectUrl}`, `[Relay] Following redirect to: ${redirectUrl}`);
            return fetchWithRedirects(redirectUrl, redirectCount + 1);
          }

          if (response.statusCode === 304 && rssCached) {
            responseHandled = true;
            rssCached.timestamp = Date.now();
            rssResetFailure(feedUrl);
            resolveInFlight();
            logThrottled('log', `rss-revalidated:${feedUrl}`, '[Relay] RSS 304 revalidated:', feedUrl);
            sendCompressed(req, res, 200, {
              'Content-Type': rssCached.contentType || 'application/xml',
              'Cache-Control': 'public, max-age=300',
              'CDN-Cache-Control': 'public, max-age=600, stale-while-revalidate=300',
              'X-Cache': 'REVALIDATED',
            }, rssCached.data);
            return;
          }

          const encoding = response.headers['content-encoding'];
          let stream = response;
          if (encoding === 'gzip' || encoding === 'deflate') {
            stream = encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : response.pipe(zlib.createInflate());
          }

          const chunks = [];
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            if (responseHandled || res.headersSent) return;
            responseHandled = true;
            const data = Buffer.concat(chunks);
            // Cache all responses: 2xx with full TTL, non-2xx with short TTL (negative cache)
            // FIFO eviction: drop oldest-inserted entry if at capacity
            if (rssResponseCache.size >= RSS_CACHE_MAX_ENTRIES && !rssResponseCache.has(feedUrl)) {
              const oldest = rssResponseCache.keys().next().value;
              if (oldest) rssResponseCache.delete(oldest);
            }
            rssResponseCache.set(feedUrl, {
              data, contentType: 'application/xml', statusCode: response.statusCode, timestamp: Date.now(),
              etag: response.headers['etag'] || null,
              lastModified: response.headers['last-modified'] || null,
            });
            if (response.statusCode >= 200 && response.statusCode < 300) {
              rssResetFailure(feedUrl);
            } else {
              const { failures, backoffSec } = rssRecordFailure(feedUrl);
              logThrottled('warn', `rss-upstream:${feedUrl}:${response.statusCode}`, `[Relay] RSS upstream ${response.statusCode} for ${feedUrl} (backoff ${backoffSec}s, failures=${failures})`);
            }
            resolveInFlight();
            sendCompressed(req, res, response.statusCode, {
              'Content-Type': 'application/xml',
              'Cache-Control': response.statusCode >= 200 && response.statusCode < 300 ? 'public, max-age=300' : 'no-cache',
              'CDN-Cache-Control': response.statusCode >= 200 && response.statusCode < 300 ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
              'X-Cache': 'MISS',
            }, data);
          });
          stream.on('error', (err) => {
            const { failures, backoffSec } = rssRecordFailure(feedUrl);
            logThrottled('error', `rss-decompress:${feedUrl}:${err.code || err.message}`, `[Relay] Decompression error: ${err.message} (backoff ${backoffSec}s, failures=${failures})`);
            sendError(502, 'Decompression failed: ' + err.message);
          });
        });

        request.on('error', (err) => {
          const { failures, backoffSec } = rssRecordFailure(feedUrl);
          logThrottled('error', `rss-error:${feedUrl}:${err.code || err.message}`, `[Relay] RSS error: ${err.message} (backoff ${backoffSec}s, failures=${failures})`);
          // Serve stale on error (only if we have previous successful data)
          if (rssCached && rssCached.statusCode >= 200 && rssCached.statusCode < 300) {
            if (!responseHandled && !res.headersSent) {
              responseHandled = true;
              sendCompressed(req, res, 200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, rssCached.data);
            }
            resolveInFlight();
            return;
          }
          sendError(502, err.message);
        });

        request.on('timeout', () => {
          request.destroy();
          const { failures, backoffSec } = rssRecordFailure(feedUrl);
          logThrottled('warn', `rss-timeout:${feedUrl}`, `[Relay] RSS timeout for ${feedUrl} (backoff ${backoffSec}s, failures=${failures})`);
          if (rssCached && rssCached.statusCode >= 200 && rssCached.statusCode < 300 && !responseHandled && !res.headersSent) {
            responseHandled = true;
            sendCompressed(req, res, 200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, rssCached.data);
            resolveInFlight();
            return;
          }
          sendError(504, 'Request timeout');
        });
      };

      fetchWithRedirects(feedUrl);
      }); // end fetchPromise

      rssInFlight.set(feedUrl, fetchPromise);
      fetchPromise.catch(() => {}).finally(() => rssInFlight.delete(feedUrl));
    } catch (err) {
      if (feedUrl) rssInFlight.delete(feedUrl);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  } else if (pathname === '/oref/alerts') {
    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=3',
    }, JSON.stringify({
      configured: OREF_ENABLED,
      alerts: orefState.lastAlerts || [],
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
      ...(orefState.lastError ? { error: orefState.lastError } : {}),
    }));
  } else if (pathname === '/oref/history') {
    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=10',
    }, JSON.stringify({
      configured: OREF_ENABLED,
      history: orefState.history || [],
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
    }));
  } else if (pathname.startsWith('/ucdp-events')) {
    handleUcdpEventsRequest(req, res);
  } else if (pathname.startsWith('/opensky')) {
    handleOpenSkyRequest(req, res, PORT);
  } else if (pathname.startsWith('/worldbank')) {
    handleWorldBankRequest(req, res);
  } else if (pathname.startsWith('/polymarket')) {
    handlePolymarketRequest(req, res);
  } else if (pathname === '/youtube-live') {
    handleYouTubeLiveRequest(req, res);
  } else if (pathname === '/yahoo-chart') {
    handleYahooChartRequest(req, res);
  } else if (pathname === '/notam') {
    handleNotamProxyRequest(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
});

function connectUpstream() {
  // Skip if already connected or connecting
  if (upstreamSocket?.readyState === WebSocket.OPEN ||
      upstreamSocket?.readyState === WebSocket.CONNECTING) return;

  console.log('[Relay] Connecting to aisstream.io...');
  const socket = new WebSocket(AISSTREAM_URL);
  upstreamSocket = socket;
  clearUpstreamQueue();
  upstreamPaused = false;

  const scheduleUpstreamDrain = () => {
    if (upstreamDrainScheduled) return;
    upstreamDrainScheduled = true;
    setImmediate(drainUpstreamQueue);
  };

  const drainUpstreamQueue = () => {
    if (upstreamSocket !== socket) {
      clearUpstreamQueue();
      upstreamPaused = false;
      return;
    }

    upstreamDrainScheduled = false;
    const startedAt = Date.now();
    let processed = 0;

    while (processed < UPSTREAM_DRAIN_BATCH &&
           getUpstreamQueueSize() > 0 &&
           Date.now() - startedAt < UPSTREAM_DRAIN_BUDGET_MS) {
      const raw = dequeueUpstreamMessage();
      if (!raw) break;
      processRawUpstreamMessage(raw);
      processed++;
    }

    const queueSize = getUpstreamQueueSize();
    if (queueSize >= UPSTREAM_QUEUE_HIGH_WATER && !upstreamPaused) {
      upstreamPaused = true;
      socket.pause();
      console.warn(`[Relay] Upstream paused (queue=${queueSize}, dropped=${droppedMessages})`);
    } else if (upstreamPaused && queueSize <= UPSTREAM_QUEUE_LOW_WATER) {
      upstreamPaused = false;
      socket.resume();
      console.log(`[Relay] Upstream resumed (queue=${queueSize})`);
    }

    if (queueSize > 0) scheduleUpstreamDrain();
  };

  socket.on('open', () => {
    // Verify this socket is still the current one (race condition guard)
    if (upstreamSocket !== socket) {
      console.log('[Relay] Stale socket open event, closing');
      socket.close();
      return;
    }
    console.log('[Relay] Connected to aisstream.io');
    socket.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ['PositionReport'],
    }));
  });

  socket.on('message', (data) => {
    if (upstreamSocket !== socket) return;

    const raw = data instanceof Buffer ? data : Buffer.from(data);
    if (getUpstreamQueueSize() >= UPSTREAM_QUEUE_HARD_CAP) {
      droppedMessages++;
      incrementRelayMetric('drops');
      return;
    }

    enqueueUpstreamMessage(raw);
    if (!upstreamPaused && getUpstreamQueueSize() >= UPSTREAM_QUEUE_HIGH_WATER) {
      upstreamPaused = true;
      socket.pause();
      console.warn(`[Relay] Upstream paused (queue=${getUpstreamQueueSize()}, dropped=${droppedMessages})`);
    }
    scheduleUpstreamDrain();
  });

  socket.on('close', () => {
    if (upstreamSocket === socket) {
      upstreamSocket = null;
      clearUpstreamQueue();
      upstreamPaused = false;
      console.log('[Relay] Disconnected, reconnecting in 5s...');
      setTimeout(connectUpstream, 5000);
    }
  });

  socket.on('error', (err) => {
    console.error('[Relay] Upstream error:', err.message);
  });
}

const wss = new WebSocketServer({ server });

server.listen(PORT, () => {
  console.log(`[Relay] WebSocket relay on port ${PORT} (OpenSky: ${OPENSKY_PROXY_ENABLED ? 'via proxy' : 'direct'})`);
  startTelegramPollLoop();
  startOrefPollLoop();
  startUcdpSeedLoop();
  startMarketDataSeedLoop();
  startAviationSeedLoop();
  startNotamSeedLoop();
  // Cyber seed disabled — standalone cron seed-cyber-threats.mjs handles this
  // (avoids burning 12 extra AbuseIPDB calls/day from duplicate relay loop)
  startCiiWarmPingLoop();
  startPositiveEventsSeedLoop();
  startClassifySeedLoop();
  startServiceStatusesSeedLoop();
  startTheaterPostureSeedLoop();

  startWeatherSeedLoop();
  startSpendingSeedLoop();
  startWorldBankSeedLoop();
  startSatelliteSeedLoop();
  startTechEventsSeedLoop();
  startPortWatchSeedLoop();
  startCorridorRiskSeedLoop();
});

wss.on('connection', (ws, req) => {
  if (!isAuthorizedRequest(req)) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  const wsOrigin = req.headers.origin || '';
  if (wsOrigin && !getCorsOrigin(req)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  if (clients.size >= MAX_WS_CLIENTS) {
    console.log(`[Relay] WS client rejected (max ${MAX_WS_CLIENTS})`);
    ws.close(1013, 'Max clients reached');
    return;
  }
  console.log(`[Relay] Client connected (${clients.size + 1}/${MAX_WS_CLIENTS})`);
  clients.add(ws);
  connectUpstream();

  ws.on('close', () => {
    clients.delete(ws);
  });

  ws.on('error', (err) => {
    console.error('[Relay] Client error:', err.message);
    clients.delete(ws);
  });
});

// Memory / health monitor — log every 60s and force GC if available
setInterval(() => {
  const mem = process.memoryUsage();
  const rssGB = mem.rss / 1024 / 1024 / 1024;
  console.log(`[Monitor] rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB/${(mem.heapTotal / 1024 / 1024).toFixed(0)}MB external=${(mem.external / 1024 / 1024).toFixed(0)}MB vessels=${vessels.size} density=${densityGrid.size} candidates=${candidateReports.size} msgs=${messageCount} dropped=${droppedMessages}`);
  if (rssGB > MEMORY_CLEANUP_THRESHOLD_GB) {
    console.warn(`[Monitor] High memory (${rssGB.toFixed(2)}GB > ${MEMORY_CLEANUP_THRESHOLD_GB}GB) — forcing aggressive cleanup`);
    cleanupAggregates();
    openskyResponseCache.clear();
    openskyNegativeCache.clear();
    rssResponseCache.clear();
    polymarketCache.clear();
    worldbankCache.clear();
    yahooChartCache.clear();
    if (global.gc) global.gc();
  }
}, 60 * 1000);

// Graceful shutdown — disconnect Telegram BEFORE container dies.
// Railway sends SIGTERM during deploys; without this, the old container keeps
// the Telegram session alive while the new container connects → AUTH_KEY_DUPLICATED.
async function gracefulShutdown(signal) {
  console.log(`[Relay] ${signal} received — shutting down`);
  if (telegramState.client) {
    console.log('[Relay] Disconnecting Telegram client...');
    try {
      await Promise.race([
        telegramState.client.disconnect(),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    } catch {}
    telegramState.client = null;
  }
  if (upstreamSocket) {
    try { upstreamSocket.close(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
