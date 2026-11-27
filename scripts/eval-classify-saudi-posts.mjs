#!/usr/bin/env node
// Label real Saudi Civil Defense posts through the relay prompt, one post per completion at
// MAX_POST_CHARS, as publishSaudiCivilDefenseAlerts sends them (#11432). Read-only: no Redis.
//
//   node scripts/eval-classify-saudi-posts.mjs                    # print the captures, offline, free
//   node --env-file=.env.local scripts/eval-classify-saudi-posts.mjs --capture relay-current --force
// 40 passes over the posts in tests/fixtures/classify-saudi-civil-defense-posts.json, about $0.02.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRelayOpenRouterModel, extractRelayPrompt, promptSha } from './lib/classify-eval.mjs';
import { OPENROUTER_PROVIDER_ROUTING } from './_llm-model-timeouts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = resolve(root, 'tests/fixtures/classify-saudi-civil-defense-posts.json');
const { MAX_POST_CHARS } = createRequire(import.meta.url)('./lib/saudi-civil-defense-alerts.cjs');
const LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const PASSES = 40;
const CONCURRENCY = 8;

const argv = process.argv.slice(2);
const capture = argv.includes('--capture') ? argv[argv.indexOf('--capture') + 1] : undefined;
const force = argv.includes('--force');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

const show = (name, c) => {
  console.log(`\n${name}  (${c.model}, prompt ${c.promptSha}, ${c.passes} passes, maxChars ${c.maxChars})`);
  for (const r of fixture.rows) console.log(`  ${JSON.stringify(c.labels[r.note])}  judge ${r.judge}  ${r.note}`);
};
if (!capture) {
  for (const [name, c] of Object.entries(fixture.captures)) show(name, c);
  process.exit(0);
}
if (fixture.captures[capture] && !force) throw new Error(`captures["${capture}"] exists; pass --force to replace it`);

const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (try node --env-file=.env.local)');
const relaySrc = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const prompt = extractRelayPrompt(relaySrc);
const model = extractRelayOpenRouterModel(relaySrc);
let usd = 0;

// Mirrors classifyFetchLlmSingle for one post: same sanitising, clip and token budget.
async function label(text) {
  const line = `0|${text.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, MAX_POST_CHARS).trim()}`;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: line }],
    temperature: 0,
    max_tokens: 40,
    reasoning: { enabled: false },
    provider: OPENROUTER_PROVIDER_ROUTING,
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://worldmonitor.app', 'X-Title': 'World Monitor', 'User-Agent': 'WorldMonitor-Eval/1.0' },
      });
      if (resp.ok) {
        const json = await resp.json();
        usd += json.usage?.cost ?? 0;
        const entries = JSON.parse(json.choices?.[0]?.message?.content?.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
        const level = entries.find((e) => e?.i === 0)?.l;
        return LEVELS.includes(level) ? level : 'unlabelled';
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return 'unlabelled';
}

const jobs = fixture.rows.flatMap((r) => Array.from({ length: PASSES }, () => r));
const labels = Object.fromEntries(fixture.rows.map((r) => [r.note, {}]));
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const r = jobs[next++];
    const level = await label(r.text);
    labels[r.note][level] = (labels[r.note][level] ?? 0) + 1;
  }
}));
fixture.captures[capture] = {
  model,
  promptSha: promptSha(prompt),
  passes: PASSES,
  maxChars: MAX_POST_CHARS,
  usd: Number(usd.toFixed(4)),
  capturedAt: new Date().toISOString(),
  labels,
};
writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
show(capture, fixture.captures[capture]);
console.log(`$${usd.toFixed(4)}; wrote captures["${capture}"]`);
