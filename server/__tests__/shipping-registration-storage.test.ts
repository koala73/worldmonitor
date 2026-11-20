// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { listWebhooks } from '../worldmonitor/shipping/v2/list-webhooks';
import { registerWebhook, REGISTER_WEBHOOK_SCRIPT } from '../worldmonitor/shipping/v2/register-webhook';

const records = new Map<string, unknown>();
const owners = new Map<string, Set<string>>();
let failCommand = -1;
let replyOverride: unknown;
const isRegistration = (commands: string[][]) => commands.length === 1 && commands[0][1] === REGISTER_WEBHOOK_SCRIPT;
const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
  const commands = JSON.parse(String(init?.body)) as string[][];
  const results = commands.map((command, index) => {
    if (isRegistration(commands) && index === failCommand) return { error: 'synthetic storage failure' };
    if (command[0] === 'SMEMBERS') return { result: [...(owners.get(command[1]) ?? [])] };
    if (command[0] === 'SSCAN') return { result: ['0', [...(owners.get(command[1]) ?? [])]] };
    if (command[0] === 'GET') {
      if (!records.has(command[1])) return { result: null };
      const value = records.get(command[1]);
      return { result: typeof value === 'string' ? value : JSON.stringify(value) };
    }
    if (command[0] === 'SET') {
      if (!String(command[1]).endsWith(':sweep')) records.set(command[1], JSON.parse(command[2]));
      return { result: 'OK' };
    }
    if (command[0] === 'SADD') {
      const members = owners.get(command[1]) ?? new Set<string>();
      const added = members.has(command[2]) ? 0 : 1;
      members.add(command[2]); owners.set(command[1], members); return { result: added };
    }
    if (isRegistration(commands)) {
      const [, , , recordKey, ownerKey, allKey, quotaKey, raw, id, , cap] = command;
      if ([ownerKey, quotaKey].some(key => (owners.get(key)?.size ?? 0) >= Number(cap))) return { result: 0 };
      records.set(recordKey, JSON.parse(raw));
      for (const key of [ownerKey, allKey, quotaKey]) {
        const members = owners.get(key) ?? new Set<string>();
        members.add(id); owners.set(key, members);
      }
      return { result: 1 };
    }
    if (command[0] === 'EVAL') {
      const ownerKey = command[3];
      const recordKey = command[4];
      const id = command[5];
      if (!records.has(recordKey)) {
        owners.get(ownerKey)?.delete(id);
        return { result: 1 };
      }
      return { result: 0 };
    }
    return { result: owners.has(command[1]) ? 1 : 0 };
  });
  return new Response(JSON.stringify(
    isRegistration(commands) && replyOverride !== undefined ? replyOverride : results,
  ));
});
const registrationFetches = () => fetchMock.mock.calls.filter(([, init]) => (
  isRegistration(JSON.parse(String(init?.body)))
));
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

for (const response of [
  { invalid: true },
  [],
  [{ result: 'OK' }],
  [{ result: 'OK' }, { result: 1 }, { result: 1 }],
  [{ result: 'OK' }, {}, { result: 1 }, { result: 1 }],
  [{ result: 'OK' }, { result: 1 }, { result: 0 }, { result: 1 }],
  [{ result: 'OK' }, { result: 1 }, { result: 1 }, {}],
  null,
]) {
  test(`unconfirmed pipeline cannot report success: ${JSON.stringify(response)}`, async () => {
    if (response === null) vi.stubEnv('UPSTASH_REDIS_REST_URL', '');
    else replyOverride = response;
    await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 503 });
  });
}
test('failed admission returns 503; retry retains credential ownership', async () => {
  const owner = createHash('sha256').update('tenant-a').digest('hex');
  failCommand = 0;
  await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 503 });
  expect(records.size).toBe(0);
  expect(owners.size).toBe(0);
  failCommand = -1;
  const result = await registerWebhook(context, payload);
  expect(owners.get(`webhook:owner:${owner}:v1`)?.has(result.subscriberId)).toBe(true);
  expect(records.get(`webhook:sub:${result.subscriberId}:v1`)).toMatchObject({ ownerTag: owner, secret: result.secret });
  expect(registrationFetches()).toHaveLength(2);
  const listed = await listWebhooks(context, {});
  expect(listed.webhooks).toHaveLength(1);
  expect(owners.get('webhook:all:v1')?.has(result.subscriberId)).toBe(true);
  expect(JSON.stringify(listed)).not.toContain(result.secret);
});
test('confirmed pipeline returns the persisted subscriber and secret', async () => {
  const result = await registerWebhook(context, payload);
  expect(records.get(`webhook:sub:${result.subscriberId}:v1`)).toMatchObject(result);
});

test.each([1, '1'])('accepts confirmed atomic admission %s', async (admitted) => {
  replyOverride = [{ result: admitted }];
  const result = await registerWebhook(context, payload);
  expect(records.get(`webhook:sub:${result.subscriberId}:v1`)).toMatchObject(result);
});

test.each([0, '0'])('returns 429 for confirmed quota rejection %s', async (admitted) => {
  replyOverride = [{ result: admitted }];
  await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 429 });
});

test.each([false, null, 'OK', 2])('rejects unconfirmed admission result %s', async (admitted) => {
  replyOverride = [{ result: admitted }];
  await expect(registerWebhook(context, payload)).rejects.toMatchObject({ statusCode: 503 });
});
