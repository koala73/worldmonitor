import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getCorsHeaders, getPublicCorsHeaders, isDisallowedOrigin } from './_cors.js';

function makeRequest(origin) {
  const headers = new Headers();
  if (origin !== null) {
    headers.set('origin', origin);
  }
  return new Request('https://worldmonitor.app/api/test', { headers });
}

test('allows desktop Tauri origins', () => {
  const origins = [
    'https://tauri.localhost',
    'https://abc123.tauri.localhost',
    'tauri://localhost',
    'asset://localhost',
    'http://127.0.0.1:46123',
  ];

  for (const origin of origins) {
    const req = makeRequest(origin);
    assert.equal(isDisallowedOrigin(req), false, `origin should be allowed: ${origin}`);
    const cors = getCorsHeaders(req);
    assert.equal(cors['Access-Control-Allow-Origin'], origin);
    assert.equal(cors['Access-Control-Allow-Credentials'], 'true');
  }
});

test('rejects unrelated external origins', () => {
  const req = makeRequest('https://evil.example.com');
  assert.equal(isDisallowedOrigin(req), true);
  const cors = getCorsHeaders(req);
  assert.equal(cors['Access-Control-Allow-Origin'], 'https://worldmonitor.app');
  assert.equal(cors['Access-Control-Allow-Credentials'], 'true');
});

test('requests without origin remain allowed', () => {
  const req = makeRequest(null);
  assert.equal(isDisallowedOrigin(req), false);
});

test('CORS allow headers include MCP transport headers', () => {
  const privateCors = getCorsHeaders(makeRequest('https://worldmonitor.app'));
  const publicCors = getPublicCorsHeaders('POST, GET, OPTIONS');

  for (const cors of [privateCors, publicCors]) {
    const allowed = cors['Access-Control-Allow-Headers'];
    assert.match(allowed, /\bMcp-Session-Id\b/);
    assert.match(allowed, /\bMCP-Protocol-Version\b/);
    assert.match(allowed, /\bLast-Event-ID\b/);

    const exposed = cors['Access-Control-Expose-Headers'];
    assert.match(exposed, /\bMcp-Session-Id\b/);
    assert.match(exposed, /\bWWW-Authenticate\b/);
    assert.match(exposed, /\bRetry-After\b/);
  }
});
