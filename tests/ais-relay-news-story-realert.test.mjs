// Drives real relay classify cycles (scripts/ais-relay.cjs seedClassify via the
// RELAY_TEST_MODE /__test/seed-classify seam) against local stand-ins for
// Upstash, the list-feed-digest API and the LLM, and counts the rss_alert
// events the relay queues for one story.
//
// 2026-11-17: CNN published an exclusive at 22:59 UTC and the relay alerted on
// it at 23:45. Egypt Independent republished the same text under the same
// headline at 07:52, and the relay alerted again at 08:19 as fresh
// single-publisher news, nine hours after the story broke. The two titles
// differed only by the " - CNN" suffix the CNN feed carries, and the alert
// identity was the exact title string.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const relayScript = fileURLToPath(new URL('../scripts/ais-relay.cjs', import.meta.url));
const EVENT_QUEUE = 'wm:events:queue';
// The list the relay tees news and market events onto for API webhook subscribers.
const API_FANOUT_LIST = 'wm:events:api:v1';

const CNN_TITLE = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say - CNN';
const EGYPT_INDEPENDENT_TITLE = 'Exclusive: US intel indicates Iran developing plans to potentially detonate a dirty bomb in Washington, sources say';
const NDTV_TITLE = "Iran Plans To Detonate 'Dirty Bomb' In Washington, Warns US Intel: Report";
// The same headline from an aggregator feed and from the publisher's own feed.
const AGGREGATED_TITLE = 'Tankers hit in Strait of Hormuz as drone raises alarm at Iraq gas field - Al Jazeera';
const DIRECT_TITLE = 'Tankers hit in Strait of Hormuz as drone raises alarm at Iraq gas field';

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

// Upstash REST stand-in that keeps state, so SET NX answers as Redis does:
// "OK" for a new key and null for one that exists. `failLpush` makes the event
// queue refuse writes; `failLpushCount` refuses only that many. `failSetNx`
// answers SET NX with an error, as Upstash does in a partial outage; `failDel`
// does the same for DEL, leaving the key in place.
async function startUpstash(t) {
  const store = new Map();
  const queued = [];
  const apiFanout = [];
  const state = { failLpush: false, failLpushCount: 0, failSetNx: false, truncateDel: false, failDel: false };
  const run = (command) => {
    const [name, key, value, ...rest] = command;
    if (name === 'GET') return store.has(key) ? store.get(key).value : null;
    if (name === 'SET') {
      if (rest.includes('NX') && state.failSetNx) return 'ERR simulated outage';
      if (rest.includes('NX') && store.has(key)) return null;
      const ex = rest.indexOf('EX');
      store.set(key, { value, ttl: ex >= 0 ? Number(rest[ex + 1]) : null });
      return 'OK';
    }
    if (name === 'DEL') return state.failDel ? 'ERR simulated outage' : (store.delete(key) ? 1 : 0);
    if (name === 'LPUSH') {
      if (key === EVENT_QUEUE) {
        if (state.failLpush) return 0;
        if (state.failLpushCount > 0) { state.failLpushCount -= 1; return 0; }
        queued.push(JSON.parse(value));
      }
      return 1;
    }
    if (name === 'EVAL') {
      // ['EVAL', script, numkeys, key, ...args]: the tee's first argument is the message.
      if (command[3] === API_FANOUT_LIST) apiFanout.push(JSON.parse(command[4]));
      return 1;
    }
    return 'OK';
  };
  const server = http.createServer(async (req, res) => {
    let command = null;
    try { command = JSON.parse(await readBody(req)); } catch { /* not a command body */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/pipeline') {
      return res.end(JSON.stringify((Array.isArray(command) ? command : []).map((row) => ({ result: run(row) }))));
    }
    if (state.truncateDel && Array.isArray(command) && command[0] === 'DEL') {
      // Apply the delete, then drop the connection after the headers, so the
      // response closes without ever ending.
      run(command);
      res.writeHead(200);
      res.flushHeaders();
      return setTimeout(() => res.socket?.destroy(), 20);
    }
    return res.end(JSON.stringify({ result: Array.isArray(command) ? run(command) : null }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    store,
    alerts: (variant = 'full') => queued.filter((e) => e.eventType === 'rss_alert' && e.variant === variant),
    apiEvents: (variant = 'full') => apiFanout.filter((e) => e.eventType === 'rss_alert' && e.variant === variant),
  };
}

// list-feed-digest stand-in: serves `state.items` on the full edition only,
// as production did for this story.
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

// Chat-completions stand-in: labels every headline `terrorism`, at the level
// `state.levels` gives its title (critical when unlisted). Titles in
// `state.unanswered` get no label; `state.asked` records every title sent.
// `state.onRequest` runs before each answer, and `state.fail` answers 500.
async function startLlm(t) {
  const state = { levels: {}, unanswered: new Set(), asked: [], onRequest: null, fail: false };
  const server = http.createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    state.onRequest?.();
    const lines = String(body.messages.at(-1).content).split('\n');
    const labels = lines.flatMap((line) => {
      const [index, ...rest] = line.split('|');
      const title = rest.join('|');
      state.asked.push(title);
      return state.unanswered.has(title) ? [] : [{ i: Number(index), l: state.levels[title] ?? 'critical', c: 'terrorism' }];
    });
    if (state.fail) { res.writeHead(500); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(labels) } }] }));
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}`, state };
}

async function startRelay(t) {
  const upstash = await startUpstash(t);
  const digest = await startDigestApi(t);
  const llm = await startLlm(t);
  const child = spawn(process.execPath, [relayScript], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: '0',
      // Bind the address the test dials. On the default dual-stack bind the
      // OS can hand the relay a port another test's 127.0.0.1 listener holds,
      // and the request then reaches that listener instead.
      RELAY_BIND_HOST: '127.0.0.1',
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
  // One classify cycle over the given digest items.
  const cycle = async (items) => {
    digest.state.items = items.map((item) => ({ publishedAt: Date.now(), ...item }));
    const trigger = await get(port, '/__test/seed-classify');
    assert.equal(trigger.status, 200, `classify seam failed: ${trigger.body}\n${output}`);
  };
  return { upstash, llm, cycle, output: () => output };
}

const titles = (events) => events.map((e) => e.payload.title);

test('a publisher repeating an alerted headline does not raise a second alert for the story', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);

  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  assert.deepEqual(titles(upstash.alerts()), [CNN_TITLE], `the first sighting alerts\n${output()}`);

  // Hours later the original has left the feed window and a second publisher
  // carries the same headline without the feed's " - CNN" suffix.
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Egypt Independent' }]);
  assert.deepEqual(
    titles(upstash.alerts()),
    [CNN_TITLE],
    `the republication must not alert again\n${output()}`,
  );
});

test('API webhook subscribers still get the repeat, to filter for themselves', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  // A repeat from the label cache is re-published only when it reaches
  // realtime rules, as a Reuters copy does.
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Reuters' }]);

  // One alert for realtime rules. Webhook subscribers each apply their own
  // importance floor, severity and keywords, so the sighting that claimed the
  // story may be one a subscriber rejected.
  assert.deepEqual(titles(upstash.alerts()), [CNN_TITLE], output());
  assert.deepEqual(titles(upstash.apiEvents()), [CNN_TITLE, EGYPT_INDEPENDENT_TITLE], output());
  // Both carry one event id (occurrence-events.cjs normalizes the headline),
  // which is what the webhook worker dedupes each subscription on.
  assert.equal(upstash.apiEvents()[0].payload.eventId, upstash.apiEvents()[1].payload.eventId);
});

test('the story stays claimed for a day, the window an exact repeat is already held for', async (t) => {
  const { upstash, cycle } = await startRelay(t);
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  const claims = [...upstash.store].filter(([key]) => key.startsWith('wm:notif:scan-dedup:rss_alert:full:'));
  assert.deepEqual(claims.map(([, claim]) => claim.ttl), [86_400]);
});

test('a later copy of a story takes the label the story already has', async (t) => {
  const { upstash, llm, cycle, output } = await startRelay(t);
  // One story gets one label (#10976): the copy without the " - CNN" suffix
  // reads the cached label instead of asking the classifier again.
  llm.state.levels = { [CNN_TITLE]: 'high', [EGYPT_INDEPENDENT_TITLE]: 'critical' };

  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Reuters' }]);

  assert.deepEqual(llm.state.asked, [CNN_TITLE], output());
  assert.deepEqual(upstash.alerts().map((e) => [e.severity, e.payload.title]), [['high', CNN_TITLE]], output());
});

test('a copy that hits the label cache still alerts once when it reaches realtime rules', async (t) => {
  const { upstash, llm, cycle, output } = await startRelay(t);
  // The unlisted aggregator is tier 4, so its critical copy scores 73 and
  // reaches nobody. The Al Jazeera copy reads that cached label and scores
  // 82 or more. A third, Reuters copy is the same story and is stopped by
  // the story key.
  await cycle([{ title: AGGREGATED_TITLE, source: 'An Unlisted Aggregator' }]);
  await cycle([{ title: DIRECT_TITLE, source: 'Al Jazeera' }]);
  await cycle([{ title: `${DIRECT_TITLE} - Reuters`, source: 'Reuters' }]);

  assert.deepEqual(llm.state.asked, [AGGREGATED_TITLE], output());
  const alerts = upstash.alerts();
  assert.deepEqual(titles(alerts), [AGGREGATED_TITLE, DIRECT_TITLE], output());
  assert.ok(alerts[0].payload.importanceScore < 82, `first copy scored ${alerts[0].payload.importanceScore}`);
  assert.ok(alerts[1].payload.importanceScore >= 82, `second copy scored ${alerts[1].payload.importanceScore}`);
});

test('two copies of one story in one cycle are classified once and keep the real label', async (t) => {
  const { upstash, llm, cycle, output } = await startRelay(t);
  // If both copies went in one request and only one were answered, the
  // unanswered copy's skip marker would land on the same cache row.
  llm.state.unanswered.add(EGYPT_INDEPENDENT_TITLE);
  await cycle([
    { title: CNN_TITLE, source: 'CNN World' },
    { title: EGYPT_INDEPENDENT_TITLE, source: 'Egypt Independent' },
  ]);
  assert.deepEqual(llm.state.asked, [CNN_TITLE], output());
  const rows = [...upstash.store].filter(([key]) => key.startsWith('classify:sebuf:v6:'));
  assert.deepEqual(rows.map(([, row]) => JSON.parse(row.value).level), ['critical'], output());
});

for (const [failure, fail] of [['leaves the story unanswered', (llm) => llm.state.unanswered.add(CNN_TITLE)], ['fails the request', (llm) => { llm.state.fail = true; }]]) {
  test(`a skip marker does not replace a label stored while the classifier ${failure}`, async (t) => {
    const { upstash, llm, cycle, output } = await startRelay(t);
    await cycle([{ title: `${EGYPT_INDEPENDENT_TITLE} - Reuters`, source: 'Reuters' }]);
    const [[key, label]] = [...upstash.store].filter(([k]) => k.startsWith('classify:sebuf:v6:'));
    upstash.store.delete(key);

    // Another writer stores the story's label after this pass read the row empty.
    llm.state.onRequest = () => upstash.store.set(key, label);
    fail(llm);
    await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);

    assert.equal(llm.state.asked.at(-1), CNN_TITLE, output());
    assert.deepEqual(upstash.store.get(key), label, output());
    assert.equal(label.ttl, 86_400);
  });
}

test('a cached copy below realtime rules reaches neither the queue nor webhook subscribers', async (t) => {
  const { upstash, llm, cycle, output } = await startRelay(t);
  llm.state.levels = { [CNN_TITLE]: 'high' };
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Reuters' }]);
  assert.deepEqual(titles(upstash.alerts()), [CNN_TITLE], output());
  assert.deepEqual(titles(upstash.apiEvents()), [CNN_TITLE], output());
});

test('a cached headline too short for a story key never alerts again', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  const short = 'Iran invades Iraq';
  await cycle([{ title: short, source: 'Reuters' }]);
  assert.deepEqual(upstash.alerts().map((e) => [e.payload.title, e.payload.importanceScore >= 82]), [[short, true]], output());

  // The exact-title claim lasts 30 minutes; the label lasts a day.
  for (const key of [...upstash.store.keys()]) if (key.startsWith('wm:notif:scan-dedup:')) upstash.store.delete(key);
  await cycle([{ title: short, source: 'Reuters' }]);
  assert.deepEqual(titles(upstash.alerts()), [short], output());
});

test('a headline served again every cycle alerts once', async (t) => {
  const { upstash, llm, cycle, output } = await startRelay(t);
  for (let i = 0; i < 3; i += 1) await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  assert.deepEqual(llm.state.asked, [CNN_TITLE], output());
  assert.deepEqual(titles(upstash.alerts()), [CNN_TITLE], output());
});

test('a cached tier-4 headline alerts once when more outlets carry it', async (t) => {
  const { upstash, llm, cycle, output } = await startRelay(t);
  // The digest serves the same title every cycle with a rising outlet count.
  for (const corroborationCount of [1, 2, 3, 4, 5]) {
    await cycle([{ title: AGGREGATED_TITLE, source: 'An Unlisted Aggregator', corroborationCount }]);
  }
  assert.deepEqual(llm.state.asked, [AGGREGATED_TITLE], output());
  const scores = upstash.alerts().map((e) => e.payload.importanceScore);
  assert.equal(scores.length, 2, output());
  assert.ok(scores[0] < 82 && scores[1] >= 82, `scored ${scores}`);
});

test('a critical sighting scored below the delivery bar does not use up the story', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  // An unlisted feed label is tier 4, which puts a fresh critical headline at
  // 73: below the 82 a realtime rule requires, so nobody receives it.
  await cycle([{ title: AGGREGATED_TITLE, source: 'An Unlisted Aggregator' }]);
  await cycle([{ title: DIRECT_TITLE, source: 'Al Jazeera' }]);

  const alerts = upstash.alerts();
  assert.deepEqual(titles(alerts), [AGGREGATED_TITLE, DIRECT_TITLE], output());
  assert.ok(alerts[0].payload.importanceScore < 82, `first sighting scored ${alerts[0].payload.importanceScore}`);
  assert.ok(alerts[1].payload.importanceScore >= 82, `second sighting scored ${alerts[1].payload.importanceScore}`);
});

test('the story key stays out of the queued event', async (t) => {
  // The notification relay keys per-user dedup on payload.coalesceKey when it
  // is set. Alerts a browser submits carry none, so a key here would stop the
  // two paths collapsing for one user.
  const { upstash, cycle } = await startRelay(t);
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  const [event] = upstash.alerts();
  assert.equal(event.payload.coalesceKey, undefined);
  assert.equal(event.storyKey, undefined);
});

test('a differently worded report of the same event still alerts', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  await cycle([{ title: NDTV_TITLE, source: 'NDTV' }]);
  // The story key is the normalized headline. A rewrite is a different key:
  // merging rewrites needs a semantic matcher, which this is not.
  assert.deepEqual(titles(upstash.alerts()), [CNN_TITLE, NDTV_TITLE], output());
});

test('two different headlines never share a story claim', async (t) => {
  // These two normalized headlines collide on the relay's 32-bit string hash.
  // Held for a day, a collision would silence the second story's alert.
  const first = 'Missile strike reported near fervdljnzkjd port overnight';
  const second = 'Missile strike reported near skdgosnlcthv port overnight';
  const { upstash, cycle, output } = await startRelay(t);
  await cycle([{ title: first, source: 'CNN World' }]);
  await cycle([{ title: second, source: 'CNN World' }]);
  assert.deepEqual(titles(upstash.alerts()), [first, second], output());
});

test('a failed queue write does not lose a copy of the story published in the same cycle', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  // Both copies are in one digest build, so their publishes run concurrently.
  // The first claims the story and its queue write fails; the second must not
  // have given up on the strength of that claim.
  upstash.state.failLpushCount = 1;
  await cycle([
    { title: CNN_TITLE, source: 'CNN World' },
    { title: EGYPT_INDEPENDENT_TITLE, source: 'Egypt Independent' },
  ]);
  assert.equal(upstash.alerts().length, 1, output());
});

test('a Redis response cut off mid-body does not stall later copies of the story', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  // The first copy's queue write fails, and the rollback's response closes
  // after its headers. The second copy waits on the first, so the rollback
  // must settle for it to run.
  upstash.state.failLpushCount = 1;
  upstash.state.truncateDel = true;
  await cycle([
    { title: CNN_TITLE, source: 'CNN World' },
    { title: EGYPT_INDEPENDENT_TITLE, source: 'Egypt Independent' },
  ]);
  assert.deepEqual(titles(upstash.alerts()), [EGYPT_INDEPENDENT_TITLE], output());
});

test('a failed queue write whose rollback also fails does not lose a copy published in the same cycle', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  // The first copy's queue write fails and so does the DEL that would release
  // its claim, so the claim stays in Redis although nothing was queued.
  upstash.state.failLpushCount = 1;
  upstash.state.failDel = true;
  await cycle([
    { title: CNN_TITLE, source: 'CNN World' },
    { title: EGYPT_INDEPENDENT_TITLE, source: 'Egypt Independent' },
  ]);
  assert.deepEqual(titles(upstash.alerts()), [EGYPT_INDEPENDENT_TITLE], output());
});

test('a failed queue write whose rollback also fails does not hold the story for the next sighting', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  upstash.state.failLpush = true;
  upstash.state.failDel = true;
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  assert.deepEqual(titles(upstash.alerts()), []);

  // Redis recovers; the stale claim is still there.
  upstash.state.failLpush = false;
  upstash.state.failDel = false;
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Reuters' }]);
  assert.deepEqual(titles(upstash.alerts()), [EGYPT_INDEPENDENT_TITLE], output());

  // Once a copy is queued, the claim holds again.
  await cycle([{ title: `${EGYPT_INDEPENDENT_TITLE} - Reuters`, source: 'Reuters' }]);
  assert.deepEqual(titles(upstash.alerts()), [EGYPT_INDEPENDENT_TITLE], output());
});

test('a failed queue write during a Redis outage does not hold the story in memory', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  // SET NX errors, so a critical alert fails open on an in-process claim.
  upstash.state.failSetNx = true;
  upstash.state.failLpush = true;
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  assert.deepEqual(titles(upstash.alerts()), []);

  upstash.state.failLpush = false;
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Reuters' }]);
  assert.deepEqual(titles(upstash.alerts()), [EGYPT_INDEPENDENT_TITLE], output());
});

test('a story whose queue write failed is not claimed, so the next sighting alerts', async (t) => {
  const { upstash, cycle, output } = await startRelay(t);
  upstash.state.failLpush = true;
  await cycle([{ title: CNN_TITLE, source: 'CNN World' }]);
  assert.deepEqual(titles(upstash.alerts()), []);

  upstash.state.failLpush = false;
  await cycle([{ title: EGYPT_INDEPENDENT_TITLE, source: 'Reuters' }]);
  assert.deepEqual(titles(upstash.alerts()), [EGYPT_INDEPENDENT_TITLE], output());
});
