#!/usr/bin/env node
// Pre-show check. Run it at the venue on the venue network:
//   npm run check
// Every line is PASS / WARN / FAIL with what to do about it.

import { existsSync, readdirSync } from 'node:fs';
import { ARCHIVE_DIR, DATA_DIR, loadEnv } from '../lib/config.mjs';
import { Anchor } from '../lib/anchor.mjs';
import { WorldMonitorMcp } from '../lib/mcp-client.mjs';
import path from 'node:path';

loadEnv();
let failed = false;
const pass = (m) => console.log(`PASS  ${m}`);
const warn = (m) => console.log(`WARN  ${m}`);
const fail = (m) => { failed = true; console.log(`FAIL  ${m}`); };

const REQUIRED_TOOLS = ['get_news_clusters', 'get_news_intelligence', 'get_prediction_markets', 'get_world_brief'];

if (!process.env.WORLDMONITOR_API_KEY && !process.env.WORLDMONITOR_MCP_TOKEN) {
  fail('WORLDMONITOR_API_KEY is not set in demos/verification-desk/.env');
} else {
  try {
    const mcp = new WorldMonitorMcp({ url: process.env.WORLDMONITOR_MCP_URL || 'https://worldmonitor.app/mcp', apiKey: process.env.WORLDMONITOR_API_KEY, bearerToken: process.env.WORLDMONITOR_MCP_TOKEN });
    const tools = new Set((await mcp.listTools()).map((t) => t.name));
    const missing = REQUIRED_TOOLS.filter((t) => !tools.has(t));
    if (missing.length) fail(`MCP is up but these tools are not available to this key: ${missing.join(', ')}`);
    else pass(`WorldMonitor MCP: ${tools.size} tools, all required tools present`);
    const clusters = await mcp.callTool('get_news_clusters', { limit: 3 });
    const n = clusters.clusters?.length ?? 0;
    if (n) pass(`get_news_clusters live: ${clusters.headlineCount} headlines in the digest, generated ${clusters.generatedAt}`);
    else fail('get_news_clusters returned no clusters');
    const markets = await mcp.callTool('get_prediction_markets', { limit: 2 }).catch((e) => ({ error: e.message }));
    if (markets.error) warn(`get_prediction_markets: ${markets.error} (the money check will show "no market")`);
    else pass('get_prediction_markets reachable');
  } catch (error) {
    fail(`WorldMonitor MCP: ${error.message}`);
  }
}

if (!process.env.ANTHROPIC_API_KEY) {
  warn('ANTHROPIC_API_KEY not set: the anchor will speak fixed templates (still works).');
} else {
  try {
    const anchor = new Anchor();
    const t0 = Date.now();
    const terms = await anchor.searchTerms('Fed holds rates steady as inflation cools', []);
    if (!terms.length) throw new Error('no terms returned');
    pass(`Claude (${anchor.model}) answered in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${terms.join(', ')}`);
  } catch (error) {
    fail(`Claude: ${error.message}`);
  }
}

if (process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID) {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(process.env.ELEVENLABS_VOICE_ID)}`, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } });
    if (res.ok) pass('ElevenLabs voice reachable');
    else fail(`ElevenLabs HTTP ${res.status}: check ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID`);
  } catch (error) {
    fail(`ElevenLabs: ${error.message}`);
  }
} else {
  warn('ElevenLabs not configured: the browser voice will speak (use Chrome or Edge for the best voice).');
}

const snaps = existsSync(ARCHIVE_DIR) ? readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.json')).sort() : [];
if (snaps.length) pass(`Archive: ${snaps.length} snapshots, oldest ${snaps[0].slice(0, 16)}, newest ${snaps.at(-1).slice(0, 16)}`);
else warn('No archive snapshots: only headlines in the live digest window can be matched. Run npm run snapshot:loop.');

if (existsSync(path.join(DATA_DIR, 'reveal.json'))) pass('Reveal story pinned (data/reveal.json)');
else warn('No reveal pinned: run npm run find-reveal, read the links, then npm run find-reveal -- --pick N');

if (existsSync(path.join(DATA_DIR, 'cache', 'recap.json'))) pass('Recap cached for offline fallback');
else warn('Recap not cached yet: open the desk and press R once while online.');

process.exitCode = failed ? 1 : 0;
