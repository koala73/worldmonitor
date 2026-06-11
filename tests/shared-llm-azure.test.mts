import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getProviderCredentials } from '../server/_shared/llm.ts';
import { __resetAzureTokenCacheForTests } from '../server/_shared/llm-azure-auth.ts';

const originalLlmApiUrl = process.env.LLM_API_URL;
const originalLlmApiKey = process.env.LLM_API_KEY;
const originalLlmModel = process.env.LLM_MODEL;
const originalTenant = process.env.AZURE_OPENAI_TENANT_ID;
const originalClientId = process.env.AZURE_OPENAI_CLIENT_ID;
const originalClientSecret = process.env.AZURE_OPENAI_CLIENT_SECRET;
const originalMaxTokensParam = process.env.LLM_MAX_TOKENS_PARAM;
const originalFetch = globalThis.fetch;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restoreEnv('LLM_API_URL', originalLlmApiUrl);
  restoreEnv('LLM_API_KEY', originalLlmApiKey);
  restoreEnv('LLM_MODEL', originalLlmModel);
  restoreEnv('AZURE_OPENAI_TENANT_ID', originalTenant);
  restoreEnv('AZURE_OPENAI_CLIENT_ID', originalClientId);
  restoreEnv('AZURE_OPENAI_CLIENT_SECRET', originalClientSecret);
  restoreEnv('LLM_MAX_TOKENS_PARAM', originalMaxTokensParam);
  globalThis.fetch = originalFetch;
  __resetAzureTokenCacheForTests();
});

describe('getProviderCredentials (generic / Azure OpenAI)', () => {
  it('uses the api-key header for an Azure OpenAI endpoint', () => {
    process.env.LLM_API_URL =
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21';
    process.env.LLM_API_KEY = 'azure-secret-key';
    process.env.LLM_MODEL = 'gpt-4o';
    delete process.env.AZURE_OPENAI_TENANT_ID;
    delete process.env.AZURE_OPENAI_CLIENT_ID;
    delete process.env.AZURE_OPENAI_CLIENT_SECRET;

    const creds = getProviderCredentials('generic');

    assert.ok(creds);
    assert.equal(creds.headers['api-key'], 'azure-secret-key');
    assert.equal(creds.headers.Authorization, undefined);
    assert.equal(creds.authHeaderProvider, undefined);
    assert.equal(creds.model, 'gpt-4o');
    assert.equal(creds.apiUrl, process.env.LLM_API_URL);
  });

  it('keeps Authorization: Bearer for a non-Azure OpenAI-compatible endpoint', () => {
    process.env.LLM_API_URL = 'https://llm.example.com/v1/chat/completions';
    process.env.LLM_API_KEY = 'generic-secret-key';
    process.env.LLM_MODEL = 'some-model';

    const creds = getProviderCredentials('generic');

    assert.ok(creds);
    assert.equal(creds.headers.Authorization, 'Bearer generic-secret-key');
    assert.equal(creds.headers['api-key'], undefined);
  });
});

describe('getProviderCredentials (generic / Azure OpenAI Entra ID)', () => {
  it('uses an Entra ID bearer token when service-principal env vars are set', async () => {
    process.env.LLM_API_URL =
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21';
    delete process.env.LLM_API_KEY; // key-based auth disabled on the resource
    process.env.LLM_MODEL = 'gpt-4o';
    process.env.AZURE_OPENAI_TENANT_ID = 'tenant-123';
    process.env.AZURE_OPENAI_CLIENT_ID = 'client-abc';
    process.env.AZURE_OPENAI_CLIENT_SECRET = 'super-secret';

    let tokenRequests = 0;
    let capturedBody = '';
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      tokenRequests += 1;
      assert.match(String(url), /login\.microsoftonline\.com\/tenant-123\/oauth2\/v2\.0\/token/);
      capturedBody = String(init?.body ?? '');
      return new Response(JSON.stringify({ access_token: 'aad-token-xyz', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const creds = getProviderCredentials('generic');
    assert.ok(creds);
    // No static API-key headers — auth is resolved dynamically.
    assert.equal(creds.headers['api-key'], undefined);
    assert.equal(creds.headers.Authorization, undefined);
    assert.ok(creds.authHeaderProvider, 'expected an async authHeaderProvider');

    const auth = await creds.authHeaderProvider!();
    assert.equal(auth.Authorization, 'Bearer aad-token-xyz');
    assert.equal(tokenRequests, 1);
    assert.match(capturedBody, /grant_type=client_credentials/);
    assert.match(capturedBody, /scope=https%3A%2F%2Fcognitiveservices\.azure\.com%2F\.default/);

    // Second resolution within the token lifetime is served from cache.
    const auth2 = await creds.authHeaderProvider!();
    assert.equal(auth2.Authorization, 'Bearer aad-token-xyz');
    assert.equal(tokenRequests, 1, 'token must be cached, not re-fetched');
  });

  it('ignores Entra env vars for a non-Azure endpoint (no token flow)', () => {
    process.env.LLM_API_URL = 'https://llm.example.com/v1/chat/completions';
    process.env.LLM_API_KEY = 'generic-secret-key';
    process.env.AZURE_OPENAI_TENANT_ID = 'tenant-123';
    process.env.AZURE_OPENAI_CLIENT_ID = 'client-abc';
    process.env.AZURE_OPENAI_CLIENT_SECRET = 'super-secret';

    const creds = getProviderCredentials('generic');
    assert.ok(creds);
    assert.equal(creds.authHeaderProvider, undefined);
    assert.equal(creds.headers.Authorization, 'Bearer generic-secret-key');
  });
});

describe('getProviderCredentials (max-tokens param selection)', () => {
  it('uses max_completion_tokens for an Azure OpenAI endpoint', () => {
    process.env.LLM_API_URL = 'https://aoai-x.openai.azure.com/openai/v1/chat/completions';
    delete process.env.LLM_API_KEY;
    process.env.LLM_MODEL = 'gpt-5.4';
    process.env.AZURE_OPENAI_TENANT_ID = 'tenant-123';
    process.env.AZURE_OPENAI_CLIENT_ID = 'client-abc';
    process.env.AZURE_OPENAI_CLIENT_SECRET = 'super-secret';

    const creds = getProviderCredentials('generic');
    assert.ok(creds);
    assert.equal(creds.maxTokensParam, 'max_completion_tokens');
  });

  it('keeps max_tokens for a non-Azure OpenAI-compatible endpoint', () => {
    process.env.LLM_API_URL = 'https://llm.example.com/v1/chat/completions';
    process.env.LLM_API_KEY = 'generic-secret-key';
    delete process.env.LLM_MAX_TOKENS_PARAM;

    const creds = getProviderCredentials('generic');
    assert.ok(creds);
    assert.equal(creds.maxTokensParam, 'max_tokens');
  });

  it('honours the LLM_MAX_TOKENS_PARAM override on an Azure endpoint', () => {
    process.env.LLM_API_URL = 'https://aoai-x.openai.azure.com/openai/v1/chat/completions';
    process.env.LLM_API_KEY = 'azure-secret-key';
    delete process.env.AZURE_OPENAI_TENANT_ID;
    delete process.env.AZURE_OPENAI_CLIENT_ID;
    delete process.env.AZURE_OPENAI_CLIENT_SECRET;
    process.env.LLM_MAX_TOKENS_PARAM = 'max_tokens';

    const creds = getProviderCredentials('generic');
    assert.ok(creds);
    assert.equal(creds.maxTokensParam, 'max_tokens');
  });
});
