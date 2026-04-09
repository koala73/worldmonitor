'use strict';

const CONVEX_SITE_URL =
  process.env.CONVEX_SITE_URL ??
  (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
const RELAY_SECRET = process.env.RELAY_SHARED_SECRET ?? '';

/**
 * Fetch the raw user preferences blob from Convex via the relay endpoint.
 * Returns the parsed data object, or null on failure.
 *
 * @param {string} userId
 * @param {string} variant
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function fetchUserPreferences(userId, variant) {
  if (!CONVEX_SITE_URL || !RELAY_SECRET) {
    console.warn('[user-context] CONVEX_SITE_URL or RELAY_SHARED_SECRET not set');
    return null;
  }
  try {
    const res = await fetch(`${CONVEX_SITE_URL}/relay/user-preferences`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RELAY_SECRET}`,
        'User-Agent': 'worldmonitor-relay/1.0',
      },
      body: JSON.stringify({ userId, variant }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[user-context] fetchUserPreferences: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[user-context] fetchUserPreferences failed: ${err.message}`);
    return null;
  }
}

/**
 * Extract actionable user context from the raw Convex preferences blob.
 *
 * @param {Record<string, unknown> | null} prefs - Raw data blob from userPreferences
 * @returns {{ tickers: string[], airports: string[], airlines: string[], frameworkName: string | null, enabledPanels: string[], disabledFeeds: string[] }}
 */
function extractUserContext(prefs) {
  const ctx = {
    tickers: [],
    airports: [],
    airlines: [],
    frameworkName: null,
    enabledPanels: [],
    disabledFeeds: [],
  };
  if (!prefs || typeof prefs !== 'object') return ctx;

  const watchlist = prefs['wm-market-watchlist-v1'];
  if (Array.isArray(watchlist)) {
    ctx.tickers = watchlist
      .filter(w => w && typeof w === 'object' && w.symbol)
      .map(w => w.symbol)
      .slice(0, 20);
  }

  const aviation = prefs['aviation:watchlist:v1'];
  if (aviation && typeof aviation === 'object') {
    if (Array.isArray(aviation.airports)) ctx.airports = aviation.airports.slice(0, 10);
    if (Array.isArray(aviation.airlines)) ctx.airlines = aviation.airlines.slice(0, 10);
  }

  const frameworks = prefs['wm-analysis-frameworks'];
  const panelFrameworks = prefs['wm-panel-frameworks'];
  if (frameworks && typeof frameworks === 'object') {
    const activeId = frameworks.activeId;
    const list = Array.isArray(frameworks.frameworks) ? frameworks.frameworks : [];
    const active = list.find(f => f && f.id === activeId);
    if (active && active.name) ctx.frameworkName = active.name;
  }
  if (!ctx.frameworkName && panelFrameworks && typeof panelFrameworks === 'object') {
    const firstActive = Object.values(panelFrameworks).find(v => v && typeof v === 'string');
    if (firstActive) ctx.frameworkName = firstActive;
  }

  const panels = prefs['worldmonitor-panels'];
  if (Array.isArray(panels)) {
    ctx.enabledPanels = panels.filter(p => typeof p === 'string').slice(0, 30);
  }

  const disabled = prefs['worldmonitor-disabled-feeds'];
  if (Array.isArray(disabled)) {
    ctx.disabledFeeds = disabled.filter(d => typeof d === 'string').slice(0, 20);
  }

  return ctx;
}

/**
 * Build a concise user profile string for LLM prompts.
 *
 * @param {{ tickers: string[], airports: string[], airlines: string[], frameworkName: string | null, enabledPanels: string[], disabledFeeds: string[] }} ctx
 * @param {string} variant
 * @returns {string}
 */
function formatUserProfile(ctx, variant) {
  const lines = [];
  lines.push(`Variant: ${variant}`);
  if (ctx.tickers.length > 0) lines.push(`Watches: ${ctx.tickers.join(', ')}`);
  if (ctx.airports.length > 0) lines.push(`Monitors airports: ${ctx.airports.join(', ')}`);
  if (ctx.airlines.length > 0) lines.push(`Monitors airlines: ${ctx.airlines.join(', ')}`);
  if (ctx.frameworkName) lines.push(`Analysis framework: ${ctx.frameworkName}`);
  if (ctx.enabledPanels.length > 0) lines.push(`Active domains: ${ctx.enabledPanels.slice(0, 15).join(', ')}`);
  if (ctx.disabledFeeds.length > 0) lines.push(`Ignores: ${ctx.disabledFeeds.slice(0, 10).join(', ')}`);
  return lines.join('\n');
}

module.exports = { fetchUserPreferences, extractUserContext, formatUserProfile };
