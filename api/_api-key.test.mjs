import { strict as assert } from 'node:assert';
import test from 'node:test';
import { validateApiKey } from './_api-key.js';

function makeRequest(headersInit = {}) {
  return new Request('https://worldmonitor.app/api/test', {
    headers: new Headers(headersInit),
  });
}

test('rejects trusted referer without browser fetch metadata', () => {
  const result = validateApiKey(makeRequest({
    Referer: 'https://worldmonitor.app/dashboard',
  }));

  assert.equal(result.valid, false);
  assert.equal(result.required, true);
  assert.match(result.error || '', /API key required/);
});

test('rejects missing Origin even when referer and browser fetch metadata are present', () => {
  const result = validateApiKey(makeRequest({
    Referer: 'https://worldmonitor.app/dashboard',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
  }));

  assert.equal(result.valid, false);
  assert.equal(result.required, true);
  assert.match(result.error || '', /API key required/);
});

test('allows trusted browser origin when fetch metadata is present', () => {
  const result = validateApiKey(makeRequest({
    Origin: 'https://worldmonitor.app',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
  }));

  assert.equal(result.valid, true);
  assert.equal(result.required, false);
});
