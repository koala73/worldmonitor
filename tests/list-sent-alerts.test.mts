/**
 * ListSentAlerts returns the alerts the relay delivered to ONE account.
 *
 * The account is the user id the gateway authenticated and stamped on the
 * request; the handler takes it from nowhere else. These tests drive the real
 * generated route with a Redis stub that records every key read, so a read of
 * another user's key fails the suite.
 *
 * Run: node --import tsx --test tests/list-sent-alerts.test.mts
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createRequire } from 'node:module';

import { newsHandler } from '../server/worldmonitor/news/v1/handler';
import { mapErrorToResponse } from '../server/error-mapper';
import { validateGeneratedRequest } from '../server/request-validator';
import { TRUSTED_USER_ID_HEADER } from '../server/_shared/mcp-internal-hmac';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import {
  SENT_ALERTS_KEY_PREFIX,
  SENT_ALERTS_MAX,
  SENT_ALERTS_RETENTION_DAYS,
  sentAlertsKey,
} from '../server/_shared/sent-alert-history';
import {
  createNewsServiceRoutes,
  type ListSentAlertsResponse,
} from '../src/generated/server/worldmonitor/news/v1/service_server';

const require = createRequire(import.meta.url);
const relayHistory = require('../scripts/lib/sent-alert-history.cjs');

const route = createNewsServiceRoutes(newsHandler, { validateRequest: validateGeneratedRequest, onError: mapErrorToResponse })
  .find(entry => entry.path.endsWith('/list-sent-alerts'))!;

const envKeys = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'LOCAL_API_MODE'] as const;
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

let lists: Map<string, string[]>;
let reads: string[][];
let redisFails: boolean;

function record(title: string, extra: Record<string, unknown> = {}) {
  return relayHistory.buildSentAlertRecord({
    title,
    source: 'Reuters',
    link: 'https://www.reuters.com/world/story',
    eventType: 'rss_alert',
    severity: 'critical',
    channels: ['email'],
    sentAt: Date.now() - 60_000,
    ...extra,
  });
}

function seed(userId: string, records: unknown[]) {
  lists.set(relayHistory.sentAlertsKey(userId), records.map(item => (typeof item === 'string' ? item : JSON.stringify(item))));
}

async function call(headers: Record<string, string> = {}): Promise<{ status: number; body: ListSentAlertsResponse & { message?: string } }> {
  const response = await route.handler(new Request('https://worldmonitor.app/api/news/v1/list-sent-alerts', { headers }));
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  lists = new Map();
  reads = [];
  redisFails = false;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  delete process.env.VERCEL_ENV;
  delete process.env.LOCAL_API_MODE;
  __resetKeyPrefixCacheForTests();
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as string[];
    reads.push(command);
    if (redisFails) return new Response(JSON.stringify({ error: 'ERR down' }), { status: 500 });
    const [name, key, start, stop] = command;
    assert.equal(name, 'LRANGE', 'the handler only reads a list');
    const items = lists.get(key!) ?? [];
    return new Response(JSON.stringify({ result: items.slice(Number(start), Number(stop) + 1) }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
  __resetKeyPrefixCacheForTests();
});

describe('ListSentAlerts', () => {
  it('refuses a request with no authenticated user and reads nothing', async () => {
    seed('user-a', [record('Private headline for user A')]);
    const { status, body } = await call();
    assert.equal(status, 401);
    assert.equal(JSON.stringify(body).includes('Private headline'), false);
    assert.deepEqual(reads, [], 'no Redis read without an identity');
  });

  it('refuses a blank user id', async () => {
    const { status } = await call({ [TRUSTED_USER_ID_HEADER]: '   ' });
    assert.equal(status, 401);
    assert.deepEqual(reads, []);
  });

  it('returns the caller alerts, newest first, with the fields the search shows', async () => {
    const newer = record('Newer headline', { sentAt: Date.now() - 1_000, channels: ['email', 'web_push'] });
    const older = record('Older headline', { sentAt: Date.now() - 3_600_000 });
    seed('user-a', [newer, older]);
    const { status, body } = await call({ [TRUSTED_USER_ID_HEADER]: 'user-a' });
    assert.equal(status, 200);
    assert.equal(body.state, 'ok');
    assert.equal(body.retentionDays, SENT_ALERTS_RETENTION_DAYS);
    assert.deepEqual(body.alerts, [
      { title: 'Newer headline', source: 'Reuters', link: 'https://www.reuters.com/world/story', eventType: 'rss_alert', severity: 'critical', sentAt: newer.sentAt, channels: ['email', 'web_push'] },
      { title: 'Older headline', source: 'Reuters', link: 'https://www.reuters.com/world/story', eventType: 'rss_alert', severity: 'critical', sentAt: older.sentAt, channels: ['email'] },
    ]);
  });

  it('reads only the key of the authenticated user', async () => {
    seed('user-a', [record('Headline sent to A')]);
    seed('user-b', [record('Headline sent to B')]);

    const a = await call({ [TRUSTED_USER_ID_HEADER]: 'user-a' });
    assert.deepEqual(a.body.alerts.map(alert => alert.title), ['Headline sent to A']);
    const b = await call({ [TRUSTED_USER_ID_HEADER]: 'user-b' });
    assert.deepEqual(b.body.alerts.map(alert => alert.title), ['Headline sent to B']);

    assert.deepEqual(reads.map(command => command[1]), [sentAlertsKey('user-a'), sentAlertsKey('user-b')]);
  });

  it('ignores a user id sent as a query parameter or body field', async () => {
    seed('user-a', [record('Headline sent to A')]);
    seed('user-b', [record('Headline sent to B')]);
    const response = await route.handler(new Request(
      'https://worldmonitor.app/api/news/v1/list-sent-alerts?user_id=user-b&userId=user-b',
      { headers: { [TRUSTED_USER_ID_HEADER]: 'user-a' } },
    ));
    const body = await response.json() as ListSentAlertsResponse;
    assert.deepEqual(body.alerts.map(alert => alert.title), ['Headline sent to A']);
    assert.deepEqual(reads.map(command => command[1]), [sentAlertsKey('user-a')]);
  });

  it('reads the unprefixed key the relay writes, also on a preview deployment', async () => {
    process.env.VERCEL_ENV = 'preview';
    process.env.VERCEL_GIT_COMMIT_SHA = 'abcdef1234567890';
    __resetKeyPrefixCacheForTests();
    seed('user-a', [record('Headline sent to A')]);
    const { body } = await call({ [TRUSTED_USER_ID_HEADER]: 'user-a' });
    assert.equal(body.alerts.length, 1);
    assert.equal(reads[0]![1], 'wm:notif:sent:v1:user-a');
  });

  it('answers ok with no alerts for an account that has none', async () => {
    const { status, body } = await call({ [TRUSTED_USER_ID_HEADER]: 'user-new' });
    assert.equal(status, 200);
    assert.deepEqual(body.alerts, []);
    assert.equal(body.state, 'ok');
  });

  it('reports unavailable, not empty, when the record cannot be read', async () => {
    redisFails = true;
    const { status, body } = await call({ [TRUSTED_USER_ID_HEADER]: 'user-a' });
    assert.equal(status, 200);
    assert.deepEqual(body.alerts, []);
    assert.equal(body.state, 'unavailable');
  });

  it('drops unreadable rows, rows past the retention window and unsafe links', async () => {
    const eightDays = 8 * 24 * 60 * 60 * 1000;
    seed('user-a', [
      'not json',
      { title: '', sentAt: Date.now() },
      { title: 'No timestamp' },
      record('Expired headline', { sentAt: Date.now() - eightDays }),
      { ...record('Unsafe link headline'), link: 'javascript:alert(1)' },
      record('Kept headline'),
    ]);
    const { body } = await call({ [TRUSTED_USER_ID_HEADER]: 'user-a' });
    assert.deepEqual(body.alerts.map(alert => [alert.title, alert.link]), [
      ['Unsafe link headline', ''],
      ['Kept headline', 'https://www.reuters.com/world/story'],
    ]);
  });

  it('asks Redis for at most the list cap', async () => {
    await call({ [TRUSTED_USER_ID_HEADER]: 'user-a' });
    assert.deepEqual(reads[0], ['LRANGE', sentAlertsKey('user-a'), '0', String(SENT_ALERTS_MAX - 1)]);
  });
});

describe('sent-alert history contract between the relay and the server', () => {
  it('uses one key, one cap and one retention window', () => {
    assert.equal(SENT_ALERTS_KEY_PREFIX, relayHistory.SENT_ALERTS_KEY_PREFIX);
    assert.equal(sentAlertsKey('user_2abc'), relayHistory.sentAlertsKey('user_2abc'));
    assert.equal(SENT_ALERTS_MAX, relayHistory.SENT_ALERTS_MAX);
    assert.equal(SENT_ALERTS_RETENTION_DAYS * 24 * 60 * 60, relayHistory.SENT_ALERTS_TTL_SECONDS);
  });
});
