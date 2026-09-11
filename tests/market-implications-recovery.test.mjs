import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAndSeedMarketImplications, __setRedisStoreForTests,
  __setForecastLlmTransportForTests, __setForecastLlmRunDeadlineForTests,
} from '../scripts/seed-forecasts.mjs';

const originalEnv = { ...process.env };
const realFetch = global.fetch;
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
  process.env = { ...originalEnv };
  global.fetch = realFetch;
  __setRedisStoreForTests(null);
  __setForecastLlmTransportForTests(null);
  __setForecastLlmRunDeadlineForTests(null);
});
const key = 'intelligence:market-implications:v1';
const metaKey = 'seed-meta:intelligence:market-implications';
const oldTime = '2020-01-01T00:00:00.000Z';
const card = { ticker: 'USO', name: 'United States Oil Fund', direction: 'LONG',
  timeframe: '1W', confidence: 'HIGH', title: 'Oil supply risk',
  narrative: 'Shipping disruption increases the risk of reduced oil supply.',
  risk_caveat: 'Shipping can recover.', driver: 'Shipping disruption', transmission_chain: [] };
// Synthetic malformed JSON with a missing comma between card fields.
const malformed = '[{"ticker":"USO" "name":"United States Oil Fund"}]';
function setup(responses) {
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter';
  const store = { [key]: { cards: [card], generatedAt: oldTime, model: 'old' },
    [metaKey]: { fetchedAt: Date.parse(oldTime), lastSuccessAt: Date.parse(oldTime), status: 'ok', recordCount: 1 } };
  __setRedisStoreForTests(store);
  __setForecastLlmRunDeadlineForTests(Date.now() + 120_000);
  global.fetch = async () => ({ ok: true, json: async () => ({ result: 1 }) });
  const requests = [];
  __setForecastLlmTransportForTests({ fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    assert.ok(requests.length <= responses.length, 'no unbounded retries');
    const response = responses[requests.length - 1];
    response.beforeReturn?.();
    return { ok: response.status === undefined, status: response.status,
      headers: new Headers(), json: async () => ({ model: 'fixture-model',
      choices: [{ message: { content: response.text }, finish_reason: 'stop' }],
      usage: response.tokens === undefined ? undefined : { completion_tokens: response.tokens } }) };
  } });
  return { store, requests };
}

test('unparseable synthesis recovers in one bounded attempt and publishes actual new cards', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500 },
    { text: JSON.stringify([card]), tokens: 200 }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 2);
  assert.equal(requests[0].max_tokens, 2500);
  assert.equal(requests[1].max_tokens, 1000, 'remaining completion allowance only');
  assert.match(requests[0].messages[0].content, /Generate 3 to 5 trade-implication cards/);
  assert.match(requests[1].messages[0].content, /Generate 1 or 2 concise trade-implication cards/);
  assert.doesNotMatch(requests[1].messages[0].content, /Generate 3 to 5/);
  assert.equal(store[key].model, 'fixture-model');
  assert.notEqual(store[key].generatedAt, oldTime);
  assert.equal(store[metaKey].consecutiveFailures, 0);
  assert.equal(store[metaKey].lastSynthesisFailureCode, null);
});

test('an exhausted stage budget cannot be reset by recovery even when run time remains', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500,
    beforeReturn: () => {
      const later = realNow() + 90_000;
      Date.now = () => later;
      __setForecastLlmRunDeadlineForTests(later + 200_000);
    } }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 1);
  assert.equal(store[metaKey].consecutiveFailures, 1);
});

test('recovery transport failure does not erase the initial parse failure or retry transport', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500 }, { status: 503 }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 2);
  assert.equal(store[key].generatedAt, oldTime);
  assert.equal(store[metaKey].lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_NO_PARSEABLE_CARDS');
});

test('recovery cards still pass ticker validation before publication', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500 },
    { text: JSON.stringify([{ ...card, ticker: '^INVALID' }]), tokens: 200 }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 2);
  assert.equal(store[key].generatedAt, oldTime);
  assert.equal(store[metaKey].lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_VALIDATION');
});

test('valid initial synthesis makes no recovery request', async () => {
  const { store, requests } = setup([{ text: JSON.stringify([card]), tokens: 1500 }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 1);
  assert.equal(store[key].model, 'fixture-model');
});

test('two malformed responses retain content and success clocks and count one failed synthesis', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500 }, { text: malformed, tokens: 200 }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 2);
  assert.equal(store[key].generatedAt, oldTime);
  assert.equal(store[metaKey].lastSuccessAt, Date.parse(oldTime));
  assert.equal(store[metaKey].consecutiveFailures, 1);
  assert.equal(store[metaKey].lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_NO_PARSEABLE_CARDS');
  assert.ok(!Object.keys(store).some(k => k.startsWith('forecast:llm-market-implications:')));
});

for (const tokens of [undefined, 0, -1, 2000, 2500, 3000]) {
  test(`no recovery without a usable remaining token allowance (${tokens})`, async () => {
    const { store, requests } = setup([{ text: malformed, tokens }]);
    await buildAndSeedMarketImplications({});
    assert.equal(requests.length, 1);
    assert.equal(store[metaKey].consecutiveFailures, 1);
    assert.equal(store[key].generatedAt, oldTime);
  });
}
test('run deadline cannot admit recovery: preserve the real parse failure, not a budget skip', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500,
    beforeReturn: () => __setForecastLlmRunDeadlineForTests(Date.now() + 10_000) }]);
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 1);
  assert.equal(store[metaKey].lastSynthesisFailureCode, 'MARKET_IMPLICATIONS_NO_PARSEABLE_CARDS');
});

test('recovery cannot restart the fallback chain after the original provider fails', async () => {
  const { store, requests } = setup([{ text: malformed, tokens: 1500 }, { status: 503 }]);
  process.env.GROQ_API_KEY = 'fixture-key';
  process.env.FORECAST_LLM_MARKET_IMPLICATIONS_PROVIDER_ORDER = 'openrouter,groq';
  await buildAndSeedMarketImplications({});
  assert.equal(requests.length, 2);
  assert.equal(store[metaKey].consecutiveFailures, 1);
});
