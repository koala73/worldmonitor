// Drives the relay's digest build watch (scripts/ais-relay.cjs
// checkDigestBuilds via the RELAY_TEST_MODE /__test/classify-build-watch seam)
// against local stand-ins for Upstash, the list-feed-digest API and the LLM.
//
// The relay used to read each edition's digest once per 15-minute cycle. Over
// 2026-11-10..17 that put a median 13.6 minutes (p90 28.2) between digest
// story tracking first seeing a headline and the alert being queued. The watch
// reads an edition as soon as the digest handler records a new build for it.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const EDITIONS = ['full', 'tech', 'finance', 'commodity', 'happy', 'energy'];
const QUEUE_KEY = 'wm:events:queue';
const LATENCY_KEY = 'relay:alert-latency:v1';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('relay did not answer')));
    req.on('error', reject);
  });
}

// The relay publishes and records without holding up the pass, so the writes
// land a moment after the seam answers.
async function until(check, waitingFor) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 5000) throw new Error(`timed out waiting for ${waitingFor()}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Upstash REST stand-in. `stamps` maps an edition to the build time its
// coverage ledger reports (absent = no ledger). The classify cache starts
// empty and remembers what the relay writes, like the real one.
async function startUpstash(t, stamps, { dedupHit = false, lpushFails = false } = {}) {
  const commands = [];
  const classifyCache = new Map();
  const storedValue = (key) => {
    const ledger = /^news:coverage-ledger:v1:([a-z]+):en$/.exec(String(key));
    if (ledger) {
      const at = stamps[ledger[1]];
      return at ? JSON.stringify({ v: 1, generatedAt: at, variant: ledger[1], lang: 'en' }) : null;
    }
    return classifyCache.get(String(key)) ?? null;
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let command = null;
      try { command = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* GET /get/<key> */ }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/pipeline') {
        const rows = Array.isArray(command) ? command : [];
        for (const row of rows) commands.push(row);
        return res.end(JSON.stringify(rows.map(([op, ...args]) => {
          if (op === 'MGET') return { result: args.map(storedValue) };
          if (op === 'GET') return { result: storedValue(args[0]) };
          return { result: 1 };
        })));
      }
      if (!Array.isArray(command)) return res.end(JSON.stringify({ result: null }));
      commands.push(command);
      if (command[0] === 'SET' && String(command[1]).startsWith('classify:')) classifyCache.set(command[1], command[2]);
      // SET NX on the scan-dedup key answers null when the key already exists.
      if (dedupHit && command[0] === 'SET' && String(command[1]).startsWith('wm:notif:scan-dedup:')) {
        return res.end(JSON.stringify({ result: null }));
      }
      if (command[0] === 'LPUSH') return res.end(JSON.stringify({ result: lpushFails ? 0 : 1 }));
      return res.end(JSON.stringify({ result: command[0] === 'EVAL' ? 1 : 'OK' }));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    commands,
    queued: () => commands.filter((c) => c[0] === 'LPUSH' && c[1] === QUEUE_KEY).map((c) => JSON.parse(c[2])),
    wrote: (key) => commands.some((c) => (c[0] === 'SET' || c[0] === 'ZADD') && c[1] === key),
    url: `http://127.0.0.1:${port}`,
  };
}

// list-feed-digest stand-in: one fresh headline per edition, and a record of
// which editions were requested, in order.
async function startDigestApi(t, { builtAt, down }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const variant = new URL(req.url, 'http://digest.test').searchParams.get('variant');
    requests.push(variant);
    if (down.has(variant)) {
      res.writeHead(500);
      return res.end();
    }
    const at = builtAt();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      generatedAt: new Date(at).toISOString(),
      categories: {
        world: {
          items: [{
            title: `Missile strike hits ${variant} capital`,
            source: 'Reuters World',
            publishedAt: at - 4 * 60_000,
            corroborationCount: 1,
            storyMeta: { firstSeen: at - 30_000 },
          }],
        },
      },
    }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, url: `http://127.0.0.1:${port}` };
}

// LLM stand-in: labels every headline critical.
async function startLlm(t) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const lines = body.messages.at(-1).content.split('\n');
      calls.push(lines);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(lines.map((_line, i) => ({ i, l: 'critical', c: 'conflict' }))) } }],
      }));
    });
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${port}` };
}

async function startRelay(t, stamps, upstashOptions) {
  const built = { at: Date.now() - 60_000 };
  const down = new Set();
  const upstash = await startUpstash(t, stamps, upstashOptions);
  const digest = await startDigestApi(t, { builtAt: () => built.at, down });
  const llm = await startLlm(t);
  const child = spawn(process.execPath, [relayScript], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: '0',
      RELAY_TEST_MODE: 'true',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      UPSTASH_REDIS_REST_URL: upstash.url,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
      API_BASE_URL: digest.url,
      OLLAMA_API_URL: llm.url,
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
  const watch = async () => {
    const res = await get(port, '/__test/classify-build-watch');
    assert.equal(res.status, 200, `build watch seam failed: ${res.body}\n${output}`);
    return JSON.parse(res.body);
  };
  const cycle = async () => {
    const res = await get(port, '/__test/seed-classify');
    assert.equal(res.status, 200, `classify seam failed: ${res.body}\n${output}`);
  };
  return { upstash, digest, llm, built, down, watch, cycle, output: () => output };
}

test('a rebuilt edition is classified and its alert queued without waiting for the cycle', async (t) => {
  const builtAt = Date.now() - 60_000;
  const { upstash, digest, llm, watch, output } = await startRelay(t, { full: builtAt });

  const result = await watch();
  assert.deepEqual(result.editions, ['full'], output());
  assert.deepEqual(digest.requests, ['full'], 'only the rebuilt edition is read');
  assert.equal(llm.calls.length, 1, 'one LLM call for the one new headline');

  await until(() => upstash.queued().length === 1, () => `one queued alert\n${output()}`);
  const queued = upstash.queued();
  assert.equal(queued[0].eventType, 'rss_alert');
  assert.equal(queued[0].severity, 'critical');
  assert.equal(queued[0].variant, 'full');
  assert.equal(queued[0].payload.title, 'Missile strike hits full capital');

  // A build pass covers one edition, so it must not publish what a whole
  // six-edition cycle owns.
  assert.equal(upstash.wrote('news:threat:summary:v1'), false);
  assert.equal(upstash.wrote('seed-meta:classify'), false);
  assert.equal(upstash.wrote('seed-meta:news:threat-summary'), false);
});

test('every queued alert logs and records how long it took, by stage', async (t) => {
  const { upstash, watch, output } = await startRelay(t, { full: Date.now() - 60_000 });
  await watch();

  // Logged once the event is in the queue, a moment after the pass returns.
  await until(() => output().includes('[Classify] alert latency'), () => `a latency line\n${output()}`);
  const line = output().split('\n').find((l) => l.startsWith('[Classify] alert latency'));
  const field = (name) => Number(new RegExp(`${name}=(\\d+)`).exec(line)?.[1]);
  // Published 4 minutes, first seen 30 s and built 60 s before the digest was read.
  assert.ok(field('publish_to_queue_s') >= 240 && field('publish_to_queue_s') < 330, line);
  assert.ok(field('seen_to_queue_s') >= 30 && field('seen_to_queue_s') < 120, line);
  assert.ok(field('build_to_queue_s') >= 60 && field('build_to_queue_s') < 150, line);
  assert.match(line, /over_budget=false severity=critical score=\d+ variant=full source="Reuters World"/);

  await until(
    () => upstash.commands.some((c) => c[0] === 'EXPIRE' && c[1] === LATENCY_KEY),
    () => `a latency sample\n${output()}`,
  );
  const sample = upstash.commands.find((c) => c[0] === 'ZADD' && c[1] === LATENCY_KEY);
  const record = JSON.parse(sample[3]);
  assert.equal(record.severity, 'critical');
  assert.equal(record.variant, 'full');
  assert.equal(record.source, 'Reuters World');
  assert.equal(Number(sample[2]), record.ts);
  assert.ok(record.buildToQueueMs >= 60_000 && record.buildToQueueMs < 150_000);
  assert.ok(record.publishToQueueMs >= 240_000);
  assert.ok(record.importanceScore >= 82, 'the delivery gate is unchanged: a fresh tier-1 critical still scores 82 or more');
  // The sample set is pruned and expires, so it cannot grow without bound.
  assert.ok(upstash.commands.some((c) => c[0] === 'ZREMRANGEBYSCORE' && c[1] === LATENCY_KEY));
  assert.ok(upstash.commands.some((c) => c[0] === 'EXPIRE' && c[1] === LATENCY_KEY));
});

test('nothing is read again until an edition is rebuilt', async (t) => {
  const stamps = { full: Date.now() - 60_000 };
  const { digest, llm, built, watch } = await startRelay(t, stamps);
  await watch();
  assert.deepEqual(digest.requests, ['full']);

  const idle = await watch();
  assert.deepEqual(idle.editions, []);
  assert.deepEqual(digest.requests, ['full'], 'an unchanged stamp costs no digest read');
  assert.equal(llm.calls.length, 1, 'and no LLM call');

  built.at = Date.now() - 20_000;
  stamps.full = built.at;
  const next = await watch();
  assert.deepEqual(next.editions, ['full']);
  assert.deepEqual(digest.requests, ['full', 'full']);
  assert.equal(llm.calls.length, 1, 'a headline already classified is not sent to the LLM again');
});

test('a build that has not been published yet is left for the next check', async (t) => {
  const { digest, watch } = await startRelay(t, { full: Date.now() });
  const result = await watch();
  assert.deepEqual(result.editions, []);
  assert.deepEqual(digest.requests, []);
});

test('full is read before another rebuilt edition, so it keeps first claim on a shared headline', async (t) => {
  const stamps = Object.fromEntries(EDITIONS.map((edition) => [edition, Date.now() - 60_000]));
  const { upstash, digest, built, watch } = await startRelay(t, stamps);

  // A restarted relay has classified nothing, so every edition is new.
  const first = await watch();
  assert.deepEqual(first.editions, EDITIONS);
  assert.deepEqual(digest.requests, EDITIONS);
  await until(() => upstash.queued().length === EDITIONS.length, () => 'one alert per edition');
  assert.deepEqual(upstash.queued().map((event) => event.variant).sort(), [...EDITIONS].sort());

  digest.requests.length = 0;
  built.at = Date.now() - 20_000;
  stamps.finance = built.at;
  const second = await watch();
  assert.deepEqual(second.editions, ['full', 'finance']);
  assert.deepEqual(digest.requests, ['full', 'finance']);
});

test('the 15-minute cycle counts as classifying the builds it read', async (t) => {
  const stamps = Object.fromEntries(EDITIONS.map((edition) => [edition, Date.now() - 90_000]));
  const { digest, cycle, watch } = await startRelay(t, stamps);
  await cycle();
  assert.deepEqual(digest.requests, EDITIONS);

  const result = await watch();
  assert.deepEqual(result.editions, [], 'the watch does not re-read what the cycle just classified');
  assert.deepEqual(digest.requests, EDITIONS);
});

test('an alert the publisher did not queue leaves no latency sample', async (t) => {
  // A dedup hit and a failed LPUSH both end with nothing new in the queue.
  for (const upstashOptions of [{ dedupHit: true }, { lpushFails: true }]) {
    const { upstash, llm, watch, output } = await startRelay(t, { full: Date.now() - 60_000 }, upstashOptions);
    await watch();
    assert.equal(llm.calls.length, 1);
    // The publish is not awaited by the pass; give it time to finish.
    await until(
      () => /Dedup hit|LPUSH failed/.test(output()),
      () => `the publisher's verdict (${JSON.stringify(upstashOptions)})\n${output()}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(upstash.queued().length, upstashOptions.lpushFails ? 1 : 0, 'the stand-in records the attempt, not a success');
    assert.equal(upstash.wrote(LATENCY_KEY), false, `no sample for ${JSON.stringify(upstashOptions)}\n${output()}`);
    assert.doesNotMatch(output(), /\[Classify\] alert latency/);
  }
});

test('a failed digest read does not use up the build: it is read again after a wait', async (t) => {
  const { upstash, digest, down, watch, output } = await startRelay(t, { full: Date.now() - 60_000 });
  down.add('full');
  const failed = await watch();
  assert.deepEqual(failed.editions, ['full']);
  assert.deepEqual(digest.requests, ['full']);
  assert.equal(upstash.queued().length, 0);

  // Not on the very next check: a failing API is not re-read every 20 seconds.
  down.delete('full');
  const waiting = await watch();
  assert.deepEqual(waiting.editions, [], output());
  assert.deepEqual(digest.requests, ['full']);

  // RELAY_TEST_MODE shortens the wait to 300 ms.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const retried = await watch();
  assert.deepEqual(retried.editions, ['full'], 'the same build is still new, because the failed read did not classify it');
  await until(() => upstash.queued().length === 1, () => `the alert from the retried build\n${output()}`);
});

test('a failed read of full stops the pass, and the other editions wait for its retry', async (t) => {
  const stamps = { full: Date.now() - 60_000, tech: Date.now() - 60_000 };
  const { upstash, digest, down, watch, output } = await startRelay(t, stamps);
  down.add('full');

  // tech is not read without full: it would take full's claim on a shared headline.
  const failed = await watch();
  assert.deepEqual(failed.editions, ['full'], output());
  assert.deepEqual(digest.requests, ['full']);

  // A newer tech build must not make the relay read full again during its wait.
  stamps.tech = Date.now() - 20_000;
  const held = await watch();
  assert.deepEqual(held.editions, []);
  assert.deepEqual(digest.requests, ['full'], 'full is not re-read during its retry wait, and tech waits with it');

  down.delete('full');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const retried = await watch();
  assert.deepEqual(retried.editions, ['full', 'tech']);
  await until(() => upstash.queued().length === 2, () => `both alerts\n${output()}`);
});

test('a failed read of full, when only another edition was rebuilt, still gets a retry wait', async (t) => {
  const stamps = { full: Date.now() - 60_000 };
  const { digest, down, built, watch, output } = await startRelay(t, stamps);
  await watch();
  assert.deepEqual(digest.requests, ['full']);

  // full is classified. tech is rebuilt, so full is read first for ordering, and that read fails.
  digest.requests.length = 0;
  built.at = Date.now() - 20_000;
  stamps.tech = built.at;
  down.add('full');
  const failed = await watch();
  assert.deepEqual(failed.editions, ['full'], output());
  assert.deepEqual(digest.requests, ['full']);

  const held = await watch();
  assert.deepEqual(held.editions, [], 'the failed ordering read set a retry wait');
  assert.deepEqual(digest.requests, ['full']);
});
