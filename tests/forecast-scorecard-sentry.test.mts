import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

// captureSilentError no-ops unless _sentry-common.js parsed a DSN when it was
// first imported, so the DSN is set before the dynamic import below.
const previousNodeTestContext = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;
process.env.VITE_SENTRY_DSN = 'https://testpublickey@sentry.test/12345';
process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';

const ENVELOPE_URL_PREFIX = 'https://sentry.test/api/12345/envelope';
const MARKET_ALERTS_KEY = 'correlation:market-alerts:scorecard:v1';

const { getForecastScorecard } = await import('../server/worldmonitor/forecast/v1/get-forecast-scorecard.ts');

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
after(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  if (previousNodeTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = previousNodeTestContext;
});

describe('getForecastScorecard market-alert read failure (#8867)', () => {
  it('reports one warning-level Sentry event', async () => {
    const events: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.startsWith(ENVELOPE_URL_PREFIX)) {
        const lines = String(init?.body ?? '').trim().split('\n');
        events.push(JSON.parse(lines[lines.length - 1]));
        return new Response('{}', { status: 200 });
      }
      const key = decodeURIComponent(url.split('/get/')[1] ?? '');
      if (key === MARKET_ALERTS_KEY) throw new Error('redis unavailable');
      return Response.json({ result: null });
    }) as typeof fetch;
    console.error = () => {};

    await getForecastScorecard({ request: new Request('https://worldmonitor.app/x'), pathParams: {}, headers: {} }, {});
    for (let i = 0; i < 50 && events.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.level, 'warning');
    assert.deepEqual((events[0]?.tags as Record<string, string>)?.step, 'market-alerts-read');
  });
});
