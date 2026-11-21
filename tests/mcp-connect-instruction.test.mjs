/**
 * The anonymous 401 tells each client the sign-in step it actually needs.
 *
 * Production, 2026-10-11 to 2026-11-10: 1,763 Codex IPs only ever got the
 * anonymous `initialize` 401, against 324 that ever got a 200. Codex does not
 * open a sign-in window from the challenge; the user has to run
 * `codex mcp login worldmonitor`. Claude Code shows the server as needing auth
 * until the user runs `/mcp` and chooses Authenticate. The refusal keeps its
 * status, `error.code`, `data.reason` and `WWW-Authenticate` challenge, and
 * adds the client-specific `nextStep` plus a `setupUrl`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { informOnlyNextStep } from '../api/mcp/upgrade.ts';

const URL_MCP = 'https://worldmonitor.app/mcp';
const CHALLENGE = 'Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource/mcp"';
const SETUP_URL = 'https://www.worldmonitor.app/docs/mcp-quickstart';
const INIT = {
  jsonrpc: '2.0',
  id: 7,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
};

async function request(init) {
  const { mcpHandler } = await import('../api/mcp/handler.ts');
  return mcpHandler(new Request(URL_MCP, {
    ...init,
    headers: { host: 'worldmonitor.app', ...(init.headers ?? {}) },
  }), undefined, { skip: false });
}

async function anonymousInitialize(userAgent) {
  const res = await request({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'User-Agent': userAgent },
    body: JSON.stringify(INIT),
  });
  return { res, body: await res.json() };
}

function assertUnchangedChallenge(res, body) {
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), CHALLENGE);
  assert.equal(body.error.code, -32001);
  assert.equal(body.error.data?.reason, 'no-account');
}

describe('the anonymous refusal names each client\'s sign-in step', () => {
  it('codex-mcp-client gets the codex login command', async () => {
    const { res, body } = await anonymousInitialize('codex-mcp-client/0.166.0');
    assertUnchangedChallenge(res, body);
    assert.match(body.error.data.nextStep, /codex mcp login worldmonitor/);
    assert.equal(body.error.data.setupUrl, SETUP_URL);
  });

  it('openai-mcp (Codex) gets the codex login command', async () => {
    const { res, body } = await anonymousInitialize('openai-mcp/1.0.0 (Codex)');
    assertUnchangedChallenge(res, body);
    assert.match(body.error.data.nextStep, /codex mcp login worldmonitor/);
    assert.equal(body.error.data.setupUrl, SETUP_URL);
  });

  it('Claude Code gets the /mcp Authenticate step', async () => {
    const { res, body } = await anonymousInitialize('claude-code/2.1.318 (sdk-cli)');
    assertUnchangedChallenge(res, body);
    assert.match(body.error.data.nextStep, /run \/mcp, select worldmonitor and choose Authenticate/);
    assert.doesNotMatch(body.error.data.nextStep, /codex/i);
    assert.equal(body.error.data.setupUrl, SETUP_URL);
  });

  it('ChatGPT keeps its inform-only copy and gets no Codex text', async () => {
    const { res, body } = await anonymousInitialize('openai-mcp/1.0.0');
    assertUnchangedChallenge(res, body);
    assert.equal(body.error.data.nextStep, informOnlyNextStep({ reason: 'no-account' }));
    assert.doesNotMatch(JSON.stringify(body), /codex/i);
    assert.equal(body.error.data.checkoutTool, undefined);
  });

  it('the anonymous GET discovery probe returns the same structured denial', async () => {
    const res = await request({
      method: 'GET',
      headers: { 'MCP-Protocol-Version': '2024-11-05', 'User-Agent': 'codex-mcp-client/0.166.0' },
    });
    const body = await res.json();
    assertUnchangedChallenge(res, body);
    assert.equal(body.id, null);
    assert.match(body.error.data.nextStep, /codex mcp login worldmonitor/);
    assert.equal(body.error.data.setupUrl, SETUP_URL);
  });
});
