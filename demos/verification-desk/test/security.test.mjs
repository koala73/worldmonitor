import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { fetchArticleText } from '../lib/sources.mjs';
import { loginThrottle } from '../lib/access.mjs';

const fixtureEnv = (extra) => ({
  PATH: process.env.PATH,
  DESK_OFFLINE: '1',
  DESK_HOST: '127.0.0.1',
  DESK_PASSWORD: '',
  DESK_PUBLIC_ORIGIN: '',
  RAILWAY_PUBLIC_DOMAIN: '',
  WORLDMONITOR_API_KEY: '',
  WORLDMONITOR_MCP_TOKEN: '',
  ANTHROPIC_API_KEY: '',
  ELEVENLABS_API_KEY: '',
  ELEVENLABS_VOICE_ID: '',
  LIVEAVATAR_API_KEY: '',
  LIVEAVATAR_AVATAR_ID: '',
  ...extra,
});

async function startDesk(t, extra = {}) {
  const portFinder = createServer();
  await new Promise((resolve) => portFinder.listen(0, '127.0.0.1', resolve));
  const port = portFinder.address().port;
  await new Promise((resolve) => portFinder.close(resolve));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: fixtureEnv({ PORT: String(port), ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  let output = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => { output += data; if (output.includes('Verification Desk on')) resolve(); });
    child.stderr.on('data', (data) => { output += data; });
    child.once('exit', () => reject(new Error(output)));
  });
  await ready;
  return (pathname, { method = 'GET', headers = {}, body = '' } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: pathname, method, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), port }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('desk rejects rebinding Hosts and cross-site API calls before routing', { timeout: 15000 }, async (t) => {
  const call = await startDesk(t);
  const good = await call('/api/config', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(good.status, 200);
  for (const host of ['rebind.attacker.example', `localhost:${good.port + 1}`, 'localhost.attacker.example', 'localhost:bad']) {
    assert.equal((await call('/api/config', { headers: { Host: host, 'Sec-Fetch-Site': 'same-origin' } })).status, 403, host);
  }
  for (const pathname of ['/api/grade?headline=story', '/api/board?refresh=1', '/api/recap', '/api/reveal', '/api/config', '/api/avatar/token', '/api/tts']) {
    const method = ['/api/avatar/token', '/api/tts'].includes(pathname) ? 'POST' : 'GET';
    assert.equal((await call(pathname, { method, headers: { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' }, body: method === 'POST' ? '{"text":"hello"}' : '' })).status, 403, pathname);
    assert.equal((await call(pathname, { method })).status, 403, `missing origin: ${pathname}`);
  }
  for (const origin of ['null', `http://localhost:${good.port + 1}`, `https://localhost:${good.port}`]) {
    assert.equal((await call('/api/config', { headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  }
  assert.equal((await call('/api/config', { headers: { Origin: `http://localhost:${good.port}`, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await call('/api/config', { headers: { Origin: `http://localhost:${good.port}` } })).status, 200);
  assert.equal((await call('/api/grade', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 400);
  assert.equal((await call('/api/tts', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'text/plain' }, body: '{"text":"hello"}' })).status, 415);
  assert.equal((await call('/api/tts', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' }, body: '{"text":"hello"}' })).status, 204);
  assert.equal((await call('/desk')).status, 200, 'presenter page remains accessible');
});

test('hosted origin and login work through a reverse proxy', { timeout: 15000 }, async (t) => {
  const call = await startDesk(t, { DESK_PASSWORD: 'a-long-stage-password', DESK_PUBLIC_ORIGIN: 'https://desk.example' });
  const headers = { Host: 'desk.example', Origin: 'https://desk.example', 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' };
  assert.equal((await call('/api/config', { headers })).status, 401);
  const login = await call('/login', { method: 'POST', headers, body: 'password=a-long-stage-password' });
  assert.equal(login.status, 303);
  assert.match(login.headers['set-cookie'][0], /Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await call('/api/config', { headers: { ...headers, Cookie: cookie } })).status, 200);
  assert.equal((await call('/api/config', { headers: { ...headers, Cookie: cookie, Origin: 'https://attacker.example' } })).status, 403);
});

test('parallel login failures cannot bypass the process-wide throttle', { timeout: 15000 }, async (t) => {
  const call = await startDesk(t, { DESK_PASSWORD: 'a-long-stage-password' });
  const headers = { 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' };
  const attempts = await Promise.all(Array.from({ length: 12 }, () => call('/login', { method: 'POST', headers, body: 'password=wrong' })));
  assert.equal(attempts.filter((r) => r.status === 401).length, 1);
  assert.equal(attempts.filter((r) => r.status === 429).length, 11);
  assert.ok(attempts.filter((r) => r.status === 429).every((r) => Number(r.headers['retry-after']) >= 1));
  assert.equal((await call('/login', { method: 'POST', headers, body: 'password=a-long-stage-password' })).status, 429);
  await new Promise((resolve) => setTimeout(resolve, 850));
  assert.equal((await call('/login', { method: 'POST', headers, body: 'password=a-long-stage-password' })).status, 303);
});

test('a stalled login upload does not block a complete login and is closed', { timeout: 10000 }, async (t) => {
  const call = await startDesk(t, { DESK_PASSWORD: 'a-long-stage-password' });
  const { port } = await call('/api/config', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  const slow = request({ hostname: '127.0.0.1', port, path: '/login', method: 'POST', headers: {
    Host: `localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Length': '1000',
  } });
  const closed = new Promise((resolve) => slow.once('error', resolve));
  t.after(() => slow.destroy());
  slow.write('password=x');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const complete = await call('/login', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' }, body: 'password=a-long-stage-password' });
  assert.equal(complete.status, 303);
  const error = await closed;
  assert.equal(error.code, 'ECONNRESET');
  assert.equal((await call('/login', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' }, body: 'password=a-long-stage-password' })).status, 303);
});

test('short hosted passwords fail before listening', { timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.mjs'], {
    cwd: new URL('..', import.meta.url), env: fixtureEnv({ PORT: '0', DESK_PASSWORD: 'short' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const timer = setTimeout(() => child.kill(), 2000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  assert.equal(code, 1, output);
  assert.match(output, /DESK_PASSWORD.*16/);
});

const publicDns = async () => [{ address: '93.184.215.14', family: 4 }];

test('article input is capped before parsing, and oversized streams are cancelled', async () => {
  let cancelled = false;
  let wholeBodyRead = false;
  const res = { ok: true, status: 200, text: async () => { wholeBodyRead = true; return 'x'.repeat(2_000_001); }, body: new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(250_000).fill(120)); }, cancel() { cancelled = true; },
  }) };
  assert.equal(await fetchArticleText('https://news.example/article', { lookupImpl: publicDns, fetchImpl: async () => res }), null);
  assert.equal(wholeBodyRead, false);
  assert.equal(cancelled, true);
  const html = '<script>' + 'x'.repeat(60_000) + '</script><p>LATE ARTICLE MARKER</p>' + 'filler '.repeat(40);
  const text = await fetchArticleText('https://news.example/article', { lookupImpl: publicDns, fetchImpl: async () => new Response(html) });
  assert.equal(text, null, 'the raw HTML budget applies before tag stripping');
  const failedBody = new ReadableStream({ start(controller) { controller.error(new Error('publisher disconnected')); } });
  assert.equal(await fetchArticleText('https://news.example/article', { lookupImpl: publicDns, fetchImpl: async () => ({ ok: true, status: 200, body: failedBody }) }), null);
  assert.equal(failedBody.locked, false, 'the reader lock is released even when cancellation rejects');
});

test('article socket lookup uses the validated DNS result', async () => {
  let lookups = 0;
  const lookupImpl = async () => { lookups++; return lookups === 1 ? await publicDns() : [{ address: '127.0.0.1', family: 4 }]; };
  let socketAddress;
  const text = await fetchArticleText('https://news.example/article', { lookupImpl, fetchImpl: async (url, init) => {
    assert.equal(typeof init.lookup, 'function', 'the transport must receive a pinned lookup');
    init.lookup('news.example', { all: true }, (error, addresses) => { assert.ifError(error); socketAddress = addresses[0].address; });
    return new Response('article text '.repeat(30));
  } });
  assert.ok(text);
  assert.equal(socketAddress, '93.184.215.14');
  assert.equal(lookups, 1, 'the connection does not perform another DNS lookup');
});

test('login backoff grows, is bounded, and resets after success', () => {
  const throttle = loginThrottle();
  let now = 1000;
  for (const delay of [800, 1600, 3200, 6400, 12800, 25600, 30000, 30000]) {
    assert.equal(throttle.retryAfter(now), 0);
    assert.ok(throttle.retryAfter(now) > 0, 'a second concurrent check is refused');
    throttle.finish(false, now);
    assert.equal(throttle.retryAfter(now + delay - 1), 1);
    now += delay;
  }
  assert.equal(throttle.retryAfter(now), 0);
  throttle.finish(true, now);
  assert.equal(throttle.retryAfter(now), 0);
});

test('native article transport preserves Host and pins each redirect connection', { timeout: 10000 }, async (t) => {
  const hosts = [];
  const fixture = createServer((req, res) => {
    hosts.push(req.headers.host);
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/article' }); return res.end(); }
    if (req.url === '/slow') return;
    if (req.url === '/large') return res.end('x'.repeat(1_000_001));
    res.end('<p>' + 'article text '.repeat(30) + '</p>');
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const port = fixture.address().port;
  let dnsCalls = 0;
  const lookupImpl = async () => { dnsCalls++; return await publicDns(); };
  const pinned = [];
  const requestImpl = (url, options, callback) => request(url, {
    ...options,
    lookup(host, lookupOptions, done) {
      options.lookup(host, lookupOptions, (error, addresses) => {
        pinned.push(addresses);
        // Only the fixture socket is remapped. Production's validated lookup is recorded above.
        done(error, lookupOptions.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
      });
    },
  }, callback);
  const root = `http://news.example:${port}`;
  assert.ok((await fetchArticleText(`${root}/redirect`, { lookupImpl, requestImpl }))?.includes('article text'));
  assert.equal(dnsCalls, 2);
  assert.deepEqual(pinned, [await publicDns(), await publicDns()]);
  assert.deepEqual(hosts, [`news.example:${port}`, `news.example:${port}`]);
  assert.equal(await fetchArticleText(`${root}/large`, { lookupImpl, requestImpl }), null);
  assert.equal(await fetchArticleText(`${root}/slow`, { lookupImpl, requestImpl, timeoutMs: 50 }), null);
});

test('malformed script, style and tag input finishes within a bounded subprocess', () => {
  const moduleUrl = new URL('../lib/sources.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { fetchArticleText } from ${JSON.stringify(moduleUrl)};
    for (const tag of ['<script ', '<style ', '<']) {
      const text = await fetchArticleText('https://news.example/article', {
        lookupImpl: async () => [{ address: '93.184.215.14', family: 4 }],
        fetchImpl: async () => new Response(tag.repeat(100_000)),
      });
      assert.equal(text, null);
    }
  `], { timeout: 2000, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
