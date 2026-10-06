import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';

const NOW = 1_780_000_000_000;
const DAY = 86_400_000;
async function producerHarness(context, options = {}) {
  const text = readFileSync(new URL('../scripts/seed-cyber-threats.mjs', import.meta.url), 'utf8');
  const built = await build({
    stdin: { contents: `${text}\nexport { fetchAllThreats, validate, runSeed, fetchFeodo, fetchUrlhaus, fetchC2Intel, fetchOtx, fetchAbuseIpDb };`,
      resolveDir: new URL('../scripts/', import.meta.url).pathname, loader: 'js' },
    bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent',
    define: { 'import.meta.url': JSON.stringify(new URL('../scripts/seed-cyber-threats.mjs', import.meta.url).href) },
  });
  const seed = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
  const env = { ...process.env };
  context.after(() => { process.env = env; });
  let clockTicks = 0;
  context.mock.method(Date, 'now', () => NOW + (options.advancingClock ? clockTicks++ : 0));
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'warn', () => {});
  for (const name of ['URLHAUS_AUTH_KEY', 'OTX_API_KEY', 'ABUSEIPDB_API_KEY']) {
    delete process.env[name];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.fixture';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture';
  process.env.WM_SEED_RETRY_DELAY_MS = '0';
  for (const name of options.keys ?? []) process.env[name] = 'fixture';
  const writes = [];
  const values = new Map(options.cached ?? []);
  const commands = [];
  const calls = [];
  function redis(command) {
    commands.push(command);
    const [verb, key, value] = command;
    if (verb === 'GET') return values.get(key) ?? null;
    if (verb === 'SET') {
      if (options.publishFailure && key === 'cyber:threats:v2') throw Object.assign(new Error('fixture publication failure'), { nonRetryable: true });
      values.set(key, value);
      return 'OK';
    }
    if (verb === 'EXPIRE') return values.has(key) ? 1 : 0;
    if (verb === 'DEL') return values.delete(key) ? 1 : 0;
    if (verb === 'EVAL') return 1;
    throw new Error(`Unexpected Redis command: ${verb}`);
  }
  context.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input);
    const parsedUrl = new URL(url);
    calls.push(url);
    if (parsedUrl.origin === 'https://redis.fixture') {
      if (url.includes('/get/')) return Response.json({ result: redis(['GET', decodeURIComponent(url.split('/get/')[1])]) });
      const body = JSON.parse(init.body);
      writes.push(body);
      return Array.isArray(body[0]) ? Response.json(body.map(command => ({ result: redis(command) })))
        : Response.json({ result: redis(body) });
    }
    if (url.includes('feodotracker')) {
      return options.failure ? new Response('', { status: 503 })
        : Response.json(options.bodies?.feodo ?? options.rows ?? [{ ip_address: '192.0.2.1', country: 'US', status: 'online' }]);
    }
    if (url.includes('C2IntelFeeds')) return new Response(options.failure ? '' : options.csv ?? '192.0.2.2,Possible CobaltStrike C2 IP', { status: options.failure ? 503 : 200 });
    if (url.includes('urlhaus-api')) return options.urlhausFailure ? new Response('', { status: 503 })
      : Response.json(options.bodies?.urlhaus ?? { urls: options.urls ?? [] });
    if (url.includes('otx.alienvault')) return Response.json(options.bodies?.otx ?? { results: options.otx ?? [] });
    if (url.includes('api.abuseipdb')) return Response.json(options.bodies?.abuseipdb ?? { data: options.abuse ?? [] });
    if (parsedUrl.hostname === 'ipinfo.io' || parsedUrl.hostname === 'freeipapi.com') return Response.json(options.geo ?? {});
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
  return { seed, writes, values, commands, calls };
}


test('fixture routing rejects lookalike Redis and geolocation hosts', async testContext => {
  await producerHarness(testContext);
  for (const url of [
    'https://redis.fixture.attacker.invalid',
    'https://attacker.invalid/ipinfo.io',
    'https://ipinfo.io.attacker.invalid',
    'https://freeipapi.com.attacker.invalid',
  ]) {
    await assert.rejects(fetch(url), /Unexpected fixture URL/);
  }
});


const keys = ['URLHAUS_AUTH_KEY', 'OTX_API_KEY', 'ABUSEIPDB_API_KEY'];
const foreign = { ip_address: '192.0.2.41', country: 'FR', status: 'online',
  first_seen: new Date(NOW - DAY).toISOString(), last_online: new Date(NOW - 1000).toISOString() };
const csv = '192.0.2.42,Possible CobaltStrike C2 IP';
const fetchProvider = (seed, source) => ({
  feodo: () => seed.fetchFeodo(NOW - 14 * DAY), urlhaus: () => seed.fetchUrlhaus(NOW - 14 * DAY),
  c2intel: () => seed.fetchC2Intel(), otx: () => seed.fetchOtx(14), abuseipdb: () => seed.fetchAbuseIpDb(),
})[source]();

for (const [source, malformed] of [
  ['c2intel', { csv: 'upstream maintenance: temporarily unavailable' }],
  ['feodo', { bodies: { feodo: [null] } }],
  ['urlhaus', { bodies: { urlhaus: { urls: [null] } } }],
  ['otx', { bodies: { otx: { results: [null] } } }],
  ['abuseipdb', { bodies: { abuseipdb: { data: [null] } } }],
]) {
  test(`${source} invalid body is unavailable while healthy foreign rows remain publishable`, async testContext => {
    const { seed } = await producerHarness(testContext, { keys, rows: [foreign], csv,
      geo: { country: 'FR', loc: '46.2,2.2' }, ...malformed });
    const outcome = await fetchProvider(seed, source);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, 'invalid-payload');
    assert.equal(outcome.observedAt, null);
    assert.equal(outcome.outcome, 'unavailable');
    assert.deepEqual(outcome.threats, []);
    const snapshot = await seed.fetchAllThreats();
    assert.equal(seed.validate(snapshot), true);
    assert.ok(snapshot.threats.length > 0);
    assert.ok(snapshot.threats.every(row => row.country === 'FR'));
    assert.deepEqual(Object.keys(snapshot), ['threats'], 'public metadata integration remains a separate parent dependency');
  });
}

for (const header of ['#ip,ioc', 'ip,ioc', 'IP,Description', '# IP,Description']) {
  test(`C2Intel validates the supported empty header ${header}`, async testContext => {
    const { seed } = await producerHarness(testContext, { csv: `${header}\r\n` });
    const outcome = await seed.fetchC2Intel();
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.threats, []);
    assert.equal(outcome.observedAt, NOW);
  });
}

test('CSV rejects maintenance, mixed bad rows, repeated headers and decoded bounds', async testContext => {
  for (const body of ['# maintenance only', '<html>maintenance</html>', '{"error":"maintenance"}',
    'IP,UnexpectedHeader', `#ip,ioc\n#ip,ioc`, `${csv}\nmaintenance`, `${csv}\n192.0.2.1,`,
    `192.0.2.1,${'x'.repeat(4097)}`, '\n'.repeat(10000)]) {
    await testContext.test(body.slice(0, 100), async child => {
      const { seed } = await producerHarness(child, { csv: body });
      const out = await seed.fetchC2Intel();
      assert.equal(out.ok, false);
      assert.equal(out.observedAt, null);
    });
  }
});

test('valid empty JSON arrays are distinct from invalid provider rows', async testContext => {
  const { seed } = await producerHarness(testContext, { keys, rows: [], csv: '' });
  for (const source of ['feodo', 'urlhaus', 'otx', 'abuseipdb']) {
    const out = await fetchProvider(seed, source);
    assert.equal(out.ok, true, source);
    assert.deepEqual(out.threats, []);
    assert.equal(out.observedAt, NOW);
  }
});

test('OTX empty pages with other advertised observations stay unavailable', async testContext => {
  for (const body of [
    { results: [], count: 1, next: null, previous: null },
    { results: [], count: 0, next: 'https://otx.fixture/page2' },
    { results: [], previous: 'https://otx.fixture/page1' },
  ]) {
    await testContext.test(JSON.stringify(body), async child => {
      const { seed } = await producerHarness(child, { keys, bodies: { otx: body } });
      const out = await seed.fetchOtx(14);
      assert.equal(out.ok, false);
      assert.equal(out.observedAt, null);
      assert.equal(out.reason, 'incomplete-page');
    });
  }
});

test('read public provider profiles pass the same producer boundary', async testContext => {
  const feodo = [{ ip_address: '162.243.103.246', port: 8080, status: 'offline', hostname: null,
    as_number: 14061, as_name: 'DIGITALOCEAN-ASN', country: 'US',
    first_seen: '2022-06-04 21:24:53', last_online: '2026-03-07', malware: 'Emotet' }];
  const c2 = '#ip,ioc\n1.15.76.39,Possible Cobaltstrike C2 IP';
  const { seed } = await producerHarness(testContext, { rows: feodo, csv: c2 });
  assert.equal((await seed.fetchFeodo(0)).threats.length, feodo.length);
  const c2out = await seed.fetchC2Intel();
  assert.equal(c2out.ok, true);
  assert.ok(c2out.threats.length > 0);
});

test('validation examines rows after the selected cap and preserves healthy evidence', async testContext => {
  const validRows = Array.from({ length: 1000 }, (unusedRow, rowIndex) => ({ ...foreign,
    ip_address: `198.18.${Math.floor(rowIndex / 250)}.${rowIndex % 250 + 1}` }));
  const { seed } = await producerHarness(testContext, { keys, rows: [...validRows, null], csv,
    geo: { country: 'FR', loc: '46.2,2.2' } });
  assert.equal((await seed.fetchFeodo(NOW - 14 * DAY)).ok, false);
  const snapshot = await seed.fetchAllThreats();
  assert.equal(snapshot.threats.length, 1);
  assert.equal(snapshot.threats[0].source, 'CYBER_THREAT_SOURCE_C2INTEL');
});

test('native date windows and the paid rate-cache gate remain unchanged', async testContext => {
  const { seed, calls } = await producerHarness(testContext, { keys,
    rows: [{ ...foreign, first_seen: new Date(NOW - 90 * DAY).toISOString(), last_online: '' }],
    urls: [{ url: 'https://192.0.2.44/payload', country: 'FR', date_added: new Date(NOW - 90 * DAY).toISOString() }],
    otx: [{ indicator: '192.0.2.45', created: new Date(NOW - 90 * DAY).toISOString() }],
    cached: [['rate:abuseipdb:last-call', JSON.stringify({ calledAt: NOW - 60000 })]],
  });
  assert.deepEqual((await seed.fetchFeodo(NOW - 14 * DAY)).threats, []);
  assert.deepEqual((await seed.fetchUrlhaus(NOW - 14 * DAY)).threats, []);
  const otx = await seed.fetchOtx(14);
  assert.equal(otx.threats[0].firstSeen, NOW - 90 * DAY);
  const abuse = await seed.fetchAbuseIpDb();
  assert.equal(abuse.ok, false);
  assert.equal(calls.some(url => url.includes('api.abuseipdb')), false);
  assert.ok(calls.some(url => url.endsWith(`modified_since=${new Date(NOW - 14 * DAY).toISOString().slice(0, 10)}`)));
});

test('missing keys are unconfigured and retained cache cannot invent an observation clock', async testContext => {
  const { seed, calls } = await producerHarness(testContext);
  for (const source of ['urlhaus', 'otx', 'abuseipdb']) {
    const out = await fetchProvider(seed, source);
    assert.equal(out.outcome, 'unconfigured');
    assert.equal(out.reason, 'missing-key');
    assert.equal(out.observedAt, null);
  }
  assert.equal(calls.length, 0);
  await testContext.test('legacy retained rate-cache has no observedAt proof', async child => {
    const cached = { id: 'abuseipdb:192.0.2.51', indicator: '192.0.2.51', indicatorType: 'ip',
      source: 'abuseipdb', type: 'malware_host', tags: [], firstSeen: 0, lastSeen: NOW - DAY,
      lat: 46.2, lon: 2.2, country: 'FR', severity: 'high', malwareFamily: '' };
    const { seed: retainedSeed, calls: retainedCalls } = await producerHarness(child, { keys,
      cached: [['rate:abuseipdb:last-call', JSON.stringify({ calledAt: NOW - 60000 })],
        ['cache:abuseipdb:threats', JSON.stringify([cached])]],
    });
    const out = await retainedSeed.fetchAbuseIpDb();
    assert.equal(out.outcome, 'retained');
    assert.equal(out.observedAt, null);
    assert.deepEqual(out.threats, [cached]);
    assert.equal(retainedCalls.some(url => url.includes('api.abuseipdb')), false);
  });
});

test('invalid envelopes, native dates and decoded bounds cannot count as observations', async testContext => {
  for (const [source, body] of [
    ['feodo', { data: [], error: 'maintenance' }],
    ['feodo', [{ ...foreign, last_online: 'invalid date' }]],
    ['feodo', [{ ...foreign, as_name: '界'.repeat(5500) }]],
    ['feodo', Array(10001).fill(foreign)],
    ['urlhaus', { query_status: 'no_results', urls: [{ url: 'https://example.test' }] }],
    ['urlhaus', { urls: [], data: [] }],
    ['otx', { results: [{ indicator: '192.0.2.1', tags: [null] }] }],
    ['abuseipdb', { data: [{ ipAddress: '192.0.2.1', abuseConfidenceScore: 101 }] }],
  ]) {
    await testContext.test(source, async child => {
      const { seed } = await producerHarness(child, { keys, bodies: { [source]: body } });
      const out = await fetchProvider(seed, source);
      assert.equal(out.ok, false);
      assert.equal(out.observedAt, null);
      assert.equal(out.reason, 'invalid-payload');
    });
  }
});

test('all invalid source bodies reject before a new snapshot can be published', async testContext => {
  const { seed, writes } = await producerHarness(testContext, { keys, csv: 'maintenance', bodies: {
    feodo: [null], urlhaus: { urls: [null] }, otx: { results: [null] }, abuseipdb: { data: [null] },
  } });
  await assert.rejects(seed.fetchAllThreats(), /All 5 IOC sources failed/);
  assert.deepEqual(writes, []);
});

test('incomplete OTX pages reject the aggregate instead of publishing unqualified rows', async testContext => {
  const row = { indicator: '192.0.2.61', created: new Date(NOW - DAY).toISOString() };
  const many = Array.from({ length: 1001 }, (unusedRow, rowIndex) => ({ indicator: `198.18.${Math.floor(rowIndex / 250)}.${rowIndex % 250 + 1}` }));
  for (const body of [
    { results: [], count: 100, next: 'https://otx.fixture/page2', previous: null },
    { results: [row], count: 100, next: 'https://otx.fixture/page2', previous: null },
    { results: [row], count: 100, next: null },
    { results: [row], count: 1, next: 'https://otx.fixture/page2' },
    { results: [row], previous: 'https://otx.fixture/page1' },
    { results: many, count: 1001, next: null },
  ]) {
    await testContext.test(`returned ${body.results.length}, count ${body.count ?? 'absent'}, next ${body.next ?? 'absent'}`, async child => {
      const { seed, calls, writes } = await producerHarness(child, { keys: ['OTX_API_KEY'],
        rows: [foreign], csv: '', bodies: { otx: body } });
      const out = await seed.fetchOtx(14);
      child.diagnostic(JSON.stringify({ outcome: out.outcome, rows: out.threats.length, observedAt: out.observedAt }));
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'incomplete-page');
      assert.equal(out.observedAt, null);
      calls.length = 0;
      await assert.rejects(seed.fetchAllThreats(), error => error.code === 'OTX_INCOMPLETE_PAGE' && error.nonRetryable === true);
      assert.equal(calls.filter(url => url.includes('otx.alienvault')).length, 1);
      assert.equal(calls.some(url => url.includes('otx.fixture')), false);
      assert.deepEqual(writes, []);
    });
  }
});

test('actual runSeed retains canonical and bootstrap bytes and clocks on an incomplete OTX first page', async testContext => {
  const oldClock = NOW - DAY;
  const prior = JSON.stringify({ _seed: { fetchedAt: oldClock, recordCount: 1 }, data: { threats: [{
    id: 'old', firstSeenAt: oldClock, lastSeenAt: oldClock, country: 'FR',
  }] } });
  const priorMeta = JSON.stringify({ fetchedAt: oldClock, recordCount: 1, sourceVersion: 'multi-ioc-v2' });
  const { seed, values, commands, calls } = await producerHarness(testContext, { keys: ['OTX_API_KEY'],
    rows: [foreign], csv: '', cached: [['cyber:threats:v2', prior], ['cyber:threats-bootstrap:v2', prior],
      ['seed-meta:cyber:threats', priorMeta], ['seed-meta:cyber:threats-bootstrap', priorMeta]],
    bodies: { otx: { results: [{ indicator: '192.0.2.61', created: new Date(oldClock).toISOString() }],
      count: 100, next: 'https://otx.fixture/page2', previous: null } },
  });
  testContext.mock.method(process, 'exit', code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); });
  testContext.mock.method(console, 'error', () => {});
  await assert.rejects(seed.runSeed('cyber', 'threats', 'cyber:threats:v2', seed.fetchAllThreats, {
    validateFn: seed.validate, ttlSeconds: 10800, sourceVersion: 'multi-ioc-v2',
    extraKeys: [{ key: 'cyber:threats-bootstrap:v2', declareRecords: seed.declareRecords }],
    declareRecords: seed.declareRecords, schemaVersion: 1, maxStaleMin: 240,
  }), error => error.exitCode === 75);
  for (const key of ['cyber:threats:v2', 'cyber:threats-bootstrap:v2']) {
    assert.equal(values.get(key), prior);
    assert.ok(commands.some(command => command[0] === 'EXPIRE' && command[1] === key));
    assert.equal(commands.some(command => command[0] === 'SET' && command[1] === key), false);
  }
  assert.equal(values.get('seed-meta:cyber:threats'), priorMeta);
  assert.equal(values.get('seed-meta:cyber:threats-bootstrap'), priorMeta);
  assert.equal(commands.some(command => command[0] === 'SET' && command[1] === 'cache:cyber:first-seen:v1'), false);
  assert.equal(calls.filter(url => url.includes('otx.alienvault')).length, 1);
  assert.equal(calls.some(url => url.includes('otx.fixture')), false);
});

test('known OTX incompleteness survives invalid rows, wrappers and decoded bounds before publication', async testContext => {
  const row = { indicator: '192.0.2.61' };
  for (const [name, body] of [
    ['malformed row with next', { results: [null], count: 100, next: 'https://otx.fixture/page2' }],
    ['invalid count with next', { results: [row], count: '100', next: 'https://otx.fixture/page2' }],
    ['oversized next with count mismatch', { results: [row], count: 100, next: 'x'.repeat(4097) }],
    ['10001 rows', { results: Array(10001).fill(row), count: 10001, next: null }],
    ['10001 bare rows', Array(10001).fill(row)],
    ['invalid wrapper with next', { results: 'malformed', next: 'https://otx.fixture/page2' }],
    ['error wrapper with previous', { results: [row], error: 'malformed', previous: 'https://otx.fixture/page1' }],
    ['decoded byte limit with next', { results: [row], padding: 'x'.repeat(4 * 1024 * 1024), next: 'https://otx.fixture/page2' }],
  ]) {
    await testContext.test(name, async child => {
      const oldClock = NOW - DAY;
      const prior = JSON.stringify({ _seed: { fetchedAt: oldClock, recordCount: 1 }, data: { threats: [{
        id: 'old', country: 'FR', firstSeenAt: oldClock, lastSeenAt: oldClock,
      }] } });
      const meta = JSON.stringify({ fetchedAt: oldClock, recordCount: 1, sourceVersion: 'multi-ioc-v2' });
      const { seed, values, commands, calls } = await producerHarness(child, { keys: ['OTX_API_KEY'],
        rows: [foreign], csv: '', bodies: { otx: body }, cached: [
          ['cyber:threats:v2', prior], ['cyber:threats-bootstrap:v2', prior],
          ['seed-meta:cyber:threats', meta], ['seed-meta:cyber:threats-bootstrap', meta],
        ] });
      const outcome = await seed.fetchOtx(14);
      child.diagnostic(JSON.stringify({ reason: outcome.reason, observedAt: outcome.observedAt }));
      calls.length = 0;
      child.mock.method(process, 'exit', code => { throw Object.assign(new Error('fixture exit'), { exitCode: code }); });
      child.mock.method(console, 'error', () => {});
      let exit;
      try {
        await seed.runSeed('cyber', 'threats', 'cyber:threats:v2', seed.fetchAllThreats, {
          validateFn: seed.validate, ttlSeconds: 10800, sourceVersion: 'multi-ioc-v2',
          extraKeys: [{ key: 'cyber:threats-bootstrap:v2', declareRecords: seed.declareRecords }],
          declareRecords: seed.declareRecords, schemaVersion: 1, maxStaleMin: 240,
        });
      } catch (error) {
        assert.equal(error.message, 'fixture exit');
        exit = error.exitCode;
      }
      child.diagnostic(JSON.stringify({ exit, canonicalRetained: values.get('cyber:threats:v2') === prior,
        bootstrapRetained: values.get('cyber:threats-bootstrap:v2') === prior,
        firstSeenSets: commands.filter(command => command[0] === 'SET' && command[1] === 'cache:cyber:first-seen:v1').length }));
      assert.equal(exit, 75);
      assert.equal(outcome.reason, 'incomplete-page');
      assert.equal(outcome.observedAt, null);
      for (const [key, expected] of [['cyber:threats:v2', prior], ['cyber:threats-bootstrap:v2', prior],
        ['seed-meta:cyber:threats', meta], ['seed-meta:cyber:threats-bootstrap', meta]]) {
        assert.equal(values.get(key), expected);
        assert.equal(commands.some(command => command[0] === 'SET' && command[1] === key), false);
      }
      assert.equal(commands.some(command => command[0] === 'SET' && command[1] === 'cache:cyber:first-seen:v1'), false);
      assert.equal(calls.filter(url => url.includes('otx.alienvault')).length, 1);
      assert.equal(calls.some(url => url.includes('otx.fixture')), false);
    });
  }
});

test('complete bounded OTX pages and generic invalid payload policy remain unchanged', async testContext => {
  const row = { indicator: '192.0.2.61' };
  const full = Array.from({ length: 1000 }, (unusedRow, rowIndex) => ({ indicator: `198.18.${Math.floor(rowIndex / 250)}.${rowIndex % 250 + 1}` }));
  for (const body of [{ results: [row], count: 1, next: null, previous: null },
    { results: full, count: 1000, next: null, previous: null }, full,
    { results: [], count: 0, next: null, previous: null }]) {
    await testContext.test(`complete ${Array.isArray(body) ? body.length : body.results.length}`, async child => {
      const { seed, calls } = await producerHarness(child, { keys: ['OTX_API_KEY'], bodies: { otx: body } });
      const out = await seed.fetchOtx(14);
      assert.equal(out.ok, true);
      assert.equal(out.threats.length, Array.isArray(body) ? body.length : body.results.length);
      assert.equal(out.observedAt, NOW);
      assert.equal(calls.filter(url => url.includes('otx.alienvault')).length, 1);
    });
  }
  for (const body of [{ results: [null] }, { results: [row], count: '100' },
    { results: [row], count: 1, next: 'x'.repeat(4097) }]) {
    await testContext.test('invalid without known incompleteness', async child => {
      const { seed } = await producerHarness(child, { keys: ['OTX_API_KEY'], rows: [foreign], csv: '', bodies: { otx: body } });
      assert.equal((await seed.fetchOtx(14)).reason, 'invalid-payload');
      assert.equal(seed.validate(await seed.fetchAllThreats()), true);
    });
  }
});
