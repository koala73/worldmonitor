import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import notify, { __setNotifyDepsForTests } from '../api/notify.ts';

const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  __setNotifyDepsForTests(null);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

for (const proof of ['legacy', 'unverified', 'verified'] as const) {
  test(`/api/notify through relay and mocked Resend: ${proof}`, async () => {
    Object.assign(process.env, {
      UPSTASH_REDIS_REST_URL: 'https://upstash.test', UPSTASH_REDIS_REST_TOKEN: 'fake',
      CONVEX_URL: 'https://convex.test', CONVEX_SITE_URL: 'https://convex.test',
      CONVEX_NOTIFICATION_RELAY_SECRET: 'fake', RESEND_API_KEY: 'fake', AI_IMPACT_ENABLED: 'false',
    });
    const sends: Array<{ to: string; subject: string; text: string }> = [];
    const loader = Module as unknown as { _load: (...args: any[]) => any };
    const originalLoad = loader._load;
    loader._load = function (name, ...args) {
      if (name === 'resend') return { Resend: class { emails = { send: async (message: any) => { sends.push(message); return { data: { id: 'fake' } }; } }; } };
      return originalLoad.call(this, name, ...args);
    };
    const relayPath = require.resolve('../scripts/notification-relay.cjs');
    delete require.cache[relayPath];
    let relay: any;
    try { relay = require(relayPath); } finally { loader._load = originalLoad; }
    const queued: any[] = [];
    const channelReads: string[] = [];
    let heldDeleted = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/lpush/')) {
        queued.push(JSON.parse(decodeURIComponent(url.split('/').at(-1)!)));
        return Response.json({ result: 1 });
      }
      if (url.includes('/relay/enabled-rules')) return Response.json(['owner', 'other'].map(userId => ({
        userId, variant: 'full', enabled: true, sensitivity: 'critical', digestMode: 'realtime', eventTypes: ['market_alert'], channels: ['email'],
      })));
      if (url.includes('/relay/channels')) {
        channelReads.push(JSON.parse(String(init?.body)).userId);
        return Response.json([{
          _id: 'channel', channelType: 'email', email: 'owner@example.com',
          verified: proof !== 'unverified', ...(proof === 'legacy' ? {} : { emailOwnership: 'verified_account' }),
        }]);
      }
      if (url.includes('/GET/relay%3Aentitlement')) return Response.json({ result: '1' });
      if (url.includes('/LLEN/')) return Response.json({ result: 1 });
      if (url.includes('/LRANGE/')) return Response.json({ result: [JSON.stringify(queued[0])] });
      if (url.includes('/DEL/')) { heldDeleted = true; return Response.json({ result: 1 }); }
      if (url.includes('/SET/')) return Response.json({ result: 'OK' });
      throw new Error(`Unexpected transport: ${url}`);
    };
    __setNotifyDepsForTests({
      validateBearerToken: async () => ({ valid: true, userId: 'owner' }),
      checkTierProEntitlement: async () => ({ allowed: true }),
      checkScopedRateLimit: async () => ({ allowed: true, limit: 30, remaining: 29, reset: 0, degraded: false }),
    });
    const response = await notify(new Request('https://worldmonitor.app/api/notify', {
      method: 'POST', headers: { Authorization: 'Bearer fake', Origin: 'https://worldmonitor.app', 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'market_alert', severity: 'critical', variant: 'full', payload: { title: 'Synthetic market alert', link: 'https://example.com/alert' } }),
    }));
    assert.equal(response.status, 200);
    assert.equal(queued.length, 1);
    await relay.processEvent(queued[0]);
    assert.deepEqual(channelReads, ['owner'], 'caller event cannot fan out to another user');
    assert.equal(sends.length, proof === 'verified' ? 1 : 0);
    if (proof === 'verified') {
      assert.equal(sends[0].to, 'owner@example.com');
      assert.equal(sends[0].subject, 'Community alert: Synthetic market alert');
      // A caller's off-origin article link is delivered, but only with its
      // destination host disclosed inline — that disclosure is the control,
      // not collapsing the link (which destroyed real article links on the
      // platform's own RSS alerts). The push click target is still
      // first-party-only; see tests/notify-field-validation.test.mts.
      assert.match(sends[0].text, /https:\/\/example\.com\/alert \(source: example\.com\)/);
    }
    await relay.processWelcome({ userId: 'owner', channelType: 'email', welcomeId: 'channel' });
    assert.equal(sends.length, proof === 'verified' ? 2 : 0);
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'owner', variant: 'full' });
    assert.equal(sends.length, proof === 'verified' ? 3 : 0);
    assert.equal(heldDeleted, proof === 'verified', 'held alerts remain queued until an owned channel receives them');
  });
}

for (const proof of ['legacy', 'unverified', 'verified'] as const) {
  test(`digest main enforces email ownership: ${proof}`, async () => {
    // Execute the production orchestration function without starting the cron.
    // Mock story/provider dependencies, not the channel selection or send loop.
    const source = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
    const main = source.slice(source.indexOf('async function main() {'), source.lastIndexOf('\nmain().catch'));
    const metadata: any[] = [];
    let channelReads = 0;
    let sends = 0;
    const run = runInNewContext(`${main}\nmain`, {
      Date, Map, Set, AbortSignal, process: { env: {} }, console: { log() {}, warn() {} },
      CONVEX_SITE_URL: 'https://convex.test', RELAY_SECRET: 'fake', DIGEST_LOOKBACK_MS: 86400000,
      scanAndEnqueueWatchlistStoryEvents: async () => {},
      fetch: async (url: string) => {
        if (url.endsWith('/relay/digest-rules')) return Response.json([{ userId: 'owner', variant: 'full', channels: ['email'] }]);
        assert.ok(url.endsWith('/relay/channels'));
        channelReads++;
        return Response.json([{ channelType: 'email', email: 'owner@example.com', verified: proof !== 'unverified', ...(proof === 'legacy' ? {} : { emailOwnership: 'verified_account' }) }]);
      },
      parseDigestOnlyUser: () => ({ kind: 'unset' }),
      composeBriefsForRun: async () => ({ briefByUser: new Map(), composeSuccess: 0, composeFailed: 0 }),
      readCooldownConfig: () => ({ invalidRaw: null, mode: 'off' }),
      getLastSentAt: async () => 0, isDue: () => true, isUserPro: async () => true,
      digestWindowStartMs: () => 0, buildDigest: async () => [{ title: 'Synthetic alert' }],
      shouldExitOnBriefFailures: () => false,
      AI_DIGEST_ENABLED: false,
      buildDigestDeliveryPlan: ({ rawStories }: any) => ({ formatterStories: rawStories, cooldownIterableStories: [], sourceCountByClusterId: new Map() }),
      formatDigest: () => 'Synthetic digest', formatDigestHtml: () => '<p>Synthetic digest</p>',
      buildChannelBodies: (text: string) => ({ text }),
      injectEmailSummary: (html: string) => html, injectBriefCta: (html: string) => html,
      subjectForBrief: () => 'Synthetic digest', issueSlotInTz: () => 'slot',
      emitCooldownShadowLog: () => {}, upstashRest: async () => 'OK',
      sendEmail: async (email: string) => { assert.equal(email, 'owner@example.com'); sends++; return true; },
      writeDigestLastRunMeta: async (meta: unknown) => { metadata.push(meta); },
    });
    await run();
    assert.equal(channelReads, 1);
    assert.equal(sends, proof === 'verified' ? 1 : 0);
    assert.equal(metadata[0].sentCount, proof === 'verified' ? 1 : 0);
  });
}
