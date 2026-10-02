import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { registerWebhook } from '../server/worldmonitor/shipping/v2/register-webhook';
import { listWebhooks } from '../server/worldmonitor/shipping/v2/list-webhooks';
import { callerFingerprint, ownerIndexKey, webhookKey } from '../server/worldmonitor/shipping/v2/webhook-shared';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const request = new Request('https://worldmonitor.app/api/v2/shipping/webhooks', { headers: { 'X-WorldMonitor-Key': 'pro-test-key' } });
const ctx = { request, pathParams: {}, headers: {} };
beforeEach(() => {
  process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});
afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });

for (const action of ['list', 'register'] as const) {
  test(`${action} removes confirmed stale members and preserves live records`, async () => {
    const ownerTag = await callerFingerprint(request, 'pro-test-key');
    const members = new Set(['wh_expired', 'wh_live']);
    const record = { subscriberId: 'wh_live', ownerTag, callbackUrl: 'https://8.8.8.8/hook', chokepointIds: [], alertThreshold: 50, createdAt: '2026-09-01', active: true, secret: 'private' };
    const records = new Map([[webhookKey('wh_live'), JSON.stringify(record)]]);
    globalThis.fetch = async (_url, init) => {
      const commands = JSON.parse(String(init?.body)) as string[][];
      return Response.json(commands.map(([verb, key, ...args]) => {
        if (verb === 'SSCAN') return { result: ['0', [...members]] };
        if (verb === 'SMEMBERS') { assert.equal(key, ownerIndexKey(ownerTag)); return { result: [...members] }; }
        if (verb === 'GET') return { result: records.get(key) ?? null };
        if (verb === 'EVAL') {
          const [, ownerKey, recordKey, id] = args;
          assert.equal(ownerKey, ownerIndexKey(ownerTag));
          return { result: records.has(recordKey) ? 0 : Number(members.delete(id)) };
        }
        if (verb === 'SET') { records.set(key, args[0]); return { result: 'OK' }; }
        if (verb === 'SADD') { members.add(args[0]); return { result: 1 }; }
        if (verb === 'EXPIRE') return { result: 1 };
        throw new Error(`Unexpected Redis command ${verb}`);
      }));
    };
    if (action === 'list') {
      const result = await listWebhooks(ctx, {});
      assert.deepEqual(result.webhooks.map((hook) => hook.subscriberId), ['wh_live']);
      assert.equal('secret' in result.webhooks[0], false);
    } else {
      const result = await registerWebhook(ctx, { callbackUrl: 'https://8.8.8.8/hook', chokepointIds: [], alertThreshold: 50 });
      assert.equal(members.has(result.subscriberId), true);
    }
    assert.equal(members.has('wh_expired'), false);
    assert.equal(members.has('wh_live'), true);
  });
}

test('bounded sweeps repeat safely through oversized pages, renewal, failed reads and checkpoint loss', async () => {
  const { pruneOwnerWebhookIndex } = await import('../server/worldmonitor/shipping/v2/webhook-owner-index');
  const members = new Set(Array.from({ length: 250 }, (_, index) => `wh_${index}`));
  const pages = [[...members].slice(0, 220), [...members].slice(220)];
  let checkpoint: string | null = null;
  let failRead = false;
  let failSave = false;
  let reads = 0;
  let removals = 0;
  const cursors: string[] = [];
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(String(init?.body)) as string[][];
    return Response.json(commands.map(([verb, key, ...args]) => {
      if (key.endsWith(':sweep') && verb === 'GET') return { result: checkpoint };
      if (key.endsWith(':sweep') && verb === 'SET') {
        if (failSave) return { error: 'checkpoint unavailable' };
        checkpoint = args[0]; return { result: 'OK' };
      }
      if (verb === 'SSCAN') {
        cursors.push(args[0]);
        return { result: args[0] === '0' ? ['1', pages[0]] : ['0', pages[1]] };
      }
      if (verb === 'GET') { reads++; return failRead ? { error: 'unavailable' } : { result: null }; }
      if (verb === 'EVAL') {
        removals++;
        const id = args[3];
        return { result: id === 'wh_0' ? 0 : Number(members.delete(id)) };
      }
      throw new Error(`Unexpected ${verb}`);
    }));
  };
  const sweep = () => pruneOwnerWebhookIndex('owner');
  failRead = true;
  await assert.rejects(sweep, /could not be read or cleaned/);
  assert.equal(members.size, 250);
  assert.equal(checkpoint, null);
  failRead = false;
  failSave = true;
  await assert.rejects(sweep, /could not be read or cleaned/);
  assert.equal(members.size, 151);
  assert.equal(checkpoint, null);
  failSave = false;
  reads = 0; removals = 0;
  await Promise.all([sweep(), sweep()]);
  assert.equal(reads, 200);
  assert.equal(removals, 200);
  assert.deepEqual(JSON.parse(checkpoint!), { cursor: '0', offset: 100 });
  for (let index = 0; index < 3; index++) {
    reads = 0; removals = 0;
    await sweep();
    assert.ok(reads <= 100 && removals <= 100);
  }
  assert.deepEqual([...members], ['wh_0']);
  assert.deepEqual(JSON.parse(checkpoint!), { cursor: '0', offset: 0 });
  assert.equal(cursors.at(-1), '1');
  checkpoint = null;
  await sweep();
  assert.equal(cursors.at(-1), '0');
  assert.equal(members.has('wh_0'), true, 'record renewed before atomic recheck keeps membership');
});

test('new scan cycles revisit entries shifted by deletion and late checkpoint writes', async () => {
  const { pruneOwnerWebhookIndex } = await import('../server/worldmonitor/shipping/v2/webhook-owner-index');
  const members = new Set(Array.from({ length: 350 }, (_, index) => `wh_shift_${index}`));
  let checkpoint: string | null = null;
  let delayedCheckpoint: string | undefined;
  let delayFirstSave = true;
  let maxRecordReads = 0;
  globalThis.fetch = async (_url, init) => {
    const commands = JSON.parse(String(init?.body)) as string[][];
    maxRecordReads = Math.max(maxRecordReads, commands.filter(([verb, key]) => verb === 'GET' && !key.endsWith(':sweep')).length);
    return Response.json(commands.map(([verb, key, ...args]) => {
      if (key.endsWith(':sweep') && verb === 'GET') return { result: checkpoint };
      if (key.endsWith(':sweep') && verb === 'SET') {
        if (delayFirstSave) { delayedCheckpoint = args[0]; delayFirstSave = false; }
        else checkpoint = args[0];
        return { result: 'OK' };
      }
      if (verb === 'SSCAN') return { result: ['0', [...members]] };
      if (verb === 'GET') return { result: null };
      if (verb === 'EVAL') return { result: Number(members.delete(args[3])) };
      throw new Error(`Unexpected ${verb}`);
    }));
  };
  await pruneOwnerWebhookIndex('owner');
  await pruneOwnerWebhookIndex('owner');
  assert.equal(members.size, 150);
  checkpoint = delayedCheckpoint!;
  for (let call = 0; call < 6; call++) await pruneOwnerWebhookIndex('owner');
  assert.equal(members.size, 0);
  assert.equal(maxRecordReads, 100);
  assert.deepEqual(JSON.parse(checkpoint!), { cursor: '0', offset: 0 });
});
