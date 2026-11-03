// #9093 "Report an error": anonymous reports land in a bounded review queue and
// are never applied automatically. An operator (TRUST_REVIEW_SECRET) accepts or
// rejects; an accepted report publishes only the operator's public note.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  ERROR_REPORT_KEY,
  PENDING_REPORTS_KEY,
  PENDING_REPORTS_MAX,
  REVIEWED_REPORTS_KEY,
  TRUST_REVIEW_HEADER,
} from '../server/_shared/error-reports.ts';
import { LABEL_CHANGES_KEY, STORY_LABEL_HISTORY_KEY } from '../server/_shared/label-history.ts';
import {
  listErrorReports,
  reviewErrorReport,
  submitErrorReport,
} from '../server/worldmonitor/news/v1/error-reports.ts';
import { listLabelChanges } from '../server/worldmonitor/news/v1/list-label-changes.ts';

type Command = Array<string | number>;

/** Minimal in-memory Upstash REST: strings, sorted sets and lists. */
function fakeRedis() {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const lists = new Map<string, string[]>();
  const commands: Command[] = [];
  let failing = false;
  let failingTransactions = false;
  let failingGets = false;
  const zrange = (key: string, start: number, stop: number, reverse: boolean) => {
    const entries = [...(zsets.get(key) ?? new Map())].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
    if (reverse) entries.reverse();
    const end = stop < 0 ? entries.length + stop : stop;
    return entries.slice(start, end + 1).map(([member]) => member);
  };
  const run = (command: Command): unknown => {
    const [verb, key, ...args] = command.map(String) as [string, string, ...string[]];
    switch (verb) {
      case 'GET':
        if (failingGets && key.startsWith('trust:report:')) throw new Error('read failed');
        return strings.get(key) ?? null;
      case 'DEL': return strings.delete(key) ? 1 : 0;
      case 'SET': {
        if (args.includes('NX') && strings.has(key)) return null;
        if (args.includes('XX') && !strings.has(key)) return null;
        strings.set(key, args[0]!);
        return 'OK';
      }
      case 'ZCARD': return zsets.get(key)?.size ?? 0;
      case 'ZADD': {
        const set = zsets.get(key) ?? new Map<string, number>();
        set.set(args[1]!, Number(args[0]));
        zsets.set(key, set);
        return 1;
      }
      case 'ZREM': return zsets.get(key)?.delete(args[0]!) ? 1 : 0;
      case 'ZRANGE': return zrange(key, Number(args[0]), Number(args[1]), false);
      case 'ZREVRANGE': return zrange(key, Number(args[0]), Number(args[1]), true);
      case 'ZREMRANGEBYSCORE': {
        const max = args[1] === '+inf' ? Infinity : Number(args[1]);
        let removed = 0;
        for (const [member, score] of zsets.get(key) ?? []) {
          if (score <= max) { zsets.get(key)!.delete(member); removed++; }
        }
        return removed;
      }
      case 'ZREMRANGEBYRANK': {
        for (const member of zrange(key, Number(args[0]), Number(args[1]), false)) zsets.get(key)?.delete(member);
        return 0;
      }
      case 'LPUSH': {
        const list = lists.get(key) ?? [];
        list.unshift(args[0]!);
        lists.set(key, list);
        return list.length;
      }
      case 'LTRIM': {
        lists.set(key, (lists.get(key) ?? []).slice(Number(args[0]), Number(args[1]) + 1));
        return 'OK';
      }
      case 'LRANGE': return (lists.get(key) ?? []).slice(Number(args[0]), Number(args[1]) + 1);
      case 'SMEMBERS': return [];
      case 'EXPIRE': return 1;
      default: throw new Error(`fake redis: unsupported ${verb}`);
    }
  };
  const fetchImpl = (async (input: unknown, init?: { body?: string }) => {
    const transaction = String(input).endsWith('/multi-exec');
    if (failing || (transaction && failingTransactions)) return { ok: false, status: 500, json: async () => ({}) };
    const body = JSON.parse(init?.body ?? '[]') as Command[];
    commands.push(...body);
    return {
      ok: true,
      status: 200,
      json: async () => body.map((command) => {
        try {
          return { result: run(command) };
        } catch (error) {
          return { error: (error as Error).message };
        }
      }),
    };
  }) as unknown as typeof fetch;
  return {
    strings, zsets, lists, commands, fetchImpl,
    fail: () => { failing = true; },
    failTransactions: () => { failingTransactions = true; },
    failReportReads: () => { failingGets = true; },
  };
}

const SECRET = 'review-secret-for-tests';
const saved = { ...process.env };
const savedFetch = globalThis.fetch;
let redis: ReturnType<typeof fakeRedis>;

beforeEach(() => {
  redis = fakeRedis();
  globalThis.fetch = redis.fetchImpl;
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  process.env.TRUST_REVIEW_SECRET = SECRET;
  delete process.env.LOCAL_API_MODE;
  delete process.env.VERCEL_ENV;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

const ctx = (headers: Record<string, string> = {}) => ({
  request: new Request('https://example.test/api/news/v1/x', { headers }),
  pathParams: {},
  headers,
});
const operator = () => ctx({ [TRUST_REVIEW_HEADER]: SECRET });
const report = (overrides: Record<string, string> = {}) => ({
  message: 'The publisher count on this story includes two mastheads of one owner.',
  storyId: 'a'.repeat(64),
  url: 'https://www.worldmonitor.app/?story=x',
  contact: 'reader@example.com',
  website: '',
  ...overrides,
});
const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (error) {
    const e = error as { statusCode?: number; name?: string };
    return e.statusCode ?? (e.name === 'ValidationError' ? 400 : 500);
  }
};

describe('SubmitErrorReport', () => {
  it('stores a valid report as pending, and applies nothing', async () => {
    const response = await submitErrorReport(ctx(), report());
    assert.equal(response.status, 'received');
    assert.match(response.reportId, /^[0-9a-f-]{36}$/);
    const stored = JSON.parse(redis.strings.get(ERROR_REPORT_KEY(response.reportId))!);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.contact, 'reader@example.com');
    assert.ok(redis.zsets.get(PENDING_REPORTS_KEY)?.has(response.reportId));
    assert.equal(redis.lists.size, 0, 'nothing reaches the label log on submit');
  });

  it('a filled honeypot is accepted and discarded', async () => {
    const response = await submitErrorReport(ctx(), report({ website: 'http://spam.example' }));
    assert.deepEqual(response, { status: 'received', reportId: '' });
    assert.equal(redis.commands.length, 0);
  });

  it('validates the message, story id, url and contact', async () => {
    assert.equal(await statusOf(submitErrorReport(ctx(), report({ message: 'short' }))), 400);
    assert.equal(await statusOf(submitErrorReport(ctx(), report({ storyId: 'nothex' }))), 400);
    assert.equal(await statusOf(submitErrorReport(ctx(), report({ url: 'javascript:alert(1)' }))), 400);
    assert.equal(await statusOf(submitErrorReport(ctx(), report({ contact: 'not-an-email' }))), 400);
    const minimal = await submitErrorReport(ctx(), report({ storyId: '', url: '', contact: '' }));
    assert.equal(minimal.status, 'received');
  });

  it('a full queue refuses new reports instead of evicting older ones', async () => {
    const queue = new Map<string, number>();
    for (let i = 0; i < PENDING_REPORTS_MAX; i++) queue.set(`id-${i}`, Date.now() - i);
    redis.zsets.set(PENDING_REPORTS_KEY, queue);
    const response = await submitErrorReport(ctx(), report());
    assert.deepEqual(response, { status: 'queue-full', reportId: '' });
    assert.equal(queue.size, PENDING_REPORTS_MAX, 'the over-cap report is taken back out');
    assert.equal([...redis.strings.keys()].filter((key) => key.startsWith('trust:report:v1:')).length, 0, 'and its record deleted');
  });

  it('ids whose records expired leave the queue, so they cannot fill it', async () => {
    const queue = new Map<string, number>();
    const expired = Date.now() - 91 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < PENDING_REPORTS_MAX; i++) queue.set(`id-${i}`, expired);
    redis.zsets.set(PENDING_REPORTS_KEY, queue);
    const response = await submitErrorReport(ctx(), report());
    assert.equal(response.status, 'received');
    assert.deepEqual([...queue.keys()], [response.reportId]);
  });

  it('an unreachable store is a 503, never a false "received"', async () => {
    redis.fail();
    assert.equal(await statusOf(submitErrorReport(ctx(), report())), 503);
  });
});

describe('operator review', () => {
  it('needs the review secret, and nobody is an operator when it is unset', async () => {
    assert.equal(await statusOf(listErrorReports(ctx(), { status: '' })), 401);
    assert.equal(await statusOf(listErrorReports(ctx({ [TRUST_REVIEW_HEADER]: 'wrong' }), { status: '' })), 401);
    delete process.env.TRUST_REVIEW_SECRET;
    assert.equal(await statusOf(listErrorReports(operator(), { status: '' })), 401);
    assert.equal(await statusOf(reviewErrorReport(operator(), { reportId: 'x', decision: 'reject', publicNote: '' })), 401);
  });

  it('lists pending reports oldest first, with the private fields', async () => {
    const first = await submitErrorReport(ctx(), report({ message: 'First report about a wrong label.' }));
    const second = await submitErrorReport(ctx(), report({ message: 'Second report about a wrong label.' }));
    redis.zsets.get(PENDING_REPORTS_KEY)!.set(first.reportId, Date.now() - 2);
    redis.zsets.get(PENDING_REPORTS_KEY)!.set(second.reportId, Date.now() - 1);
    const listed = await listErrorReports(operator(), { status: 'pending' });
    assert.equal(listed.state, 'ok');
    assert.deepEqual(listed.reports.map((r) => r.id), [first.reportId, second.reportId]);
    assert.equal(listed.reports[0]!.contact, 'reader@example.com');
  });

  it('accepting publishes the operator note to the label log, never the reader text', async () => {
    const { reportId } = await submitErrorReport(ctx(), report());
    assert.equal(
      await statusOf(reviewErrorReport(operator(), { reportId, decision: 'accept', publicNote: '' })),
      400,
      'an accepted report needs a public note',
    );
    const { report: reviewed } = await reviewErrorReport(operator(), {
      reportId, decision: 'accept', publicNote: 'Defense News and Military Times now count as one publisher.',
    });
    assert.equal(reviewed!.status, 'accepted');
    assert.ok(reviewed!.reviewedAt > 0);
    assert.equal(redis.zsets.get(PENDING_REPORTS_KEY)?.has(reportId), false);
    assert.ok(redis.zsets.get(REVIEWED_REPORTS_KEY)?.has(reportId));

    const published = [...(redis.lists.get(LABEL_CHANGES_KEY) ?? []), ...(redis.lists.get(STORY_LABEL_HISTORY_KEY('a'.repeat(64))) ?? [])];
    assert.equal(published.length, 2, 'global and per-story logs');
    for (const raw of published) {
      assert.doesNotMatch(raw, /reader@example\.com|two mastheads of one owner/, 'reader text and contact stay private');
    }
    const log = await listLabelChanges(ctx(), { storyId: '', limit: 0 });
    assert.equal(log.changes.length, 1);
    assert.equal(log.changes[0]!.field, 'correction');
    assert.equal(log.changes[0]!.trigger, 'report');
    assert.equal(log.changes[0]!.reason, 'Defense News and Military Times now count as one publisher.');

    assert.equal(
      await statusOf(reviewErrorReport(operator(), { reportId, decision: 'reject', publicNote: '' })),
      409,
      'a reviewed report cannot be reviewed again',
    );
    const reviewedList = await listErrorReports(operator(), { status: 'reviewed' });
    assert.deepEqual(reviewedList.reports.map((r) => r.status), ['accepted']);
  });

  it('rejecting publishes nothing', async () => {
    const { reportId } = await submitErrorReport(ctx(), report());
    const { report: reviewed } = await reviewErrorReport(operator(), { reportId, decision: 'reject', publicNote: '' });
    assert.equal(reviewed!.status, 'rejected');
    assert.equal(redis.lists.size, 0);
  });

  it('an unreadable report record makes the list unavailable, not shorter', async () => {
    await submitErrorReport(ctx(), report());
    redis.failReportReads();
    assert.equal((await listErrorReports(operator(), { status: 'pending' })).state, 'unavailable');
  });

  it('a second reviewer is refused while the first holds the report', async () => {
    const { reportId } = await submitErrorReport(ctx(), report());
    redis.strings.set(`trust:report-review-lock:v1:${reportId}`, '1');
    assert.equal(await statusOf(reviewErrorReport(operator(), { reportId, decision: 'reject', publicNote: '' })), 409);
    assert.equal(JSON.parse(redis.strings.get(ERROR_REPORT_KEY(reportId))!).status, 'pending');
  });

  it('a review that fails to save changes nothing and frees the report', async () => {
    const { reportId } = await submitErrorReport(ctx(), report());
    redis.failTransactions();
    assert.equal(
      await statusOf(reviewErrorReport(operator(), { reportId, decision: 'accept', publicNote: 'Two mastheads now count once.' })),
      503,
    );
    assert.equal(JSON.parse(redis.strings.get(ERROR_REPORT_KEY(reportId))!).status, 'pending');
    assert.ok(redis.zsets.get(PENDING_REPORTS_KEY)?.has(reportId));
    assert.equal(redis.lists.size, 0, 'no correction published');
    assert.equal(redis.strings.has(`trust:report-review-lock:v1:${reportId}`), false, 'lock released');
  });

  it('rejects unknown decisions, malformed ids and missing reports', async () => {
    const { reportId } = await submitErrorReport(ctx(), report());
    assert.equal(await statusOf(reviewErrorReport(operator(), { reportId, decision: 'apply', publicNote: 'x' })), 400);
    assert.equal(await statusOf(reviewErrorReport(operator(), { reportId: 'nope', decision: 'reject', publicNote: '' })), 400);
    assert.equal(
      await statusOf(reviewErrorReport(operator(), { reportId: '00000000-0000-4000-8000-000000000000', decision: 'reject', publicNote: '' })),
      404,
    );
  });
});
