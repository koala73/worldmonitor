import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderDigestEmailHtml, DIGEST_EMAIL_MAX_HTML_BYTES } from '../scripts/lib/digest-email-html.mjs';
import { buildBriefOnlyRules, rotateBriefOnlyRules } from '../scripts/lib/brief-compose.mjs';

// A transient Upstash timeout in one user's send path used to reach
// main().catch and end the whole cron tick, so every user after it in the
// rule list got no digest (Railway crash, 2026-10-17 13:28Z). Each rule's
// send now fails on its own.

const require = createRequire(import.meta.url);
const { appendUnsubscribeText, injectUnsubscribeFooterHtml, listUnsubscribeHeaders, unsubscribeUrlFor } = require('../scripts/lib/email-unsubscribe.cjs');

const source = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
const mainSource = source.slice(source.indexOf('async function main() {'), source.lastIndexOf('\nmain().catch'));
const sendStart = source.indexOf('async function sendEmail(');
const sendEmailSource = source.slice(sendStart, source.indexOf('\n}\n', sendStart) + 2);

function timeoutError() {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function runDigest({ failingUsers, rulesResponse, exitError, briefOnlyUserIds = [] }: {
  failingUsers: Set<string>;
  rulesResponse?: Response;
  exitError?: Error;
  briefOnlyUserIds?: string[];
}) {
  const users = ['first', 'second', 'third'];
  const composedRules: any[][] = [];
  const delivered: string[] = [];
  const metadata: any[] = [];
  const exits: number[] = [];
  const warnings: string[] = [];
  const lifecycle: string[] = [];
  const stories = [{
    severity: 'critical', phase: 'developing', title: 'Synthetic alert', description: 'Synthetic details.',
    link: 'https://example.com/1', sources: ['Synthetic wire'],
  }];
  const run = runInNewContext(`${sendEmailSource}\n${mainSource}\nmain`, {
    Date, Map, Set, AbortSignal, Buffer,
    process: { env: {}, exit: (code: number) => {
      exits.push(code);
      lifecycle.push('exit');
      if (exitError) throw exitError;
    } },
    console: { log() {}, warn: (...args: unknown[]) => { warnings.push(args.join(' ')); }, error() {} },
    DIGEST_EMAIL_MAX_HTML_BYTES, injectUnsubscribeFooterHtml, unsubscribeUrlFor,
    appendUnsubscribeText, listUnsubscribeHeaders, resend: {}, RESEND_FROM: 'brief@example.com',
    CONVEX_SITE_URL: 'https://convex.test', RELAY_SECRET: 'fake', DIGEST_LOOKBACK_MS: 86400000,
    scanAndEnqueueWatchlistStoryEvents: async () => {},
    fetch: async (url: string, init: { body?: string }) => {
      if (url.endsWith('/relay/digest-rules')) {
        return rulesResponse ?? Response.json(users.map((userId) => ({ userId, variant: 'full', channels: ['email'] })));
      }
      assert.ok(url.endsWith('/relay/channels'));
      const { userId } = JSON.parse(String(init.body));
      return Response.json([{ channelType: 'email', email: `${userId}@example.com`, verified: true, emailOwnership: 'verified_account' }]);
    },
    parseDigestOnlyUser: () => ({ kind: 'unset' }),
    fetchBriefOnlyUserIds: async () => briefOnlyUserIds, buildBriefOnlyRules, rotateBriefOnlyRules,
    BRIEF_ONLY_COMPOSE_BUDGET_MS: 60_000,
    composeBriefsForRun: async (rules: any[], _nowMs: number, opts?: { deadlineMs?: number }) => {
      composedRules.push(rules);
      lifecycle.push(opts?.deadlineMs ? 'compose:bounded' : 'compose');
      return { briefByUser: new Map(), composeSuccess: 0, composeFailed: 0 };
    },
    readCooldownConfig: () => ({ invalidRaw: null, mode: 'off' }),
    getLastSentAt: async () => 0, isDue: () => true, isUserPro: async () => true,
    digestWindowStartMs: () => 0,
    buildDigest: async (rule: { userId: string }) => {
      if (failingUsers.has(rule.userId)) throw timeoutError();
      return stories;
    },
    shouldExitOnBriefFailures: () => false,
    flushPendingLlmEvents: async () => { lifecycle.push('flush'); },
    AI_DIGEST_ENABLED: false,
    buildDigestDeliveryPlan: ({ rawStories }: any) => ({ formatterStories: rawStories, cooldownIterableStories: [], sourceCountByClusterId: new Map() }),
    formatDigest: () => 'Synthetic digest',
    renderDigestEmailHtml,
    buildChannelBodies: (lists: { plain: string }) => ({ text: lists.plain }),
    subjectForBrief: () => 'Synthetic digest', issueSlotInTz: () => 'slot',
    emitCooldownShadowLog: () => {}, upstashRest: async () => 'OK',
    sendResendEmail: async (_client: unknown, message: { to: string }) => {
      delivered.push(message.to);
      lifecycle.push('deliver');
      return { ok: true };
    },
    writeDigestLastRunMeta: async (meta: unknown) => { metadata.push(meta); lifecycle.push('metadata'); },
  });
  return { run, delivered, metadata, exits, warnings, lifecycle, composedRules };
}

// A paid user with no digest rule got no brief, and the dashboard said
// "composing" forever (2026-10-27). They get a default compose-only rule, which
// must reach compose and never reach any channel.
// Array.from copies out of the VM realm so deepStrictEqual compares values, not prototypes.
const ids = (rules: any[]) => Array.from(rules, (r: { userId: string; briefOnly?: boolean }) => `${r.userId}${r.briefOnly ? ':brief-only' : ''}`);

test('paid users without a digest rule are composed but never sent anything', async () => {
  const { run, delivered, composedRules, lifecycle } = runDigest({ failingUsers: new Set(), briefOnlyUserIds: ['brief_only', 'second'] });
  await run();
  // 'second' already has a digest rule, so it gets no duplicate default.
  assert.deepEqual(composedRules.map(ids), [['first', 'second', 'third'], ['brief_only:brief-only']]);
  assert.deepEqual(delivered, ['first@example.com', 'second@example.com', 'third@example.com']);
  // Default briefs are composed after every delivery, under a deadline, so they
  // never delay a scheduled digest (#9758 review).
  const events = Array.from(lifecycle).filter((e) => e !== 'metadata');
  assert.deepEqual(events, ['compose', 'deliver', 'deliver', 'deliver', 'compose:bounded']);
});

test('a run with no digest rules still composes the brief-only users', async () => {
  const { run, delivered, composedRules, metadata } = runDigest({
    failingUsers: new Set(), rulesResponse: Response.json([]), briefOnlyUserIds: ['brief_only'],
  });
  await run();
  assert.deepEqual(composedRules.map(ids), [[], ['brief_only:brief-only']]);
  assert.deepEqual(delivered, []);
  assert.equal(metadata.at(-1).sentCount, 0);
});

test('a non-array rules response fails after recording metadata and flushing events', async (t) => {
  for (const body of [{}, { rules: [] }, null, 'rules', 1, false]) {
    await t.test(JSON.stringify(body), async () => {
      const exitError = new Error('process exited');
      const { run, delivered, metadata, exits, lifecycle } = runDigest({
        failingUsers: new Set(), rulesResponse: Response.json(body), exitError,
      });
      await assert.rejects(run, (err) => err === exitError);
      assert.deepEqual(exits, [1]);
      assert.equal(metadata.length, 1);
      assert.equal(metadata[0].status, 'error');
      assert.equal(metadata[0].errorReason, 'fetch_rules_malformed');
      assert.deepEqual(lifecycle, ['metadata', 'flush', 'exit']);
      assert.deepEqual(delivered, []);
    });
  }
});

test('an empty rules array remains a healthy zero-work run', async () => {
  const { run, delivered, metadata, exits } = runDigest({
    failingUsers: new Set(), rulesResponse: Response.json([]),
  });
  await run();
  assert.deepEqual(exits, []);
  assert.deepEqual(delivered, []);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].status, undefined);
  assert.equal(metadata[0].sentCount, 0);
});

test('a timeout in one user\'s send does not stop the digests of later users', async () => {
  const { run, delivered, metadata, exits, warnings } = runDigest({ failingUsers: new Set(['first']) });
  await run();
  assert.deepEqual(delivered, ['second@example.com', 'third@example.com']);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].status, 'error');
  assert.equal(metadata[0].sentCount, 2);
  assert.equal(metadata[0].errorReason, 'send_failed:1:sent:2');
  assert.deepEqual(exits, [], 'a partial failure keeps the run green; the failed user is retried while still due');
  assert.ok(warnings.some((line) => line.includes('send failed user=first') && line.includes('TimeoutError')));
});

test('a tick where every send fails still exits non-zero', async () => {
  const { run, delivered, metadata, exits } = runDigest({ failingUsers: new Set(['first', 'second', 'third']) });
  await run();
  assert.deepEqual(delivered, []);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].status, 'error');
  assert.equal(metadata[0].errorReason, 'send_failed:3:sent:0');
  assert.deepEqual(exits, [1]);
});

test('a clean tick records a healthy run', async () => {
  const { run, delivered, metadata, exits } = runDigest({ failingUsers: new Set() });
  await run();
  assert.equal(delivered.length, 3);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].status, undefined);
  assert.equal(metadata[0].sentCount, 3);
  assert.deepEqual(exits, []);
});
