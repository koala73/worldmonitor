import { convexTest } from 'convex-test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schema from '../schema';

const modules = import.meta.glob('../**/*.ts');
const credentials = {
  gateway: 'synthetic-gateway',
  delivery: 'synthetic-delivery',
  suppression: 'synthetic-suppression',
};
const envNames = {
  gateway: 'CONVEX_TENANT_RELAY_SECRET',
  delivery: 'CONVEX_NOTIFICATION_RELAY_SECRET',
  suppression: 'CONVEX_EMAIL_SUPPRESSION_SECRET',
};
type Role = keyof typeof credentials;
const routes: [string, 'POST' | 'GET', Role[]][] = [
  ['notification-channels', 'POST', ['gateway']],
  ['create-checkout', 'POST', ['gateway']],
  ['customer-portal', 'POST', ['gateway']],
  ['register-referral-code', 'POST', ['gateway']],
  ['channels', 'POST', ['delivery']],
  ['deactivate', 'POST', ['delivery']],
  ['digest-rules', 'GET', ['delivery']],
  ['enabled-rules', 'GET', ['delivery']],
  ['user-preferences', 'POST', ['delivery']],
  ['entitlement', 'POST', ['delivery']],
  ['followed-countries', 'POST', ['gateway', 'delivery']],
  ['bulk-suppress-emails', 'POST', ['suppression']],
];

beforeEach(() => {
  vi.stubEnv('RELAY_SHARED_SECRET', 'synthetic-ingestion');
  for (const role of Object.keys(credentials) as Role[]) vi.stubEnv(envNames[role], credentials[role]);
});
afterEach(() => vi.unstubAllEnvs());

function request(method: 'GET' | 'POST', secret: string, body: unknown = {}) {
  return {
    method,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  };
}

test.each(routes)('%s enforces the service-role matrix before processing', async (path, method, roles) => {
  const t = convexTest(schema, modules);
  for (const secret of ['', 'wrong', 'synthetic-ingestion']) {
    expect((await t.fetch(`/relay/${path}`, request(method, secret))).status).toBe(401);
  }
  for (const role of Object.keys(credentials) as Role[]) {
    const response = await t.fetch(`/relay/${path}`, request(method, credentials[role]));
    // Authorized POSTs reach existing input validation; GETs run real queries.
    expect(response.status).toBe(roles.includes(role) ? method === 'GET' ? 200 : 400 : 401);
  }
});

test.each(routes)('%s fails closed on missing or reused role credentials', async (path, method, roles) => {
  const t = convexTest(schema, modules);
  for (const role of roles) {
    vi.stubEnv(envNames[role], '');
    expect((await t.fetch(`/relay/${path}`, request(method, credentials[role]))).status).toBe(401);
    vi.stubEnv(envNames[role], 'synthetic-ingestion');
    expect((await t.fetch(`/relay/${path}`, request(method, 'synthetic-ingestion'))).status).toBe(401);
    const other = (Object.keys(credentials) as Role[]).find(candidate => candidate !== role)!;
    vi.stubEnv(envNames[role], credentials[other]);
    expect((await t.fetch(`/relay/${path}`, request(method, credentials[other]))).status).toBe(401);
    vi.stubEnv(envNames[role], credentials[role]);
  }
});

test('ingestion cannot read, enumerate or delete tenants; the proper roles recover', async () => {
  const t = convexTest(schema, modules);
  await t.run(async ctx => {
    for (const userId of ['tenant-a', 'tenant-b']) {
      await ctx.db.insert('notificationChannels', { userId, channelType: 'telegram', chatId: `private-${userId}`, verified: true, linkedAt: 1 });
      await ctx.db.insert('alertRules', { userId, variant: 'full', enabled: true, eventTypes: [], sensitivity: 'high', channels: ['telegram'], updatedAt: 1 });
    }
  });
  for (const action of ['get', 'delete-channel']) {
    const body = { action, userId: 'tenant-b', channelType: 'telegram' };
    const denied = await t.fetch('/relay/notification-channels', request('POST', 'synthetic-ingestion', body));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: 'UNAUTHORIZED' });
  }
  expect((await t.fetch('/relay/enabled-rules', request('GET', 'synthetic-ingestion'))).status).toBe(401);
  expect((await t.run(ctx => ctx.db.query('notificationChannels').collect())).length).toBe(2);
  const channels = await t.fetch('/relay/notification-channels', request('POST', credentials.gateway, { userId: 'tenant-b' }));
  expect(channels.status).toBe(200);
  expect((await channels.json()).channels[0].chatId).toBe('private-tenant-b');
  const rules = await t.fetch('/relay/enabled-rules', request('GET', credentials.delivery));
  expect(rules.status).toBe(200);
  expect((await rules.json()).map((rule: { userId: string }) => rule.userId).sort()).toEqual(['tenant-a', 'tenant-b']);
  const deleted = await t.fetch('/relay/notification-channels', request('POST', credentials.gateway, { action: 'delete-channel', userId: 'tenant-b', channelType: 'telegram' }));
  expect(deleted.status).toBe(200);
  expect((await t.run(ctx => ctx.db.query('notificationChannels').collect())).map(row => row.userId)).toEqual(['tenant-a']);
});

test('a role remains usable without an ingestion credential configured', async () => {
  vi.stubEnv('RELAY_SHARED_SECRET', '');
  const t = convexTest(schema, modules);
  expect((await t.fetch('/relay/enabled-rules', request('GET', credentials.delivery))).status).toBe(200);
});

test.each(['synthetic-delivery', 'Basic synthetic-delivery', 'Bearer synthetic-delivery extra'])(
  'rejects malformed authorization: %s', async authorization => {
    const t = convexTest(schema, modules);
    expect((await t.fetch('/relay/enabled-rules', { headers: { Authorization: authorization } })).status).toBe(401);
  },
);
