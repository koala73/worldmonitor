import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const source = readFileSync(new URL('../scripts/seed-digest-notifications.mjs', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('digest.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function productionFunction(name: string) {
  const fn = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn, `production function ${name} must exist`);
  return fn.getText(parsed);
}

for (const proof of ['legacy', 'unverified', 'verified'] as const) {
  const channel = {
    channelType: 'telegram', chatId: '12345', verified: proof !== 'unverified',
    ...(proof === 'legacy' ? {} : { telegramOwnership: 'verified_callback' }),
  };
  test(`realtime Telegram transport requires callback proof: ${proof}`, async () => {
    Object.assign(process.env, {
      UPSTASH_REDIS_REST_URL: 'https://upstash.test', UPSTASH_REDIS_REST_TOKEN: 'fake',
      CONVEX_URL: 'https://convex.test', CONVEX_SITE_URL: 'https://convex.test',
      CONVEX_NOTIFICATION_RELAY_SECRET: 'fake', TELEGRAM_BOT_TOKEN: 'fake', AI_IMPACT_ENABLED: '0',
    });
    const loader = Module as unknown as { _load: (...args: any[]) => any };
    const originalLoad = loader._load;
    loader._load = function (name, ...args) {
      if (name === 'resend') return { Resend: class {} };
      return originalLoad.call(this, name, ...args);
    };
    const relayPath = require.resolve('../scripts/notification-relay.cjs');
    delete require.cache[relayPath];
    let relay: any;
    try { relay = require(relayPath); } finally { loader._load = originalLoad; }
    const sends: any[] = [];
    let reads = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/relay/enabled-rules')) return Response.json([{
        userId: 'owner', variant: 'full', sensitivity: 'critical', eventTypes: ['market_alert'], channels: ['telegram'],
      }]);
      if (url.endsWith('/relay/channels')) { reads++; return Response.json([channel]); }
      if (url.includes('/GET/relay%3Aentitlement')) return Response.json({ result: '1' });
      if (url.includes('/SET/')) return Response.json({ result: 'OK' });
      if (url.includes('/LLEN/')) return Response.json({ result: 1 });
      if (url.includes('/LRANGE/')) return Response.json({ result: [JSON.stringify({ eventType: 'market_alert', payload: { title: 'Held alert' } })] });
      if (url.includes('/DEL/')) return Response.json({ result: 1 });
      assert.equal(url, 'https://api.telegram.org/botfake/sendMessage');
      sends.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    };
    await relay.processEvent({ eventType: 'market_alert', severity: 'critical', payload: { title: 'Synthetic alert' } });
    assert.equal(reads, 1);
    assert.equal(sends.length, proof === 'verified' ? 1 : 0);
    if (sends.length) assert.equal(sends[0].chat_id, '12345');
    await relay.processWelcome({ userId: 'owner', channelType: 'telegram' });
    assert.equal(sends.length, proof === 'verified' ? 1 : 0, 'Telegram welcome belongs only to the trusted Convex callback');
    await relay.processEvent({ eventType: 'flush_quiet_held', userId: 'owner', variant: 'full' });
    assert.equal(reads, 2);
    assert.equal(sends.length, proof === 'verified' ? 2 : 0, 'held alerts must require the same recipient proof');
  });

  test(`digest Telegram transport requires callback proof: ${proof}`, async () => {
    // Run the real orchestration, selection and Telegram transport. Only
    // unrelated story composition/storage dependencies are fixture providers.
    const sends: any[] = [];
    let reads = 0;
    const metadata: any[] = [];
    const run = runInNewContext([
      'main', 'sendTelegram', 'sanitizeTelegramHtml', 'truncateTelegramHtml',
    ].map(productionFunction).join('\n') + '\nmain', {
      Date, Map, Set, Intl, AbortSignal, process: { env: {} }, console: { log() {}, warn() {} },
      CONVEX_SITE_URL: 'https://convex.test', RELAY_SECRET: 'fake', DIGEST_LOOKBACK_MS: 86400000,
      TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_MAX_LEN: 4096, AI_DIGEST_ENABLED: false,
      scanAndEnqueueWatchlistStoryEvents: async () => {},
      fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith('/relay/digest-rules')) return Response.json([{ userId: 'owner', variant: 'full', channels: ['telegram'] }]);
        if (url.endsWith('/relay/channels')) { reads++; return Response.json([channel]); }
        assert.equal(url, 'https://api.telegram.org/botfake/sendMessage');
        sends.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
      parseDigestOnlyUser: () => ({ kind: 'unset' }),
      composeBriefsForRun: async () => ({ briefByUser: new Map(), composeSuccess: 0, composeFailed: 0 }),
      readCooldownConfig: () => ({ invalidRaw: null, mode: 'off' }),
      getLastSentAt: async () => 0, isDue: () => true, isUserPro: async () => true,
      digestWindowStartMs: () => 0, buildDigest: async () => [{ title: 'Synthetic alert' }],
      buildDigestDeliveryPlan: ({ rawStories }: any) => ({ formatterStories: rawStories, cooldownIterableStories: [], sourceCountByClusterId: new Map() }),
      formatDigest: () => 'Synthetic alert', formatDigestHtml: () => '<p>Synthetic alert</p>',
      buildChannelBodies: (text: string) => ({ text, telegramText: text }),
      injectEmailSummary: (html: string) => html, injectBriefCta: (html: string) => html,
      subjectForBrief: () => 'Synthetic alert', issueSlotInTz: () => 'test-slot',
      emitCooldownShadowLog: () => {}, upstashRest: async () => 'OK',
      shouldExitOnBriefFailures: () => false,
      writeDigestLastRunMeta: async (meta: unknown) => { metadata.push(meta); },
    });
    await run();
    assert.equal(reads, 1);
    assert.equal(sends.length, proof === 'verified' ? 1 : 0);
    assert.equal(metadata[0].sentCount, proof === 'verified' ? 1 : 0);
    if (sends.length) assert.equal(sends[0].chat_id, '12345');
  });
}
