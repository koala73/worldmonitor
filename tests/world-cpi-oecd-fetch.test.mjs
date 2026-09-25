import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const worker = fileURLToPath(new URL('../scripts/seed-world-cpi-oecd.mjs', import.meta.url));
const canonicalKey = 'economic:world-cpi:oecd:v1';
const latestKey = 'economic:world-cpi:oecd:latest:v1';
const metaKey = 'seed-meta:economic:world-cpi-oecd';
const completionKey = 'seed-completion:economic:world-cpi-oecd';

function runWorker(scenario) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const scenario = ${JSON.stringify(scenario)};
    const keys = ${JSON.stringify([canonicalKey, latestKey, metaKey])};
    const retained = JSON.stringify({ fetchedAt: 1790141667926, newestItemAt: 1775001600000, lastGood: true });
    const store = new Map(keys.map(key => [key, retained]));
    const requests = [];
    const commands = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms <= 40000 ? 0 : ms, ...args);
    process.on('exit', () => console.log('RESULT ' + JSON.stringify({ requests, commands, store: Object.fromEntries(store), retained })));
    const respond = result => new Response(JSON.stringify({ result }));
    function redis(command) {
      commands.push(command);
      const [verb, key, value] = command;
      if (verb === 'SET') { store.set(key, value); return 'OK'; }
      if (verb === 'GET') return store.get(key) ?? null;
      if (verb === 'EXPIRE') return store.has(key) ? 1 : 0;
      if (verb === 'DEL') { store.delete(key); return 1; }
      if (verb === 'EVAL') return 1;
      throw new Error('Unexpected Redis command ' + verb);
    }
    globalThis.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'sdmx.oecd.org') {
        const frequency = parsed.pathname.includes('.M.') ? 'M' : 'Q';
        const attempt = requests.filter(request => request.frequency === frequency).length;
        const sequence = scenario[frequency] ?? [200];
        const status = sequence[Math.min(attempt, sequence.length - 1)];
        requests.push({ frequency, status, accept: options.headers.Accept });
        if (status === 'network') throw new Error('sensitive upstream network detail');
        if (status === 'body') return { ok: true, status: 200, headers: new Headers(), text: async () => { throw new Error('sensitive body failure'); } };
        if (status !== 200) return new Response('sensitive upstream response body', { status, headers: {
          'content-type': scenario.unsafeHeaders ? 'secret/header-token' : 'text/plain; charset=utf-8',
          'cf-ray': scenario.unsafeHeaders ? 'secret-ray-token' : 'a4084cf5be192115-MRS',
          'set-cookie': 'secret-cookie-token',
          'retry-after': scenario.retryAfter ?? '',
        } });
        const countries = parsed.pathname.split('/').at(-1).split('.')[0].split('+');
        const selected = frequency === 'Q' ? ['AUS'] : countries.filter(country => country !== 'AUS');
        const periods = frequency === 'Q' ? ['2026-Q1', '2026-Q2'] : ['2026-07', '2026-08'];
        return new Response('REF_AREA,FREQ,METHODOLOGY,MEASURE,UNIT_MEASURE,EXPENDITURE,ADJUSTMENT,TRANSFORMATION,TIME_PERIOD,OBS_VALUE,BASE_PER\\n'
          + selected.flatMap(country => periods.map(period => [country,frequency,'N','CPI','IX','_T','N','_Z',period,120,2015].join(','))).join('\\n'));
      }
      if (parsed.hostname !== 'redis.test') throw new Error('Unexpected network host');
      if (options.body) {
        const command = JSON.parse(options.body);
        if (Array.isArray(command[0])) return new Response(JSON.stringify(command.map(item => ({ result: redis(item) }))));
        return respond(redis(command));
      }
      const parts = parsed.pathname.slice(1).split('/').map(decodeURIComponent);
      return respond(redis([parts[0].toUpperCase(), ...parts.slice(1)]));
    };
    process.argv[1] = ${JSON.stringify(worker)};
    await import(${JSON.stringify(new URL('../scripts/seed-world-cpi-oecd.mjs', import.meta.url).href)});
  `], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      NODE_TEST_CONTEXT: 'child-v8',
      WM_SEED_RETRY_DELAY_MS: '0',
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'fake-token',
      WM_BUNDLE_COMPLETION_META_KEY: completionKey,
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.ifError(child.error);
  const logs = child.stdout + child.stderr;
  const result = child.stdout.split('\n').find(line => line.startsWith('RESULT '));
  assert.ok(result, logs);
  return { ...JSON.parse(result.slice(7)), status: child.status, logs };
}

function assertRetained(run) {
  assert.equal(run.status, 75, run.logs);
  for (const key of [canonicalKey, latestKey, metaKey]) {
    assert.equal(run.store[key], run.retained);
    assert.ok(run.commands.some(command => command[0] === 'EXPIRE' && command[1] === key));
    assert.ok(!run.commands.some(command => command[0] === 'SET' && command[1] === key));
  }
  assert.equal(run.store[completionKey], undefined);
}

test('monthly exhaustion stops after three requests and retains last-good data and clocks', () => {
  const run = runWorker({ M: [500] });
  assertRetained(run);
  assert.equal(run.requests.length, 3, 'the outer retry must not restart an exhausted OECD request');
});

test('quarterly exhaustion does not download the successful monthly batch again', () => {
  const run = runWorker({ Q: [500] });
  assertRetained(run);
  assert.deepEqual(run.requests.map(request => request.frequency), ['M', 'Q', 'Q', 'Q']);
});

for (const status of [400, 404, 406]) {
  test(`HTTP ${status} remains a single-attempt failure`, () => {
    const run = runWorker({ M: [status] });
    assertRetained(run);
    assert.equal(run.requests.length, 1);
  });
}

test('transient throttling recovers with the existing Retry-After backoff and source clock', () => {
  const run = runWorker({ M: [429, 200], Q: [503, 200], retryAfter: '45' });
  assert.equal(run.status, 0, run.logs);
  assert.deepEqual(run.requests.map(request => request.frequency), ['M', 'M', 'Q', 'Q']);
  assert.equal((run.logs.match(/Retry 1\/2 in 45000ms/g) ?? []).length, 2);
  const canonical = JSON.parse(run.store[canonicalKey]);
  const latest = JSON.parse(run.store[latestKey]);
  const meta = JSON.parse(run.store[metaKey]);
  assert.equal(canonical._seed.newestItemAt, Date.UTC(2026, 7, 1));
  assert.equal(meta.newestItemAt, canonical._seed.newestItemAt);
  assert.equal(latest._seed.fetchedAt, canonical._seed.fetchedAt);
  assert.deepEqual(latest.data, canonical.data);
  assert.equal(Object.keys(canonical.data.countries).length, 49);
  assert.equal(JSON.parse(run.store[completionKey]).fetchedAt, canonical._seed.fetchedAt);
});

function diagnostics(run) {
  return run.logs.split('\n').filter(line => line.includes('OECD CPI request: '))
    .map(line => JSON.parse(line.split('OECD CPI request: ')[1]));
}

test('HTTP diagnostics retain safe response identifiers without logging response bodies or arbitrary headers', () => {
  const run = runWorker({ M: [500] });
  const events = diagnostics(run);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(event => event.attempt), [1, 2, 3]);
  for (const event of events) {
    assert.equal(event.frequency, 'M');
    assert.equal(event.countryCount, 49);
    assert.equal(event.observations, 120);
    assert.equal(event.stage, 'http');
    assert.equal(event.status, 500);
    assert.equal(event.contentType, 'text/plain');
    assert.equal(event.cfRay, 'a4084cf5be192115-MRS');
    assert.ok(event.elapsedMs >= 0);
  }
  assert.doesNotMatch(run.logs, /sensitive|secret-cookie-token/);
  const unsafe = runWorker({ M: [500], unsafeHeaders: true });
  assert.doesNotMatch(unsafe.logs, /secret/);
  assert.ok(diagnostics(unsafe).every(event => event.cfRay === null && event.contentType === null));
});

for (const [failure, stage] of [['network', 'headers'], ['body', 'body']]) {
  test(`${failure} failures keep the three-attempt limit and log their stage without exception text`, () => {
    const run = runWorker({ M: [failure] });
    assertRetained(run);
    assert.equal(run.requests.length, 3);
    assert.equal(diagnostics(run).length, 3);
    assert.ok(diagnostics(run).every(event => event.stage === stage));
    assert.doesNotMatch(run.logs, /sensitive/);
  });
}
