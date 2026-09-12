// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { listWebhooks } from '../worldmonitor/shipping/v2/list-webhooks';
import { registerWebhook } from '../worldmonitor/shipping/v2/register-webhook';

const records = new Map<string, unknown>();
const owners = new Map<string, Set<string>>();
let failCommand = -1;
let replyOverride: unknown;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const commands = JSON.parse(String(init?.body)) as string[][];
  const results = commands.map((command, index) => {
    if (index === failCommand) return { error: 'synthetic storage failure' };
    if (command[0] === 'SMEMBERS') return { result: [...(owners.get(command[1]) ?? [])] };
    if (command[0] === 'GET') return { result: records.has(command[1]) ? JSON.stringify(records.get(command[1])) : null };
    if (command[0] === 'SET') { records.set(command[1], JSON.parse(command[2])); return { result: 'OK' }; }
    if (command[0] === 'SADD') {
      const members = owners.get(command[1]) ?? new Set<string>();
      const added = members.has(command[2]) ? 0 : 1;
      members.add(command[2]); owners.set(command[1], members); return { result: added };
    }
    return { result: owners.has(command[1]) ? 1 : 0 };
  });
  return new Response(JSON.stringify(replyOverride ?? results));
});
const payload = { callbackUrl: 'https://93.184.216.34/hook', chokepointIds: ['suez'], alertThreshold: 50 };
const context = { request: new Request('https://example.com/api/v2/shipping/webhooks', { headers: { 'X-Api-Key': 'tenant-a' } }), pathParams: {}, headers: {} };
beforeEach(() => {
  records.clear(); owners.clear(); failCommand = -1; replyOverride = undefined; fetchMock.mockClear();
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'tenant-a');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

for (const response of [{ invalid: true }, [], [{ result: 'OK' }], [{ result: 'OK' }, {}, { result: 1 }], [{ result: 'OK' }, { result: 1 }, { result: 0 }], null]) {
  test(`unconfirmed pipeline cannot report success: ${JSON.stringify(response)}`, async () => {
    if (response === null) vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    else replyOverride = response;
    await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 503 });
  });
}
for (const failed of [0, 1, 2]) {
  test(`partial command ${failed} failure returns 503; retry retains credential ownership`, async () => {
    failCommand = failed;
    await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 503 });
    // Pipeline commands are independent: failed calls can leave records or index entries.
    expect(records.size).toBe(failed === 0 ? 0 : 1);
    expect(owners.size).toBe(failed === 1 ? 0 : 1);
    failCommand = -1;
    const result = await registerWebhook(context, payload);
    const owner = createHash('sha256').update('tenant-a').digest('hex');
    expect(owners.get(`webhook:owner:${owner}:v1`)?.has(result.subscriberId)).toBe(true);
    expect(records.get(`webhook:sub:${result.subscriberId}:v1`)).toMatchObject({ ownerTag: owner, secret: result.secret });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const listed = await listWebhooks(context, {});
    expect(listed.webhooks.some(hook => hook.subscriberId === result.subscriberId)).toBe(true);
    // A SET failure leaves a dangling index member; the reader omits it.
    // An EXPIRE failure can leave the first record visible too; no rollback is claimed.
    expect(listed.webhooks).toHaveLength(failed === 2 ? 2 : 1);
    expect(JSON.stringify(listed)).not.toContain(result.secret);
  });
}
test('confirmed pipeline returns the persisted subscriber and secret', async () => {
  const result = await registerWebhook(context, payload);
  expect(records.get(`webhook:sub:${result.subscriberId}:v1`)).toMatchObject(result);
});

test.each([0, 1, '0', '1'])('accepts confirmed SADD result %s with string EXPIRE confirmation', async (added) => {
  replyOverride = [{ result: 'OK' }, { result: added }, { result: '1' }];
  const result = await registerWebhook(context, payload);
  expect(records.get(`webhook:sub:${result.subscriberId}:v1`)).toMatchObject(result);
});

test.each(['0', false, null, 'OK'])('rejects unconfirmed EXPIRE result %s', async (expiry) => {
  replyOverride = [{ result: 'OK' }, { result: '1' }, { result: expiry }];
  await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 503 });
});
