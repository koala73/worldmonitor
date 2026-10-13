import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createGenericWidgetClient, getWidgetModelStatus } from '../scripts/lib/widget-llm-client.cjs';
import { getWidgetDataConfig } from '../scripts/lib/widget-data-config.cjs';
import { buildWidgetDataUrl } from '../scripts/_widget-data-policy.cjs';
import { buildGenericLlmProvider, isGenericLlmSelected } from '../scripts/shared/generic-llm-provider.mjs';

const env = {
  LLM_PROVIDER: 'generic', LLM_API_URL: 'http://127.0.0.1:4043/openai/v1/chat/completions',
  LLM_MODEL: 'local/widget-model', LLM_API_KEY: 'test-virtual-key', LLM_API_AUTH_TYPE: 'x-bf-vk',
  ANTHROPIC_API_KEY: 'must-not-use-cloud-key', OPENROUTER_API_KEY: 'must-not-use-cloud-key',
  API_BASE_URL: 'http://127.0.0.1:4100', LOCAL_API_MODE: 'docker', WORLDMONITOR_API_KEY: 'own-operator-key',
};
const request = { system: 'Show data', messages: [{ role: 'user', content: 'Show quakes' }], max_tokens: 500 };

test('generic 401 never retries another provider or reveals credentials', async () => {
  const calls = [];
  const client = createGenericWidgetClient({ env, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response('must-not-expose-provider-body', { status: 401 });
  } });
  await assert.rejects(client.messages.create(request), error => {
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /test-virtual-key|must-not/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, env.LLM_API_URL);
  assert.equal(calls[0].init.redirect, 'error');
});

test('pre-aborted widget calls send no model request', async () => {
  const client = createGenericWidgetClient({ env, fetchImpl: () => assert.fail('Request after abort') });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(client.messages.create(request, { signal: abort.signal }), { name: 'AbortError' });
});

test('local health requires complete generic settings even with an Anthropic credential', () => {
  assert.equal(getWidgetModelStatus(env).modelConfigured, true);
  assert.equal(getWidgetModelStatus(env).provider, 'generic');
  assert.equal(getWidgetModelStatus({ ...env, LLM_API_KEY: '' }).modelConfigured, false);
  assert.equal(getWidgetModelStatus({ ...env, LLM_API_AUTH_TYPE: 'typo' }).modelConfigured, false);
  assert.equal(getWidgetModelStatus({ ANTHROPIC_API_KEY: 'hosted-test-key' }).provider, 'anthropic');
});

test('local data is bound to the configured installation origin and catalog', () => {
  const config = getWidgetDataConfig(env);
  assert.equal(config.operatorKey, 'own-operator-key');
  const url = buildWidgetDataUrl('/api/bootstrap', { keys: 'earthquakes' }, config.origin);
  assert.equal(url.origin, env.API_BASE_URL);
  for (const endpoint of ['https://elsewhere.test/api/bootstrap', '//elsewhere.test/api/bootstrap', '/api/../admin', '/api/auth/login']) {
    assert.equal(buildWidgetDataUrl(endpoint, {}, config.origin), null);
  }
  assert.equal(getWidgetDataConfig({ ...env, LOCAL_API_MODE: '' }).operatorKey, '');
  assert.equal(getWidgetDataConfig({ ...env, LOCAL_API_MODE: 'tauri-sidecar' }).operatorKey, 'own-operator-key');
  assert.throws(() => getWidgetDataConfig({ ...env, API_BASE_URL: '' }), /API_BASE_URL/);
  assert.throws(() => getWidgetDataConfig({ ...env, API_BASE_URL: 'https://api.worldmonitor.app' }), /own API_BASE_URL/);
  assert.throws(() => getWidgetDataConfig({ ...env, API_BASE_URL: 'https://user:pass@local.test' }), /origin/);
  assert.equal(getWidgetDataConfig({ WORLDMONITOR_API_KEY: 'own-key', LOCAL_API_MODE: 'docker' }).operatorKey, '');
});

test('local data session returns the own-install operator key without minting a hosted session', async () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const start = relay.indexOf('let widgetDataSession = null;');
  const end = relay.indexOf('\n}\n', relay.indexOf('function invalidateWidgetDataSession(')) + 3;
  const context = vm.createContext({
    getWidgetDataConfig: () => getWidgetDataConfig(env),
    fetch: () => assert.fail('Operator credentials must not mint a hosted session'),
  });
  vm.runInContext(relay.slice(start, end), context);
  assert.equal(await context.getWidgetDataSessionToken(), 'own-operator-key');
});

test('ordinary relay classification selects only generic and keeps failures local', async () => {
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const extract = name => relay.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0];
  const calls = [];
  const context = vm.createContext({
    process: { env }, console: { warn() {} },
    buildGenericLlmProvider: () => buildGenericLlmProvider(env),
    isGenericLlmSelected: () => isGenericLlmSelected(env),
    CLASSIFY_LLM_PROVIDERS: [{ name: 'openrouter', envKey: 'OPENROUTER_API_KEY' }],
    classifyFetchLlmSingle: async (...args) => { calls.push(args); return null; },
  });
  vm.runInContext(`${extract('getClassifyLlmProviders')}\n${extract('classifyFetchLlm')}`, context);
  assert.equal(await context.classifyFetchLlm(['Headline']), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], env.LLM_API_URL);
  assert.equal(calls[0][4]['x-bf-vk'], env.LLM_API_KEY);
  assert.equal(calls[0][4].Authorization, undefined);
});
