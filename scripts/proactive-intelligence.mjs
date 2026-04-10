#!/usr/bin/env node
/**
 * Proactive Intelligence Agent — Railway scheduled job, runs every 6 hours.
 *
 * Reads all signal data from Redis, computes a "signal landscape diff" vs
 * the previous run, and generates proactive briefs via LLM when significant
 * changes are detected. Delivers via existing notification channels.
 *
 * Phase 4 of the AI Notification Roadmap.
 */
import { createRequire } from 'node:module';
import dns from 'node:dns/promises';

const require = createRequire(import.meta.url);
const { callLLM } = require('./lib/llm-chain.cjs');
const { fetchUserPreferences, extractUserContext, formatUserProfile } = require('./lib/user-context.cjs');
const { decrypt } = require('./lib/crypto.cjs');
const { Resend } = require('resend');
const { ConvexHttpClient } = require('convex/browser');

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

if (process.env.PROACTIVE_INTEL_ENABLED === '0') {
  console.log('[proactive] PROACTIVE_INTEL_ENABLED=0 — skipping run');
  process.exit(0);
}

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.error('[proactive] UPSTASH env vars not set');
  process.exit(1);
}
if (!CONVEX_SITE_URL || !RELAY_SECRET) {
  console.error('[proactive] CONVEX_SITE_URL / RELAY_SHARED_SECRET not set');
  process.exit(1);
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const CONVEX_URL = process.env.CONVEX_URL ?? '';
const convex = CONVEX_URL ? new ConvexHttpClient(CONVEX_URL) : null;

const LANDSCAPE_TTL = 172800; // 48h
const DIFF_THRESHOLD = 3; // minimum diff score to generate a brief
const ENTITLEMENT_CACHE_TTL = 900; // 15 min

// ── Redis helpers ──────────────────────────────────────────────────────────────

async function upstashRest(...args) {
  const res = await fetch(`${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'User-Agent': 'worldmonitor-proactive/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.result;
}

async function upstashGet(key) {
  const raw = await upstashRest('GET', key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
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
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-proactive/1.0' },
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

// ── Signal reading ───────────────────────────────────────────────────────────

const SIGNAL_KEYS = [
  'risk:scores:sebuf:stale:v1',
  'unrest:events:v1',
  'sanctions:pressure:v1',
  'intelligence:gpsjam:v2',
  'cyber:threats-bootstrap:v2',
  'thermal:escalation:v1',
  'weather:alerts:v1',
  'market:commodities-bootstrap:v1',
];

const MIN_SIGNAL_KEYS = Math.ceil(SIGNAL_KEYS.length * 0.6); // need at least 60% of keys

async function readSignals() {
  const results = {};
  let loaded = 0;
  for (const key of SIGNAL_KEYS) {
    try {
      const raw = await upstashRest('GET', key);
      if (raw) {
        results[key] = JSON.parse(raw);
        loaded++;
      }
    } catch { /* skip */ }
  }
  results._loaded = loaded;
  return results;
}

function extractLandscape(signals) {
  const landscape = {
    ts: Date.now(),
    topRiskCountries: [],
    gpsZoneCount: 0,
    unrestCount: 0,
    sanctionedHigh: [],
    cyberThreatCount: 0,
    thermalAnomalyCount: 0,
    weatherAlertCount: 0,
    commodityMovers: {},
  };

  const risk = signals['risk:scores:sebuf:stale:v1'];
  if (Array.isArray(risk)) {
    const elevated = risk
      .filter(r => r && (r.level === 'high' || r.level === 'critical' || r.level === 'elevated'))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10);
    landscape.topRiskCountries = elevated.map(r => r.iso2 ?? r.country ?? 'unknown');
  }

  const unrest = signals['unrest:events:v1'];
  if (Array.isArray(unrest)) landscape.unrestCount = unrest.length;

  const sanctions = signals['sanctions:pressure:v1'];
  if (Array.isArray(sanctions)) {
    landscape.sanctionedHigh = sanctions
      .filter(s => s && (s.pressure === 'high' || s.pressure === 'critical'))
      .map(s => s.iso2 ?? s.country ?? 'unknown')
      .slice(0, 10);
  }

  const gps = signals['intelligence:gpsjam:v2'];
  if (Array.isArray(gps)) landscape.gpsZoneCount = gps.length;
  else if (gps && typeof gps === 'object' && Array.isArray(gps.zones)) landscape.gpsZoneCount = gps.zones.length;

  const cyber = signals['cyber:threats-bootstrap:v2'];
  if (Array.isArray(cyber)) landscape.cyberThreatCount = cyber.length;

  const thermal = signals['thermal:escalation:v1'];
  if (Array.isArray(thermal)) landscape.thermalAnomalyCount = thermal.length;

  const weather = signals['weather:alerts:v1'];
  if (Array.isArray(weather)) landscape.weatherAlertCount = weather.length;

  const commodities = signals['market:commodities-bootstrap:v1'];
  if (Array.isArray(commodities)) {
    for (const c of commodities.slice(0, 20)) {
      if (c && c.symbol && typeof c.changePercent === 'number') {
        landscape.commodityMovers[c.symbol] = c.changePercent;
      }
    }
  }

  return landscape;
}

// ── Diff computation ─────────────────────────────────────────────────────────

function computeDiff(prev, curr) {
  const changes = [];
  let score = 0;

  const newRisk = curr.topRiskCountries.filter(c => !prev.topRiskCountries.includes(c));
  if (newRisk.length > 0) {
    changes.push(`New elevated-risk countries: ${newRisk.join(', ')}`);
    score += newRisk.length * 2;
  }

  const removedRisk = prev.topRiskCountries.filter(c => !curr.topRiskCountries.includes(c));
  if (removedRisk.length > 0) {
    changes.push(`Countries de-escalated: ${removedRisk.join(', ')}`);
    score += 1;
  }

  const gpsDelta = curr.gpsZoneCount - prev.gpsZoneCount;
  if (Math.abs(gpsDelta) >= 2) {
    changes.push(`GPS interference zones: ${prev.gpsZoneCount} → ${curr.gpsZoneCount}`);
    score += Math.abs(gpsDelta);
  }

  const unrestDelta = curr.unrestCount - prev.unrestCount;
  if (Math.abs(unrestDelta) >= 5) {
    changes.push(`Social unrest events: ${prev.unrestCount} → ${curr.unrestCount}`);
    score += Math.ceil(Math.abs(unrestDelta) / 5);
  }

  const newSanctions = curr.sanctionedHigh.filter(c => !prev.sanctionedHigh.includes(c));
  if (newSanctions.length > 0) {
    changes.push(`New high-pressure sanctions: ${newSanctions.join(', ')}`);
    score += newSanctions.length * 2;
  }

  const cyberDelta = curr.cyberThreatCount - prev.cyberThreatCount;
  if (Math.abs(cyberDelta) >= 3) {
    changes.push(`Cyber threats: ${prev.cyberThreatCount} → ${curr.cyberThreatCount}`);
    score += 1;
  }

  const thermalDelta = curr.thermalAnomalyCount - prev.thermalAnomalyCount;
  if (Math.abs(thermalDelta) >= 3) {
    changes.push(`Thermal anomalies: ${prev.thermalAnomalyCount} → ${curr.thermalAnomalyCount}`);
    score += 1;
  }

  for (const [sym, pct] of Object.entries(curr.commodityMovers)) {
    const prevPct = prev.commodityMovers?.[sym] ?? 0;
    const delta = Math.abs(pct - prevPct);
    if (delta >= 3) {
      changes.push(`${sym}: ${prevPct > 0 ? '+' : ''}${prevPct.toFixed(1)}% → ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`);
      score += 1;
    }
  }

  return { changes, score };
}

// ── Convergence detection ────────────────────────────────────────────────────

function detectConvergence(signals) {
  // Track which signal TYPES (not individual events) mention each country.
  // A country with risk + unrest + sanctions = 3 types, not 3 events.
  const countryTypes = {};

  function addType(iso2, type) {
    if (!iso2) return;
    if (!countryTypes[iso2]) countryTypes[iso2] = new Set();
    countryTypes[iso2].add(type);
  }

  const risk = signals['risk:scores:sebuf:stale:v1'];
  if (Array.isArray(risk)) {
    for (const r of risk) {
      if (r?.iso2 && (r.level === 'high' || r.level === 'critical' || r.level === 'elevated')) {
        addType(r.iso2, 'risk');
      }
    }
  }

  const unrest = signals['unrest:events:v1'];
  if (Array.isArray(unrest)) {
    for (const u of unrest) {
      addType(u?.country_code ?? u?.iso2, 'unrest');
    }
  }

  const sanctions = signals['sanctions:pressure:v1'];
  if (Array.isArray(sanctions)) {
    for (const s of sanctions) {
      if (s?.iso2 && (s.pressure === 'high' || s.pressure === 'critical')) {
        addType(s.iso2, 'sanctions');
      }
    }
  }

  const gps = signals['intelligence:gpsjam:v2'];
  if (Array.isArray(gps)) {
    for (const g of gps) addType(g?.country_code ?? g?.iso2, 'gps_interference');
  } else if (gps?.zones && Array.isArray(gps.zones)) {
    for (const z of gps.zones) addType(z?.country_code ?? z?.iso2, 'gps_interference');
  }

  const cyber = signals['cyber:threats-bootstrap:v2'];
  if (Array.isArray(cyber)) {
    for (const c of cyber) addType(c?.country_code ?? c?.iso2 ?? c?.target_country, 'cyber');
  }

  const thermal = signals['thermal:escalation:v1'];
  if (Array.isArray(thermal)) {
    for (const t of thermal) addType(t?.country_code ?? t?.iso2, 'thermal');
  }

  const weather = signals['weather:alerts:v1'];
  if (Array.isArray(weather)) {
    for (const w of weather) addType(w?.country_code ?? w?.iso2, 'weather');
  }

  return Object.entries(countryTypes)
    .filter(([, types]) => types.size >= 3)
    .map(([iso2, types]) => ({ iso2, signalCount: types.size, types: [...types] }))
    .sort((a, b) => b.signalCount - a.signalCount);
}

// ── Channel delivery (reuse patterns from digest/relay) ──────────────────────

function isPrivateIP(ip) {
  return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.0\.0\.0|169\.254\.|::1|fe80|fc|fd)/.test(ip);
}

async function deactivateChannel(userId, channelType) {
  try {
    await fetch(`${CONVEX_SITE_URL}/relay/deactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-proactive/1.0' },
      body: JSON.stringify({ userId, channelType }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

async function sendTelegram(userId, chatId, text) {
  if (!TELEGRAM_BOT_TOKEN) return false;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 403 || resp.status === 404) {
      await deactivateChannel(userId, 'telegram');
      return false;
    }
    return resp.ok;
  } catch { return false; }
}

async function sendSlack(userId, webhookEnvelope, text) {
  try {
    const url = decrypt(webhookEnvelope);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const addrs = await dns.resolve4(parsed.hostname);
    if (addrs.some(isPrivateIP)) return false;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-proactive/1.0' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 404 || resp.status === 410) {
      await deactivateChannel(userId, 'slack');
      return false;
    }
    return resp.ok;
  } catch { return false; }
}

async function sendDiscord(userId, webhookEnvelope, text) {
  try {
    const url = decrypt(webhookEnvelope);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const addrs = await dns.resolve4(parsed.hostname);
    if (addrs.some(isPrivateIP)) return false;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-proactive/1.0' },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 404 || resp.status === 410) {
      await deactivateChannel(userId, 'discord');
      return false;
    }
    return resp.ok;
  } catch { return false; }
}

async function sendEmail(email, subject, text) {
  if (!resend) return false;
  try {
    await resend.emails.send({ from: RESEND_FROM, to: email, subject, text });
    return true;
  } catch { return false; }
}

async function sendWebhook(userId, webhookEnvelope, payload) {
  try {
    const url = decrypt(webhookEnvelope);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const addrs = await dns.resolve4(parsed.hostname);
    if (addrs.some(isPrivateIP)) return false;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'worldmonitor-proactive/1.0' },
      body: JSON.stringify({ version: '1', eventType: 'proactive_brief', ...payload }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 404 || resp.status === 410 || resp.status === 403) {
      await deactivateChannel(userId, 'webhook');
      return false;
    }
    return resp.ok;
  } catch { return false; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const nowMs = Date.now();
  console.log('[proactive] Run start:', new Date(nowMs).toISOString());

  let rules;
  try {
    if (!convex) { console.error('[proactive] CONVEX_URL not set'); return; }
    rules = await convex.query('alertRules:getByEnabled', { enabled: true });
  } catch (err) {
    console.error('[proactive] Failed to fetch rules:', err.message);
    return;
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    console.log('[proactive] No rules found');
    return;
  }

  console.log('[proactive] Reading signal landscape...');
  const signals = await readSignals();
  const loaded = signals._loaded ?? 0;
  console.log(`[proactive] Loaded ${loaded}/${SIGNAL_KEYS.length} signal keys`);
  if (loaded < MIN_SIGNAL_KEYS) {
    console.error(`[proactive] Only ${loaded} signal keys loaded (need ${MIN_SIGNAL_KEYS}) — aborting to avoid false diffs`);
    return;
  }
  const currentLandscape = extractLandscape(signals);
  const convergenceZones = detectConvergence(signals);

  if (convergenceZones.length > 0) {
    console.log(`[proactive] Convergence zones: ${convergenceZones.map(z => `${z.iso2}(${z.signalCount})`).join(', ')}`);
  }

  let briefCount = 0;

  for (const rule of rules) {
    if (!rule.userId || !rule.variant) continue;

    const variant = rule.variant;
    const landscapeKey = `proactive:landscape:v1:${rule.userId}:${variant}`;
    const prevLandscape = await upstashGet(landscapeKey);

    if (!prevLandscape) {
      console.log(`[proactive] First run for ${rule.userId} (${variant}) — storing baseline`);
      await upstashRest('SET', landscapeKey, JSON.stringify(currentLandscape), 'EX', String(LANDSCAPE_TTL));
      continue;
    }

    const { changes, score } = computeDiff(prevLandscape, currentLandscape);
    if (score < DIFF_THRESHOLD) {
      console.log(`[proactive] No significant changes for ${rule.userId} (score=${score})`);
      await upstashRest('SET', landscapeKey, JSON.stringify(currentLandscape), 'EX', String(LANDSCAPE_TTL));
      continue;
    }

    const pro = await isUserPro(rule.userId);
    if (!pro) {
      console.log(`[proactive] Skipping ${rule.userId} — not PRO`);
      await upstashRest('SET', landscapeKey, JSON.stringify(currentLandscape), 'EX', String(LANDSCAPE_TTL));
      continue;
    }

    let channels = [];
    try {
      const chRes = await fetch(`${CONVEX_SITE_URL}/relay/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RELAY_SECRET}`, 'User-Agent': 'worldmonitor-proactive/1.0' },
        body: JSON.stringify({ userId: rule.userId }),
        signal: AbortSignal.timeout(10000),
      });
      if (chRes.ok) channels = await chRes.json();
    } catch (err) {
      console.warn(`[proactive] Channel fetch failed for ${rule.userId}:`, err.message);
    }

    const ruleChannelSet = new Set(rule.channels ?? []);
    const deliverable = channels.filter(c => c.verified && ruleChannelSet.has(c.channelType));
    if (deliverable.length === 0) {
      console.log(`[proactive] No deliverable channels for ${rule.userId} — retrying next run`);
      continue;
    }

    const { data: prefs, error: prefsFetchError } = await fetchUserPreferences(rule.userId, variant);
    if (prefsFetchError) {
      console.warn(`[proactive] Prefs fetch failed for ${rule.userId} — retrying next run`);
      continue;
    }
    if (!prefs) {
      console.log(`[proactive] No saved preferences for ${rule.userId} — skipping`);
      await upstashRest('SET', landscapeKey, JSON.stringify(currentLandscape), 'EX', String(LANDSCAPE_TTL));
      continue;
    }

    const ctx = extractUserContext(prefs);
    const profile = formatUserProfile(ctx, variant);
    const dateStr = new Date().toISOString().split('T')[0];

    const convergenceInfo = convergenceZones.length > 0
      ? `\nConvergence zones (3+ signal types): ${convergenceZones.map(z => `${z.iso2} [${z.types.join(', ')}]`).join('; ')}`
      : '';

    const systemPrompt = `You are WorldMonitor's proactive intelligence agent. Today is ${dateStr}.
Identify what CHANGED in the past 6 hours that this user should know about.

User profile:
${profile}

Rules:
- Focus on CHANGE and CONVERGENCE
- Highlight pattern shifts with numbers
- Connect to user's interests
- Quantify: numbers, percentages, counts
- Max 200 words
- Format: OVERNIGHT SHIFT / KEY CHANGES / WATCH TODAY`;

    const userPrompt = `Changes detected (score ${score}):
${changes.join('\n')}
${convergenceInfo}

Previous snapshot: ${JSON.stringify({ topRiskCountries: prevLandscape.topRiskCountries, gpsZoneCount: prevLandscape.gpsZoneCount, unrestCount: prevLandscape.unrestCount })}
Current snapshot: ${JSON.stringify({ topRiskCountries: currentLandscape.topRiskCountries, gpsZoneCount: currentLandscape.gpsZoneCount, unrestCount: currentLandscape.unrestCount })}`;

    const brief = await callLLM(systemPrompt, userPrompt, { maxTokens: 400, temperature: 0.3, timeoutMs: 15000 });
    if (!brief) {
      console.warn(`[proactive] LLM failed for ${rule.userId} — retrying next run`);
      continue;
    }

    const text = `PROACTIVE INTELLIGENCE BRIEF\n\n${brief}\n\n${'─'.repeat(40)}\nGenerated by WorldMonitor AI · worldmonitor.app`;
    const subject = `WorldMonitor Intelligence Update — ${dateStr}`;

    let anyDelivered = false;
    for (const ch of deliverable) {
      let ok = false;
      if (ch.channelType === 'telegram' && ch.chatId) ok = await sendTelegram(rule.userId, ch.chatId, text);
      else if (ch.channelType === 'slack' && ch.webhookEnvelope) ok = await sendSlack(rule.userId, ch.webhookEnvelope, text);
      else if (ch.channelType === 'discord' && ch.webhookEnvelope) ok = await sendDiscord(rule.userId, ch.webhookEnvelope, text);
      else if (ch.channelType === 'email' && ch.email) ok = await sendEmail(ch.email, subject, text);
      else if (ch.channelType === 'webhook' && ch.webhookEnvelope) ok = await sendWebhook(rule.userId, ch.webhookEnvelope, {
        brief,
        changes,
        convergenceZones: convergenceZones.map(z => ({ iso2: z.iso2, types: z.types })),
        diffScore: score,
        timestamp: nowMs,
      });
      if (ok) anyDelivered = true;
    }

    if (anyDelivered) {
      briefCount++;
      console.log(`[proactive] Brief delivered to ${rule.userId} (${variant}, score=${score}, changes=${changes.length})`);
      await upstashRest('SET', landscapeKey, JSON.stringify(currentLandscape), 'EX', String(LANDSCAPE_TTL));
    } else {
      console.warn(`[proactive] All deliveries failed for ${rule.userId} — retrying next run`);
    }
  }

  console.log(`[proactive] Run complete: ${briefCount} brief(s) delivered`);
}

main().catch((err) => {
  console.error('[proactive] Fatal:', err);
  process.exit(1);
});
