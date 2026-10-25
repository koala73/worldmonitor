import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { renderDigestEmailHtml, DIGEST_EMAIL_MAX_HTML_BYTES } from '../scripts/lib/digest-email-html.mjs';

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

function runDigest({ failingUsers, rulesResponse, exitError }: {
  failingUsers: Set<string>;
  rulesResponse?: Response;
  exitError?: Error;
}) {
  const users = ['first', 'second', 'third'];
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
    composeBriefsForRun: async () => ({ briefByUser: new Map(), composeSuccess: 0, composeFailed: 0 }),
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
      return { ok: true };
    },
    writeDigestLastRunMeta: async (meta: unknown) => { metadata.push(meta); lifecycle.push('metadata'); },
  });
  return { run, delivered, metadata, exits, warnings, lifecycle };
}

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
