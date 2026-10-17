// Which AI client a sign-up, API key or MCP connection came from
// (shared/agent-client-source.js), and the guard that keeps agent links out of
// affiliate attribution.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_CLIENT_SOURCES,
  AGENT_REF_STORAGE_KEY,
  AGENT_REF_TTL_MS,
  agentSourceFromRef,
  captureAgentRefFromSearch,
  classifyAgentClient,
  classifyAgentClientHints,
  loadAgentRef,
  normalizeAgentRef,
  sanitizeClientName,
} from '../shared/agent-client-source.js';
import { isInternalSourceTag } from '../shared/referral-namespaces.ts';
import { mcpTokenClientSource } from '../convex/mcpProTokens.ts';
import { apiKeySourceFields } from '../convex/apiKeys.ts';
import { signupSourceFields } from '../convex/users.ts';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

describe('classifyAgentClient', () => {
  it('maps the client names real MCP and OAuth clients send', () => {
    const cases = [
      ['claude-ai', 'claude'],
      ['Claude Desktop', 'claude'],
      ['claude-code', 'claude'],
      ['Anthropic/ClaudeBot', 'claude'],
      ['ChatGPT', 'chatgpt'],
      ['openai-mcp', 'chatgpt'],
      ['cursor-vscode', 'cursor'],
      ['Cursor/2.4 (darwin arm64)', 'cursor'],
      ['gemini-cli-mcp-client', 'gemini'],
      ['Grok', 'grok-bot'],
      ['grok-bot', 'grok-bot'],
      ['mcp-remote', 'other'],
      ['node', 'other'],
    ];
    for (const [hint, expected] of cases) assert.equal(classifyAgentClient(hint), expected, hint);
  });

  it('returns null for no signal, so absence is never counted as other', () => {
    for (const hint of [undefined, null, '', '   ', 42, {}]) assert.equal(classifyAgentClient(hint), null);
  });

  it('only ever returns a declared bucket', () => {
    for (const hint of ['claude', 'x', 'Gemini', 'GROK', 'unknown-client']) {
      assert.ok(AGENT_CLIENT_SOURCES.includes(classifyAgentClient(hint)));
    }
  });

  it('prefers a branded hint over a generic one, in either order', () => {
    assert.equal(classifyAgentClientHints(['mcp-remote', 'Cursor/2.4']), 'cursor');
    assert.equal(classifyAgentClientHints(['claude-ai', 'node']), 'claude');
    assert.equal(classifyAgentClientHints(['node', '']), 'other');
    assert.equal(classifyAgentClientHints([null, '']), null);
  });
});

describe('agent refs', () => {
  it('accepts only the agent namespace, bounded and lowercased', () => {
    assert.equal(normalizeAgentRef('agent-claude'), 'agent-claude');
    assert.equal(normalizeAgentRef(' Agent-ChatGPT '), 'agent-chatgpt');
    assert.equal(normalizeAgentRef('agent'), 'agent');
    assert.equal(normalizeAgentRef('agent-grok-bot'), 'agent-grok-bot');
    for (const bad of ['claude', 'welcome-hero', 'AFF123', 'agent-', 'agent_claude', 'agent-a-b-c', `agent-${'x'.repeat(30)}`, '<script>', null]) {
      assert.equal(normalizeAgentRef(bad), null, String(bad));
    }
  });

  it('maps a ref to its bucket', () => {
    assert.equal(agentSourceFromRef('agent-claude'), 'claude');
    assert.equal(agentSourceFromRef('agent-chatgpt'), 'chatgpt');
    assert.equal(agentSourceFromRef('agent-cursor'), 'cursor');
    assert.equal(agentSourceFromRef('agent-gemini'), 'gemini');
    assert.equal(agentSourceFromRef('agent-grok-bot'), 'grok-bot');
    assert.equal(agentSourceFromRef('agent-skills'), 'other');
    assert.equal(agentSourceFromRef('agent'), 'other');
    assert.equal(agentSourceFromRef('AFF123'), null);
  });

  it('is reserved, so an agent link never becomes an affiliate code at checkout', () => {
    assert.equal(isInternalSourceTag('agent-claude'), true);
    assert.equal(isInternalSourceTag('agent'), true);
    assert.equal(isInternalSourceTag('AFF123'), false);
  });
});

describe('first-touch capture', () => {
  const NOW = 1_800_000_000_000;

  it('stores an agent ref and ignores everything else', () => {
    const storage = memoryStorage();
    assert.equal(captureAgentRefFromSearch('?ref=AFF123', storage, NOW), null);
    assert.equal(storage.data.size, 0);
    assert.equal(captureAgentRefFromSearch('?ref=AFF123&ref=agent-cursor', storage, NOW), 'agent-cursor');
    assert.deepEqual(JSON.parse(storage.getItem(AGENT_REF_STORAGE_KEY)), { ref: 'agent-cursor', capturedAt: NOW });
  });

  it('never overwrites an unexpired earlier ref', () => {
    const storage = memoryStorage();
    captureAgentRefFromSearch('ref=agent-claude', storage, NOW);
    assert.equal(captureAgentRefFromSearch('?ref=agent-chatgpt', storage, NOW + 1000), 'agent-claude');
    assert.equal(loadAgentRef(storage, NOW + 2000), 'agent-claude');
  });

  it('expires after the TTL and then accepts a new ref', () => {
    const storage = memoryStorage();
    captureAgentRefFromSearch('?ref=agent-claude', storage, NOW);
    const later = NOW + AGENT_REF_TTL_MS + 1;
    assert.equal(loadAgentRef(storage, later), null);
    assert.equal(storage.getItem(AGENT_REF_STORAGE_KEY), null);
    assert.equal(captureAgentRefFromSearch('?ref=agent-gemini', storage, later), 'agent-gemini');
  });

  it('clears malformed, tampered or future-dated entries', () => {
    for (const raw of ['not json', '{"ref":"AFF123","capturedAt":1}', JSON.stringify({ ref: 'agent-claude' }), JSON.stringify({ ref: 'agent-claude', capturedAt: NOW + 3_600_000 })]) {
      const storage = memoryStorage({ [AGENT_REF_STORAGE_KEY]: raw });
      assert.equal(loadAgentRef(storage, NOW), null, raw);
      assert.equal(storage.getItem(AGENT_REF_STORAGE_KEY), null, raw);
    }
  });

  it('degrades to no attribution when storage throws', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', throwing, NOW), null);
    assert.equal(loadAgentRef(throwing, NOW), null);
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', null, NOW), null);
  });
});

describe('stored fields', () => {
  it('sanitizes client names for logs', () => {
    assert.equal(sanitizeClientName('claude-ai\u0000\n'), 'claude-ai');
    assert.equal(sanitizeClientName('x'.repeat(500)).length, 64);
    assert.equal(sanitizeClientName('\u202e\u0007'), null);
    assert.equal(sanitizeClientName(undefined), null);
  });

  it('derives the users and userApiKeys fields from a ref, dropping invalid refs', () => {
    assert.deepEqual(signupSourceFields('agent-claude'), { signupRef: 'agent-claude', signupSource: 'claude' });
    assert.deepEqual(signupSourceFields('AFF123'), {});
    assert.deepEqual(signupSourceFields(undefined), {});
    assert.deepEqual(apiKeySourceFields('agent-cursor'), { sourceRef: 'agent-cursor', source: 'cursor' });
    assert.deepEqual(apiKeySourceFields('nope'), {});
  });

  it('classifies the OAuth grant name an MCP token is issued with', () => {
    assert.equal(mcpTokenClientSource('Connected via Claude'), 'claude');
    assert.equal(mcpTokenClientSource('Connected via ChatGPT'), 'chatgpt');
    assert.equal(mcpTokenClientSource('Connected via Cursor'), 'cursor');
    assert.equal(mcpTokenClientSource('Connected via my-tool'), 'other');
    assert.equal(mcpTokenClientSource('Connected via '), null);
    assert.equal(mcpTokenClientSource(undefined), null);
  });
});
