import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerWebhook, MAX_WEBHOOKS_PER_OWNER } from '../server/worldmonitor/shipping/v2/register-webhook';
import { ALL_INDEX_KEY, callerFingerprint, ownerIndexKey, webhookKey, WEBHOOK_TTL } from '../server/worldmonitor/shipping/v2/webhook-shared';
import unsubscribe from '../api/v2/shipping/webhooks/[subscriberId]';
import action from '../api/v2/shipping/webhooks/[subscriberId]/[action]';

const cli = process.env.REDIS_CLI_BIN || 'redis-cli';
const server = process.env.REDIS_SERVER_BIN || 'redis-server';
const enabled = spawnSync(cli, ['--version']).status === 0 && spawnSync(server, ['--version']).status === 0;

test('real Redis enforces webhook quotas across concurrency, keys and lifecycle', { skip: !enabled && 'redis-server and redis-cli required' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'webhook-quota-'));
  const socket = join(dir, 'redis.sock');
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const started = spawnSync(server, ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no', '--daemonize', 'yes', '--pidfile', join(dir, 'pid'), '--logfile', join(dir, 'log')]);
  assert.equal(started.status, 0);
  const command = (...args: (string | number)[]): unknown => {
    const result = spawnSync(cli, ['-s', socket, '--json', ...args.map(String)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    if (result.stdout.startsWith('error:')) throw new Error(JSON.parse(result.stdout.slice(6)));
    return JSON.parse(result.stdout);
  };
  const request = (key: string, id?: string, method = 'POST', suffix = '') => new Request(
    `https://worldmonitor.app/api/v2/shipping/webhooks${id ? `/${id}${suffix}` : ''}`,
    { method, headers: { 'X-WorldMonitor-Key': key } },
  );
  const register = (key = 'pro-test-key') => registerWebhook({ request: request(key), pathParams: {}, headers: {} }, {
    callbackUrl: 'https://8.8.8.8/hook', chokepointIds: [], alertThreshold: 50,
  });
  let failRegistration = false;
  let quotaResult: unknown = undefined;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnSync(cli, ['-s', socket, 'PING']).status === 0) { ready = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.ok(ready);
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key,other-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake';
    process.env.CONVEX_SITE_URL = 'https://convex.test';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'fake';
    delete process.env.VERCEL_ENV;
    delete process.env.LOCAL_API_MODE;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/internal-validate-api-key')) {
        return Response.json({ id: 'key', userId: 'quota-user', keyKind: 'api', activeKeyRank: 0 });
      }
      if (url.endsWith('/api/internal-entitlements')) {
        return Response.json({ planKey: 'api_pro', validUntil: Date.now() + 86400000, features: { tier: 2, apiAccess: true } });
      }
      assert.ok(url.startsWith('https://redis.test/'), url);
      if (url.includes('/get/')) return Response.json({ result: command('GET', decodeURIComponent(url.split('/get/')[1])) });
      const body = JSON.parse(String(init?.body)) as (string | number)[] | (string | number)[][];
      const run = (cmd: (string | number)[]) => {
        if (cmd[0] === 'EVAL' && String(cmd[1]).includes('SCARD')) {
          if (failRegistration) return { error: 'unavailable' };
          if (quotaResult !== undefined) return { result: quotaResult };
        }
        try { return { result: command(...cmd) }; }
        catch (err) { return { error: String(err) }; }
      };
      return Response.json(url.endsWith('/pipeline') ? (body as (string | number)[][]).map(run) : run(body as (string | number)[]));
    };

    await t.test('parallel requests stop at 10 without orphan records or indexes', async () => {
      const results = await Promise.allSettled(Array.from({ length: 40 }, () => register()));
      assert.equal(results.filter(r => r.status === 'fulfilled').length, MAX_WEBHOOKS_PER_OWNER);
      for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.statusCode, 429);
      const owner = await callerFingerprint(request('pro-test-key'));
      assert.equal(command('SCARD', ownerIndexKey(owner)), 10);
      assert.equal(command('SCARD', ALL_INDEX_KEY), 10);
      assert.equal((command('KEYS', 'webhook:sub:*') as string[]).length, 10);
      const separate = await register('other-key');
      assert.ok(command('GET', webhookKey(separate.subscriberId)));
    });

    await t.test('deletion and expiry free slots; renewal keeps account quota alive', async () => {
      command('FLUSHDB');
      const keys = ['wm_' + 'a'.repeat(40), 'wm_' + 'b'.repeat(40)];
      const records = [];
      for (let i = 0; i < 10; i++) records.push(await register(keys[i % 2]));
      await assert.rejects(register(keys[1]), (err: { statusCode: number }) => err.statusCode === 429);
      const id = records[0].subscriberId;
      const stored = JSON.parse(command('GET', webhookKey(id)) as string);
      const quotaKey = ownerIndexKey(stored.quotaTag);
      assert.notEqual(stored.quotaTag, stored.ownerTag);
      assert.equal(command('SCARD', quotaKey), 10);
      command('EXPIRE', quotaKey, 60);
      assert.equal((await action(request(keys[0], id, 'POST', '/rotate-secret'))).status, 200);
      assert.ok(Number(command('TTL', quotaKey)) >= WEBHOOK_TTL - 2);
      assert.equal((await action(request(keys[0], id, 'POST', '/reactivate'))).status, 200);
      assert.equal((await unsubscribe(request(keys[0], id, 'DELETE'))).status, 200);
      assert.equal(command('SCARD', quotaKey), 9);
      await register(keys[1]);
      // Expiry leaves stale membership until the next bounded registration sweep.
      command('DEL', webhookKey(records[1].subscriberId));
      await register(keys[0]);
      assert.equal(command('SCARD', quotaKey), 10);
    });

    await t.test('legacy oversized indexes reject new registrations', async () => {
      command('FLUSHDB');
      const owner = await callerFingerprint(request('pro-test-key'));
      for (let i = 0; i < 11; i++) {
        command('SET', webhookKey(`legacy-${i}`), '{}');
        command('SADD', ownerIndexKey(owner), `legacy-${i}`);
      }
      await assert.rejects(register(), (err: { statusCode: number }) => err.statusCode === 429);
      assert.equal(command('SCARD', ALL_INDEX_KEY), 0);
    });

    await t.test('unavailable or malformed admission replies fail closed', async () => {
      command('FLUSHDB');
      failRegistration = true;
      await assert.rejects(register(), (err: { statusCode: number }) => err.statusCode === 503);
      failRegistration = false;
      quotaResult = 'OK';
      await assert.rejects(register(), (err: { statusCode: number }) => err.statusCode === 503);
      assert.equal(command('SCARD', ALL_INDEX_KEY), 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    spawnSync(cli, ['-s', socket, 'SHUTDOWN', 'NOSAVE']);
    rmSync(dir, { recursive: true, force: true });
  }
});
