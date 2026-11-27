#!/usr/bin/env node
// Label real Saudi Civil Defense posts through the relay prompt, one post per completion at
// MAX_POST_CHARS, as publishSaudiCivilDefenseAlerts sends them (#11432). Read-only: no Redis.
// With --batched, every post goes in one completion, shuffled per pass: the producer sends
// all cache misses together when several posts arrive within its window.
//
//   node scripts/eval-classify-saudi-posts.mjs                    # print the captures, offline, free
//   node --env-file=.env.local scripts/eval-classify-saudi-posts.mjs --capture relay-current --force
//   node --env-file=.env.local scripts/eval-classify-saudi-posts.mjs --batched --capture relay-current-batched --force
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
const batched = argv.includes('--batched');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

const show = (name, c) => {
  console.log(`\n${name}  (${c.model}, prompt ${c.promptSha}, ${c.passes} passes, ${c.batched ? 'all posts per completion' : 'one post per completion'}, maxChars ${c.maxChars})`);
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

// Mirrors classifyFetchLlmSingle: same sanitising, clip and token budget (40 per post).
// Returns one level per text, 'unlabelled' when the answer has none.
async function label(texts) {
  const lines = texts.map((t, i) => `${i}|${t.replace(/[\n\r]/g, ' ').replace(/\|/g, '/').slice(0, MAX_POST_CHARS).trim()}`);
  const body = JSON.stringify({
    model,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: lines.join('\n') }],
    temperature: 0,
    max_tokens: texts.length * 40,
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
        // As publishSaudiCivilDefenseAlerts: an index answered more than once is discarded.
        return texts.map((_, i) => {
          const matches = entries.filter((e) => e?.i === i);
          return matches.length === 1 && LEVELS.includes(matches[0].l) ? matches[0].l : 'unlabelled';
        });
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  return texts.map(() => 'unlabelled');
}

// A fixed seed per pass, so a batched capture's orders can be reproduced.
function shuffled(rows, pass) {
  let a = (pass + 1) * 0x9e3779b1;
  const rand = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const jobs = batched
  ? Array.from({ length: PASSES }, (_, pass) => shuffled(fixture.rows, pass))
  : fixture.rows.flatMap((r) => Array.from({ length: PASSES }, () => [r]));
const labels = Object.fromEntries(fixture.rows.map((r) => [r.note, {}]));
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) {
    const rows = jobs[next++];
    const levels = await label(rows.map((r) => r.text));
    rows.forEach((r, i) => { labels[r.note][levels[i]] = (labels[r.note][levels[i]] ?? 0) + 1; });
  }
}));
fixture.captures[capture] = {
  model,
  promptSha: promptSha(prompt),
  passes: PASSES,
  batched,
  maxChars: MAX_POST_CHARS,
  usd: Number(usd.toFixed(4)),
  capturedAt: new Date().toISOString(),
  labels,
};
// The posts carry bidi marks; store them escaped so the repo's hidden-Unicode check passes.
const json = JSON.stringify(fixture, null, 1).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
writeFileSync(FIXTURE, `${json}\n`);
show(capture, fixture.captures[capture]);
console.log(`$${usd.toFixed(4)}; wrote captures["${capture}"]`);
