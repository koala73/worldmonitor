import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { getProviderCredentials } from '../server/_shared/llm.ts';

const originalLlmApiUrl = process.env.LLM_API_URL;
const originalLlmApiKey = process.env.LLM_API_KEY;
const originalLlmModel = process.env.LLM_MODEL;

afterEach(() => {
  if (originalLlmApiUrl === undefined) delete process.env.LLM_API_URL;
  else process.env.LLM_API_URL = originalLlmApiUrl;

  if (originalLlmApiKey === undefined) delete process.env.LLM_API_KEY;
  else process.env.LLM_API_KEY = originalLlmApiKey;

  if (originalLlmModel === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = originalLlmModel;
});

describe('getProviderCredentials (generic / Azure OpenAI)', () => {
  it('uses the api-key header for an Azure OpenAI endpoint', () => {
    process.env.LLM_API_URL =
      'https://my-resource.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21';
    process.env.LLM_API_KEY = 'azure-secret-key';
    process.env.LLM_MODEL = 'gpt-4o';

    const creds = getProviderCredentials('generic');

    assert.ok(creds);
    assert.equal(creds.headers['api-key'], 'azure-secret-key');
    assert.equal(creds.headers.Authorization, undefined);
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
