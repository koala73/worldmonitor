'use strict';

const { createHash } = require('node:crypto');

// This alert opt-in is narrower than the public Telegram trust registry.
const SAUDI_CIVIL_DEFENSE = { handle: 'SaudiDCD', name: 'Saudi Civil Defense', tier: 1 };
const MAX_POST_CHARS = 4096;
const MAX_AGE_MS = 15 * 60 * 1000;
const LEVELS = new Set(['critical', 'high', 'medium', 'low', 'info']);

async function publishSaudiCivilDefenseAlerts(items, { now, readCache, writeCache, classify, publish }) {
  const startedAt = now();
  const seen = new Set();
  const candidates = [];
  for (const item of items) {
    if (String(item?.channel).toLowerCase() !== SAUDI_CIVIL_DEFENSE.handle.toLowerCase()) continue;
    const messageId = /^saudidcd:([1-9]\d*)$/i.exec(item.id ?? '')?.[1];
    const publishedAt = Date.parse(item.ts);
    const title = typeof item.text === 'string' ? item.text.trim() : '';
    if (!messageId || !title || item.textTruncated || title.length > MAX_POST_CHARS) continue;
    if (!Number.isFinite(publishedAt) || publishedAt > startedAt || startedAt - publishedAt > MAX_AGE_MS) continue;
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    candidates.push({
      title,
      source: SAUDI_CIVIL_DEFENSE.name,
      link: `https://t.me/${SAUDI_CIVIL_DEFENSE.handle}/${messageId}`,
      publishedAt,
      countryCode: 'SA',
      corroborationCount: 1,
      coalesceKey: `telegram:saudidcd:${messageId}`,
    });
  }

  const cacheKeys = candidates.map((payload) => {
    const hash = createHash('sha256').update(payload.title).digest('hex').slice(0, 16);
    return `telegram:saudidcd:classification:v1:${hash}`;
  });
  const levels = await Promise.all(cacheKeys.map((key) => readCache(key)));
  const misses = candidates.map((_, i) => i).filter((i) => !LEVELS.has(levels[i]));
  if (misses.length) {
    const result = await classify(misses.map((i) => candidates[i].title));
    if (Array.isArray(result)) {
      for (const entry of result) {
        if (!Number.isInteger(entry?.i) || entry.i < 0 || entry.i >= misses.length || !LEVELS.has(entry.l)) continue;
        if (result.filter((other) => other?.i === entry.i).length !== 1) continue;
        const index = misses[entry.i];
        levels[index] = entry.l;
        await writeCache(cacheKeys[index], entry.l, 3600);
      }
    }
  }
  for (let i = 0; i < candidates.length; i++) {
    const payload = candidates[i];
    const level = levels[i];
    if (level !== 'high' && level !== 'critical') continue;
    if (now() - payload.publishedAt > MAX_AGE_MS) continue;
    // Reoffer cached classifications: the shared publisher owns delivery dedup
    // and rolls it back on a queue failure so the next pass can retry.
    await publish({
      eventType: 'rss_alert',
      payload: { ...payload, title: payload.title.length > 500 ? `${payload.title.slice(0, 499)}…` : payload.title },
      severity: level,
      variant: 'full',
    });
  }
}

module.exports = { SAUDI_CIVIL_DEFENSE, MAX_POST_CHARS, publishSaudiCivilDefenseAlerts };
