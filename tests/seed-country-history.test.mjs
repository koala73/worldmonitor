import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCountrySnapshots, publishCountrySnapshots } from '../scripts/seed-country-history.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from '../api/_cii-risk-cache-keys.js';

test('daily source namespaces match the current CII, resilience and news publishers', () => {
  const source = readFileSync(new URL('../scripts/seed-country-history.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes(`const RISK_KEY = '${CII_RISK_SCORE_CACHE_KEYS.stale}'`));
  const resilience = readFileSync(new URL('../scripts/seed-resilience-scores.mjs', import.meta.url), 'utf8');
  const rankingKey = resilience.match(/RESILIENCE_RANKING_CACHE_KEY = '([^']+)'/)[1];
  assert.ok(source.includes(`const RANKING_KEY = '${rankingKey}'`));
  const news = readFileSync(new URL('../server/worldmonitor/news/v1/list-feed-digest.ts', import.meta.url), 'utf8');
  assert.ok(news.includes('news:digest:v1:'));
  assert.ok(source.includes("const DIGEST_KEY = 'news:digest:v1:full:en'"));
});

const now = Date.UTC(2026, 9, 19, 0, 30);
const inputs = () => ({
  now, countries: ['US', 'FR'],
  risk: { ciiScores: [{ region: 'US', combinedScore: 0, computedAt: now - 1000, methodologyVersion: 'v11' }] },
  ranking: { items: [{ countryCode: 'US', overallScore: 65 }], greyedOut: [], fetchedAt: new Date(now - 3600000).toISOString(), _scoreCacheIdentity: 'v29:pc:active' },
  digest: { generatedAt: new Date(now - 1000).toISOString(), coverage: { state: 'complete' }, categories: { politics: { items: [
    { title: 'United States talks begin', link: 'https://example.com/1', source: 'Example', publishedAt: now - 1000 },
    { title: 'United States talks begin', link: 'https://example.com/1', source: 'Example', publishedAt: now - 1000 },
    { title: 'France alert', link: 'javascript:alert(1)', source: 'Example', publishedAt: now - 1000 },
  ] } } },
});

test('daily composition preserves observed zero, absence, source clocks, formula tags and safe deduplicated events', () => {
  const [us, fr] = composeCountrySnapshots(inputs());
  assert.equal(us.date, '2026-10-19');
  assert.deepEqual(us.cii, { score: 0, version: 'v11', observedAt: now - 1000 });
  assert.equal(us.resilience.version, 'v29:pc:active');
  assert.equal(us.topEvents.length, 1);
  assert.equal(us.topEvents[0].category, 'politics');
  assert.equal(fr.cii, undefined);
  assert.equal(fr.resilience, undefined);
  assert.equal(fr.topEvents.length, 0);
});

test('unavailable, malformed and stale source snapshots cannot become daily history', () => {
  for (const change of [
    { risk: null }, { risk: { ciiScores: [], stale: true } },
    { ranking: { ...inputs().ranking, fetchedAt: new Date(now - 13 * 3600000).toISOString() } },
    { digest: { ...inputs().digest, coverage: { state: 'unavailable' } } },
    { risk: { ciiScores: [{ ...inputs().risk.ciiScores[0], combinedScore: null }] } },
  ]) assert.throws(() => composeCountrySnapshots({ ...inputs(), ...change }));
});

test('headline selection requires qualified names for ambiguous countries', () => {
  const data = inputs();
  data.countries = ['GE', 'JO', 'TR', 'GN', 'CG'];
  data.digest.categories.politics.items = [
    'Georgia (U.S. state) election', 'Michael Jordan speaks', 'Turkey recipes', 'Papua New Guinea alert', 'Democratic Republic of the Congo talks',
    'Republic of Georgia talks', 'Kingdom of Jordan talks', 'Turkiye talks', 'Guinea Conakry talks', 'Congo Brazzaville talks',
  ].map((title, index) => ({ title, link: `https://example.com/${index}`, source: 'Example', publishedAt: now - 1000 }));
  const rows = composeCountrySnapshots(data);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.topEvents.length, 1, row.countryCode);
    assert.equal(row.topEvents[0].link, `https://example.com/${index + 5}`);
  }
});

test('headlines match complete country names without assigning nested names to another country', () => {
  const data = inputs();
  data.countries = ['SD', 'SS', 'KR', 'KP', 'WS', 'AS'];
  data.digest.categories.politics.items = [
    'South Sudan signs peace agreement', 'Democratic Republic of Korea announces talks',
    'American Samoa reports flooding', 'South Sudan and Sudan resume talks', 'Samoa reports flooding',
  ].map((title, index) => ({ title, link: `https://example.com/${index}`, source: 'Example', publishedAt: now - 1000 }));
  const rows = new Map(composeCountrySnapshots(data).map(row => [row.countryCode, row]));
  for (const [code, titles] of [
    ['SD', ['South Sudan and Sudan resume talks']],
    ['SS', ['South Sudan signs peace agreement', 'South Sudan and Sudan resume talks']],
    ['KR', []], ['KP', ['Democratic Republic of Korea announces talks']],
    ['WS', ['Samoa reports flooding']], ['AS', ['American Samoa reports flooding']],
  ]) assert.deepEqual(rows.get(code).topEvents.map(event => event.title), titles, code);
});

const poolRow = (title, link, extra = {}) => ({ title, link, source: 'Feed', category: 'middleeast', publishedAt: now - 2000, ...extra });

test('headlines come from the whole feed pool, not only the front-page digest', () => {
  const data = inputs();
  data.countries = ['AE', 'IE', 'MX', 'RU'];
  data.digest.categories.politics.items = [];
  data.pool = { feedsTotal: 2, feedsCached: 2, items: [
    poolRow('Somalia-UAE rupture deepens over port deal', 'https://example.org/ae'),
    poolRow('Northern Ireland doctors strike over pay', 'https://example.org/ni'),
    poolRow('New Mexico approves uranium mine petition', 'https://example.org/nm'),
    poolRow('Russian strike kills 11 in residential block', 'https://example.org/ru'),
    poolRow('Emirati envoy meets Somali president', 'https://example.org/ae2'),
  ] };
  const rows = new Map(composeCountrySnapshots(data).map(row => [row.countryCode, row]));
  assert.deepEqual(rows.get('AE').topEvents.map(event => event.link), ['https://example.org/ae', 'https://example.org/ae2']);
  assert.deepEqual(rows.get('AE').topEvents[0], { title: 'Somalia-UAE rupture deepens over port deal', link: 'https://example.org/ae', source: 'Feed', category: 'middleeast' });
  assert.deepEqual(rows.get('IE').topEvents, []);
  assert.deepEqual(rows.get('MX').topEvents, []);
  assert.deepEqual(rows.get('RU').topEvents.map(event => event.link), ['https://example.org/ru']);
});

test('digest headlines rank first, then pool headlines from distinct publishers before repeats', () => {
  const data = inputs();
  data.countries = ['US'];
  data.pool = { feedsTotal: 1, feedsCached: 1, items: [
    poolRow('United States budget vote', 'https://a.example/1', { source: 'Gulf Daily News', publishedAt: now - 100 }),
    poolRow('United States tariff ruling', 'https://a.example/2', { source: 'Gulf Daily News', publishedAt: now - 200 }),
    poolRow('United States storm warning', 'https://b.example/3', { source: 'Khaleej Times', publishedAt: now - 300 }),
    poolRow('United States talks begin', 'https://example.com/1', { source: 'Repeat', publishedAt: now - 50 }),
  ] };
  const [us] = composeCountrySnapshots(data);
  assert.deepEqual(us.topEvents.map(event => event.link), ['https://example.com/1', 'https://a.example/1', 'https://b.example/3', 'https://a.example/2']);
  assert.equal(us.topEvents[0].category, 'politics');
});

test('revoked, aggregator, stale and future pool rows never enter the archive', () => {
  const data = inputs();
  data.countries = ['US'];
  data.digest.categories.politics.items = [];
  data.revoked = new Set(['https://example.org/revoked']);
  data.pool = { feedsTotal: 1, feedsCached: 1, items: [
    poolRow('United States revoked story', 'https://example.org/revoked'),
    poolRow('United States redirect story', 'https://news.google.com/rss/articles/abc'),
    poolRow('United States plain http story', 'http://example.org/http'),
    poolRow('United States old story', 'https://example.org/old', { publishedAt: now - 25 * 3600000 }),
    poolRow('United States future story', 'https://example.org/future', { publishedAt: now + 2 * 3600000 }),
    poolRow('United States kept story', 'https://example.org/kept'),
  ] };
  const [us] = composeCountrySnapshots(data);
  assert.deepEqual(us.topEvents.map(event => event.link), ['https://example.org/kept']);
});

test('revoked digest links are dropped and an empty feed pool marks news partial', () => {
  const data = inputs();
  data.revoked = new Set(['https://example.com/1']);
  data.pool = { feedsTotal: 3, feedsCached: 0, items: [] };
  const [us] = composeCountrySnapshots(data);
  assert.deepEqual(us.topEvents, []);
  assert.ok(us.keySignals.includes('news_partial'));
});

test('the pool reader keeps country rows only from the same parse and credits trusted origin publishers', async () => {
  const { readFeedPool } = await import('../scripts/seed-country-history.mjs');
  const feeds = [{ name: 'Wire', url: 'https://wire.example/rss', category: 'politics' }, { name: 'Other', url: 'https://other.example/rss', category: 'asia' }];
  const row = (title, extra = {}) => ({ source: 'Wire', title, link: `https://wire.example/${title.length}`, publishedAt: now, ...extra });
  const values = {
    'rss:feed:v11:full:https://wire.example/rss': { parsedAt: 1, items: [row('Digest row'), row('Foreign row', { source: 'Elsewhere' })] },
    'rss:feed-country:v1:full:https://wire.example/rss': { parsedAt: 1, items: [row('Country row longer', { originPublisher: 'Origin Daily', originPublisherTrusted: true })] },
    'rss:feed:v11:full:https://other.example/rss': { parsedAt: 2, items: [] },
    'rss:feed-country:v1:full:https://other.example/rss': { parsedAt: 1, items: [{ source: 'Other', title: 'Old parse', link: 'https://other.example/1', publishedAt: now }] },
  };
  const pool = await readFeedPool('', '', async (_url, _token, args) => ({ result: args.slice(1).map(key => values[key] ? JSON.stringify(values[key]) : null) }), feeds);
  assert.equal(pool.feedsCached, 2);
  assert.deepEqual(pool.items.map(item => [item.title, item.source, item.category]), [['Digest row', 'Wire', 'politics'], ['Country row longer', 'Origin Daily', 'politics']]);
});

test('the pool reader lists the same feeds the country headline RPC reads', async () => {
  const { countryHistoryFeeds } = await import('../scripts/seed-country-history.mjs');
  const { SERVER_NEWS_CATALOG } = await import('../shared/news-catalog.server.generated.ts');
  const reachable = feed => !feed.lang || feed.lang === 'en' || !!feed.strategicDefault || !!feed.fetchInAllLanguages;
  const expected = [...new Set([...Object.values(SERVER_NEWS_CATALOG.variantFeeds.full).flat(), ...SERVER_NEWS_CATALOG.intelSources]
    .filter(reachable).map(feed => feed.url))].sort();
  assert.deepEqual([...new Set(countryHistoryFeeds().map(feed => feed.url))].sort(), expected);
  const rpc = readFileSync(new URL('../server/worldmonitor/news/v1/list-country-headlines.ts', import.meta.url), 'utf8');
  assert.match(rpc, /VARIANT_FEEDS\.full \?\? \{\}\)\.flat\(\), \.\.\.INTEL_SOURCES\]/);
  assert.match(rpc, /isServerFeedReachableForLanguage\(feed, 'en'\)/);
});

test('the daily executable recovers transient source reads and bounds permanent failures', () => {
  const entry = new URL('../scripts/seed-country-history.mjs', import.meta.url);
  for (const [status, recover, expectedReads, expectedExit] of [[503, true, 2, 0], [503, false, 3, 1], [401, false, 1, 1]]) {
    const script = `
      let reads = 0, writes = 0;
      const data = ${JSON.stringify(inputs())};
      const shift = Date.now() - data.now;
      data.risk.ciiScores[0].computedAt += shift;
      data.ranking.fetchedAt = new Date(Date.now()).toISOString();
      data.digest.generatedAt = new Date(Date.now()).toISOString();
      globalThis.fetch = async (_url, init) => {
        const args = JSON.parse(init.body);
        if (args[0] === 'SMEMBERS') return Response.json({ result: [] });
        if (args[0] === 'MGET' && args[1].startsWith('rss:')) return Response.json({ result: args.slice(1).map(() => null) });
        if (args[0] === 'MGET') {
          reads++;
          if (!${recover} || reads === 1) return new Response('fixture failure', { status: ${status} });
          return Response.json({ result: [data.risk, data.ranking, data.digest].map(JSON.stringify) });
        }
        if (args[0] !== 'EVAL') throw new Error('unexpected command');
        writes++;
        return Response.json({ result: args[2] - 3 });
      };
      process.on('exit', () => console.log(JSON.stringify({ reads, writes })));
      process.argv[1] = ${JSON.stringify(fileURLToPath(entry))};
      await import(${JSON.stringify(entry.href)});
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, NODE_ENV: 'test', NODE_TEST_CONTEXT: 'child-v8', WM_ALLOW_ENV_LOAD_IN_TESTS: '0', WM_SEED_RETRY_DELAY_MS: '0', UPSTASH_REDIS_REST_URL: 'https://fixture.invalid', UPSTASH_REDIS_REST_TOKEN: 'fixture' },
    });
    assert.equal(result.status, expectedExit, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { reads: expectedReads, writes: recover ? 1 : 0 });
    assert.equal(result.stdout.includes('=== Done ('), recover);
  }
});

test('publisher atomically replaces dates, trims retention and stamps health only on confirmed writes', async () => {
  const calls = [];
  const snapshots = composeCountrySnapshots(inputs());
  await publishCountrySnapshots('https://redis.test', 'fixture', snapshots, now, async (...args) => {
    calls.push(args[2]);
    return { result: snapshots.length };
  });
  assert.equal(calls.length, 1);
  const [op, script, count, ...args] = calls[0];
  assert.equal(op, 'EVAL');
  assert.equal(count, 5);
  assert.deepEqual(args.slice(0, 5), ['history:country:US', 'history:country:FR', 'history:country:index', 'seed-meta:history:country', 'seed-activated:history:country']);
  assert.match(script, /ZREMRANGEBYSCORE/);
  assert.match(script, /day - 365/);
  await assert.rejects(publishCountrySnapshots('https://redis.test', 'fixture', snapshots, now, async () => ({ result: 1 })), /unconfirmed/);
});

const redisServer = process.env.REDIS_SERVER_BIN || 'redis-server';
const redisCli = process.env.REDIS_CLI_BIN || 'redis-cli';
const redisAvailable = [redisServer, redisCli].every(binary => {
  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return version.status === 0 && Number(version.stdout.match(/\b(\d+)\.\d+/)?.[1]) >= 7;
});

test('real Redis publication is idempotent, retains 365 days and leaves all countries and health unchanged on a type error', { skip: !redisAvailable && 'Redis server and CLI 7+ required' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'country-history-'));
  const socket = join(dir, 'redis.sock');
  const started = spawnSync(redisServer, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')]);
  assert.equal(started.status, 0);
  const cmd = (...args) => {
    const result = spawnSync(redisCli, ['-s', socket, '--json', ...args.map(String)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    for (let i = 0; i < 100 && !spawnSync(redisCli, ['-s', socket, 'PING']).stdout?.includes('PONG'); i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const command = async (_url, _token, args) => ({ result: cmd(...args) });
    const publish = async (time, score) => {
      const snapshots = composeCountrySnapshots(inputs()).map(row => ({ ...row, date: new Date(time).toISOString().slice(0, 10), capturedAt: time, cii: { score, version: 'v11', observedAt: time } }));
      await publishCountrySnapshots('', '', snapshots, time, command);
    };
    await publish(now - 365 * 86400000, 10);
    await publish(now - 364 * 86400000, 20);
    await publish(now, 30);
    await publish(now + 1000, 40);
    assert.equal(cmd('ZCARD', 'history:country:US'), 2);
    assert.equal(JSON.parse(cmd('ZRANGE', 'history:country:US', -1, -1)[0]).cii.score, 40);
    let attempts = 0;
    const snapshots = composeCountrySnapshots(inputs());
    await publishCountrySnapshots('', '', snapshots, now + 1000, async (_url, _token, args) => {
      const result = cmd(...args);
      if (++attempts === 1) throw new Error('fixture lost acknowledgement');
      return { result };
    });
    assert.equal(attempts, 2);
    assert.equal(cmd('ZCARD', 'history:country:US'), 2);
    assert.equal(JSON.parse(cmd('ZRANGE', 'history:country:US', -1, -1)[0]).cii.score, 0);
    const meta = cmd('GET', 'seed-meta:history:country');
    await assert.rejects(publish(now + 500, 50), /unconfirmed/);
    assert.equal(cmd('GET', 'seed-meta:history:country'), meta);
    cmd('DEL', 'history:country:FR');
    cmd('SET', 'history:country:FR', 'wrong-type');
    await assert.rejects(publish(now + 2000, 60));
    assert.equal(cmd('GET', 'seed-meta:history:country'), meta);
    assert.equal(JSON.parse(cmd('ZRANGE', 'history:country:US', -1, -1)[0]).cii.score, 0);
    assert.equal(cmd('TTL', 'seed-activated:history:country'), -1);
  } finally {
    spawnSync(redisCli, ['-s', socket, 'SHUTDOWN', 'NOSAVE']);
    rmSync(dir, { recursive: true, force: true });
  }
});
