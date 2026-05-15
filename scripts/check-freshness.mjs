#!/usr/bin/env node
// Freshness watchdog: scans Redis for `seed:lastrun:*` markers and alerts via
// Slack when any tracked source is older than its threshold.
//
// Run on a 15-minute CronJob. Env:
//   REDIS_URL              — defaults to redis://redis-svc.hlidskjalf-monitor.svc:6379
//   SLACK_ALERTS_WEBHOOK   — Slack Incoming Webhook URL (required for alerts)

import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis-svc.hlidskjalf-monitor.svc:6379';
const SLACK_ALERTS_WEBHOOK = process.env.SLACK_ALERTS_WEBHOOK ?? '';

// Tracked sources with per-source staleness thresholds in milliseconds.
// 30m for weather-alerts (fast-moving), 1h for everything else by default.
const TRACKED = [
  { source: 'conflict-intel',     thresholdMs: 60 * 60 * 1000 },
  { source: 'weather-alerts',     thresholdMs: 30 * 60 * 1000 },
  { source: 'prediction-markets', thresholdMs: 60 * 60 * 1000 },
  { source: 'military-flights',   thresholdMs: 60 * 60 * 1000 },
  { source: 'climate-anomalies',  thresholdMs: 60 * 60 * 1000 },
  { source: 'portwatch',          thresholdMs: 60 * 60 * 1000 },
];

const fmtAge = (ms) => {
  if (!Number.isFinite(ms)) return 'never';
  const min = Math.floor(ms / 60000);
  if (min < 90) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 36) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
};

async function postSlack(stale) {
  if (!SLACK_ALERTS_WEBHOOK) {
    console.warn('[freshness] SLACK_ALERTS_WEBHOOK not set — skipping post');
    return;
  }
  const lines = stale.map(
    (s) => `• \`${s.source}\` — last run ${fmtAge(s.age)} ago (threshold ${fmtAge(s.thresholdMs)})`,
  );
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:warning: ${stale.length} stale data source(s)` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `checked at ${new Date().toISOString()} · namespace hlidskjalf-monitor` },
      ],
    },
  ];

  const res = await fetch(SLACK_ALERTS_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `[hlidskjalf] ${stale.length} stale source(s)`, blocks }),
  });
  if (!res.ok) {
    console.error('[freshness] slack post failed', res.status, await res.text().catch(() => ''));
  }
}

async function main() {
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  try {
    await redis.connect();
  } catch (err) {
    console.error('[freshness] redis connect failed:', err.message);
    process.exit(1);
  }

  const now = Date.now();
  const stale = [];

  for (const t of TRACKED) {
    const key = `seed:lastrun:${t.source}`;
    let raw;
    try {
      raw = await redis.get(key);
    } catch (err) {
      console.error(`[freshness] redis GET ${key} failed:`, err.message);
      stale.push({ source: t.source, age: Infinity, thresholdMs: t.thresholdMs });
      continue;
    }

    const ts = raw == null ? null : Number.parseInt(raw, 10);
    if (!ts || Number.isNaN(ts)) {
      stale.push({ source: t.source, age: Infinity, thresholdMs: t.thresholdMs });
      continue;
    }

    const age = now - ts;
    if (age > t.thresholdMs) {
      stale.push({ source: t.source, age, thresholdMs: t.thresholdMs });
    }
  }

  if (stale.length === 0) {
    console.log('[freshness] all tracked sources fresh');
    await redis.quit();
    return;
  }

  console.warn('[freshness] stale sources:', stale.map((s) => s.source).join(', '));
  await postSlack(stale);
  await redis.quit();
}

main().catch((err) => {
  console.error('[freshness] fatal:', err);
  process.exit(1);
});
