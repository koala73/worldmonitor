// Drives real relay classify cycles (scripts/ais-relay.cjs via the
// RELAY_TEST_MODE /__test/seed-classify seam) against local stand-ins for
// Upstash, the list-feed-digest API, the classify LLM and OpenRouter (the
// cross-wording embeddings and judge, reached through
// tests/_lib/ais-relay-openrouter-preload.cjs).
//
// 2026-11-24 18:43Z: "Three Sinokor VLCCs hit in latest Strait of Hormuz
// attacks" alerted at 82 with four publisher families from other wordings of
// the incident (#10977). The next pass read its label from the classify cache,
// scored it 73 with no families, and queued it again on a lower audience's
// story key.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { reachesRealtimeRules } = require('../scripts/lib/news-story-key.cjs');

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const preload = fileURLToPath(new URL('./_lib/ais-relay-openrouter-preload.cjs', import.meta.url));
const EVENT_QUEUE = 'wm:events:queue';
const API_FANOUT_LIST = 'wm:events:api:v1';
const SIGHTINGS_KEY = 'news:story-sightings:v1';

const TITLE = 'Three tankers struck by projectiles near the Strait of Hormuz, shipping firm says';
// An unlisted feed scores as tier 4, so the copy alone sits under the realtime bar.
const SOURCE = 'Cached Wording Test Feed';
const OTHER_WORDING = 'Shipping firm says three of its tankers were hit by projectiles near Hormuz';
const OTHER_FAMILIES = ['label:wording test wire', 'label:wording test daily', 'label:wording test radio'];

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 30_000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('relay did not answer')));
    req.on('error', reject);
  });
}

// Upstash REST stand-in with strings and sorted sets.
async function startUpstash(t) {
  const strings = new Map();
  const zsets = new Map();
  const queued = [];
  const apiFanout = [];
  const bound = (raw) => {
    const s = String(raw);
    if (s === '-inf') return { v: -Infinity, open: false };
    if (s === '+inf') return { v: Infinity, open: false };
    return s.startsWith('(') ? { v: Number(s.slice(1)), open: true } : { v: Number(s), open: false };
  };
  const inRange = (score, min, max) => (min.open ? score > min.v : score >= min.v) && (max.open ? score < max.v : score <= max.v);
  const run = (command) => {
    const [name, key, ...args] = command;
    if (name === 'GET') return strings.get(key) ?? null;
    if (name === 'SET') {
      if (args.includes('NX') && strings.has(key)) return null;
      strings.set(key, args[0]);
      return 'OK';
    }
    if (name === 'DEL') return strings.delete(key) ? 1 : 0;
    if (name === 'LPUSH') {
      if (key === EVENT_QUEUE) queued.push(JSON.parse(args[0]));
      return 1;
    }
    if (name === 'EVAL') {
      if (command[3] === API_FANOUT_LIST) apiFanout.push(JSON.parse(command[4]));
      return 1;
    }
    if (name === 'ZADD') {
      const set = zsets.get(key) ?? new Map();
      for (let i = 0; i + 1 < args.length; i += 2) set.set(args[i + 1], Number(args[i]));
      zsets.set(key, set);
      return args.length / 2;
    }
    if (name === 'ZRANGEBYSCORE') {
      const [min, max] = [bound(args[0]), bound(args[1])];
      const rows = [...(zsets.get(key) ?? new Map())].filter(([, score]) => inRange(score, min, max)).sort((a, b) => a[1] - b[1]);
      return args.includes('WITHSCORES') ? rows.flatMap(([member, score]) => [member, String(score)]) : rows.map(([member]) => member);
    }
    if (name === 'ZREMRANGEBYSCORE' || name === 'ZREMRANGEBYRANK' || name === 'EXPIRE') return 0;
    return 'OK';
  };
  const server = http.createServer(async (req, res) => {
    let command = null;
    try { command = JSON.parse(await readBody(req)); } catch { /* not a command body */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/pipeline') {
      return res.end(JSON.stringify((Array.isArray(command) ? command : []).map((row) => ({ result: run(row) }))));
    }
    return res.end(JSON.stringify({ result: Array.isArray(command) ? run(command) : null }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const ofTitle = (events) => events.filter((e) => e.eventType === 'rss_alert' && e.variant === 'full' && e.payload.title === TITLE);
  return {
    url: `http://127.0.0.1:${port}`,
    zadd: (key, score, member) => run(['ZADD', key, String(score), member]),
    alerts: () => ofTitle(queued),
    apiEvents: () => ofTitle(apiFanout),
  };
}

async function startDigestApi(t) {
  const state = { items: [] };
  const server = http.createServer((req, res) => {
    const variant = new URL(req.url, 'http://digest.test').searchParams.get('variant');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ categories: { world: { items: variant === 'full' ? state.items : [] } } }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}`, state };
}

// Classify stand-in: every headline is critical terrorism.
async function startClassifyLlm(t) {
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const lines = String(body.messages.at(-1).content).split('\n').filter(Boolean);
    const labels = lines.map((line) => ({ i: Number(line.split('|')[0]), l: 'critical', c: 'terrorism' }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(labels) } }] }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}` };
}

// OpenRouter stand-in: one embedding for every text, so every pair is
// retrieved, and a judge that calls every pair the same incident.
async function startOpenRouter(t) {
  const state = { judged: 0 };
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1/embeddings') {
      return res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: new Array(512).fill(1) })) }));
    }
    if (req.url === '/api/v1/chat/completions' && String(body.messages.at(-1)?.content).startsWith('Headline A:')) {
      state.judged++;
      return res.end(JSON.stringify({ choices: [{ message: { content: '{"same":true}' } }] }));
    }
    res.writeHead(500);
    return res.end('{}');
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}`, state };
}

async function startRelay(t) {
  const upstash = await startUpstash(t);
  const digest = await startDigestApi(t);
  const llm = await startClassifyLlm(t);
  const openRouter = await startOpenRouter(t);
  const child = spawn(process.execPath, ['--require', preload, relayScript], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: '0',
      RELAY_BIND_HOST: '127.0.0.1',
      RELAY_TEST_MODE: 'true',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      RELAY_GATES_READY: '1',
      UPSTASH_REDIS_REST_URL: upstash.url,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
      API_BASE_URL: digest.url,
      OLLAMA_API_URL: llm.url,
      OPENROUTER_API_KEY: 'test-openrouter-key',
      TEST_OPENROUTER_URL: openRouter.url,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const started = Date.now();
  while (!output.includes('Test mode enabled')) {
    if (child.exitCode != null) throw new Error(`relay exited ${child.exitCode}: ${output}`);
    if (Date.now() - started > 20_000) throw new Error(`relay did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const port = Number(output.match(/WebSocket relay on port (\d+)/)[1]);
  const cycle = async (items) => {
    digest.state.items = items;
    const trigger = await get(port, '/__test/seed-classify');
    assert.equal(trigger.status, 200, `classify seam failed: ${trigger.body}\n${output}`);
  };
  return { upstash, openRouter, cycle, output: () => output };
}

test('a headline republished from the classify cache keeps the publishers other wordings added', async (t) => {
  const { upstash, openRouter, cycle, output } = await startRelay(t);
  const now = Date.now();
  for (const family of OTHER_FAMILIES) {
    upstash.zadd(SIGHTINGS_KEY, now - 60 * 60_000, JSON.stringify({ title: OTHER_WORDING, family, level: 'critical' }));
  }
  const items = [{ title: TITLE, source: SOURCE, link: 'https://example.test/tankers', publishedAt: now }];

  await cycle(items);
  const [fresh, ...extra] = upstash.alerts();
  assert.ok(fresh, `the fresh label alerts\n${output()}`);
  assert.deepEqual(extra, []);
  assert.ok(openRouter.state.judged > 0, `the judge ran on the fresh label\n${output()}`);
  assert.ok(fresh.payload.corroboratedBy?.length > OTHER_FAMILIES.length, `the other wording's publishers count\n${output()}`);
  assert.ok(reachesRealtimeRules('critical', fresh.payload.importanceScore), `families lift it to the realtime bar: ${fresh.payload.importanceScore}`);
  const judged = openRouter.state.judged;

  await cycle(items);
  assert.equal(openRouter.state.judged, judged, 'the cached republish asks the judge nothing');
  // The webhook copy goes out on a request the classify seam does not wait for.
  const deadline = Date.now() + 5_000;
  while (upstash.apiEvents().length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(upstash.apiEvents().length, 2, `webhook subscribers get the fresh alert and the cached republish\n${output()}`);
  assert.deepEqual(
    upstash.alerts().map((e) => e.payload.importanceScore),
    [fresh.payload.importanceScore],
    `the cached republish must not queue a second alert\n${output()}`,
  );
  const repeat = upstash.apiEvents().at(-1);
  assert.equal(repeat.payload.importanceScore, fresh.payload.importanceScore, 'the cached republish scores as the fresh label did');
  assert.deepEqual(repeat.payload.corroboratedBy, fresh.payload.corroboratedBy);
});
