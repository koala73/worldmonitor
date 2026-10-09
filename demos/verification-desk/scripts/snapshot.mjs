#!/usr/bin/env node
// Archives the live digest so the desk can grade headlines from days ago.
// The MCP news tools only see the current window; run this every 30 minutes
// (npm run snapshot:loop, or cron) from now until the panel.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ARCHIVE_DIR, loadEnv } from '../lib/config.mjs';
import { dig, WorldMonitorMcp } from '../lib/mcp-client.mjs';
import { FULL_CATEGORIES, gdeltArticlesFrom } from '../lib/sources.mjs';

loadEnv();

async function snapshot() {
  const mcp = new WorldMonitorMcp({
    url: process.env.WORLDMONITOR_MCP_URL || 'https://worldmonitor.app/mcp',
    apiKey: process.env.WORLDMONITOR_API_KEY,
    bearerToken: process.env.WORLDMONITOR_MCP_TOKEN,
  });
  const takenAt = new Date().toISOString();
  const calls = [
    ['all', () => mcp.callTool('get_news_clusters', { limit: 25 })],
    ...FULL_CATEGORIES.map((category) => [category, () => mcp.callTool('get_news_clusters', { category, limit: 25 })]),
  ];
  const clusters = new Map();
  const errors = [];
  for (const [label, call] of calls) {
    try {
      const out = await call();
      for (const c of out.clusters ?? []) clusters.set(c.id, { ...c, category: label });
    } catch (error) {
      errors.push(`${label}: ${error.message}`);
    }
  }
  let intelligenceStories = [];
  let gdeltArticles = [];
  try {
    const intel = await mcp.callTool('get_news_intelligence', { limit: 0 });
    intelligenceStories = dig(intel, 'topStories') ?? [];
    gdeltArticles = gdeltArticlesFrom(intel);
  } catch (error) {
    errors.push(`intelligence: ${error.message}`);
  }
  let brief = null;
  try {
    const b = await mcp.callTool('get_world_brief', {});
    brief = { headlines: b.headlines ?? [], topStories: b.topStories ?? [], generatedAt: b.generatedAt ?? null };
  } catch (error) {
    errors.push(`brief: ${error.message}`);
  }
  await mkdir(ARCHIVE_DIR, { recursive: true });
  const file = path.join(ARCHIVE_DIR, `${takenAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify({ takenAt, clusters: [...clusters.values()], intelligenceStories, gdeltArticles, brief, errors }));
  console.log(`${takenAt}  ${clusters.size} clusters, ${intelligenceStories.length} stories${errors.length ? `, ${errors.length} errors: ${errors.slice(0, 3).join('; ')}` : ''}  -> ${path.basename(file)}`);
  if (!clusters.size && errors.length) process.exitCode = 1;
}

const loopMinutes = Number(process.argv.find((a) => a.startsWith('--every='))?.slice(8) || 0);
await snapshot();
if (loopMinutes > 0) {
  setInterval(() => snapshot().catch((e) => console.error(e.message)), loopMinutes * 60_000);
}
