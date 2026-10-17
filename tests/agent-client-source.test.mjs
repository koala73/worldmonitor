// Which AI client a sign-up, API key or MCP connection came from
// (shared/agent-client-source.js), and the guard that keeps agent links out of
// affiliate attribution.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGENT_CLIENT_SOURCES,
  AGENT_REF_STORAGE_KEY,
  AGENT_REF_TTL_MS,
  UNKNOWN_CLIENT_NAME,
  agentRefColumns,
  agentRefCookieStorage,
  agentSourceFromRef,
  captureAgentRefFromSearch,
  clearAgentRef,
  classifyAgentClient,
  classifyAgentClientHints,
  loadAgentRef,
  mcpGrantClientSource,
  mcpGrantName,
  normalizeAgentRef,
  sanitizeClientName,
} from '../shared/agent-client-source.js';
import { isInternalSourceTag } from '../shared/referral-namespaces.ts';
import { signupSourceFields } from '../convex/users.ts';

/** A document.cookie stand-in that keeps name=value pairs and honours max-age=0. */
function fakeCookieJar() {
  const jar = new Map();
  const writes = [];
  return {
    jar,
    writes,
    get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
    set cookie(line) {
      writes.push(line);
      const [pair, ...attrs] = line.split(';').map((part) => part.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      if (attrs.includes('max-age=0')) jar.delete(name); else jar.set(name, pair.slice(eq + 1));
    },
  };
}

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

  it('reports no capture when a write is silently dropped', () => {
    const dropping = { getItem: () => null, setItem() {}, removeItem() {} };
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', dropping, NOW), null);
  });

  it('clears the ref once it has been used', () => {
    const storage = memoryStorage();
    captureAgentRefFromSearch('?ref=agent-claude', storage, NOW);
    clearAgentRef(storage);
    assert.equal(loadAgentRef(storage, NOW), null);
    assert.equal(captureAgentRefFromSearch('?ref=agent-cursor', storage, NOW), 'agent-cursor');
    clearAgentRef(null);
  });

  it('degrades to no attribution when storage throws', () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', throwing, NOW), null);
    assert.equal(loadAgentRef(throwing, NOW), null);
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', null, NOW), null);
  });
});

describe('cookie storage', () => {
  const NOW = 1_800_000_000_000;

  it('shares the ref across worldmonitor.app hosts', () => {
    const doc = fakeCookieJar();
    const www = agentRefCookieStorage(doc, { hostname: 'www.worldmonitor.app', protocol: 'https:' });
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', www, NOW), 'agent-claude');
    assert.match(doc.writes[0], /^wm-agent-ref=[^;]+; max-age=2592000; path=\/; domain=\.worldmonitor\.app; SameSite=Lax; Secure$/);
    const tech = agentRefCookieStorage(doc, { hostname: 'tech.worldmonitor.app', protocol: 'https:' });
    assert.equal(loadAgentRef(tech, NOW + 1000), 'agent-claude');
    clearAgentRef(tech);
    assert.equal(loadAgentRef(www, NOW + 2000), null);
    assert.match(doc.writes.at(-1), /max-age=0; path=\/; domain=\.worldmonitor\.app/);
  });

  it('is host-only off worldmonitor.app and only handles its own key', () => {
    const doc = fakeCookieJar();
    const local = agentRefCookieStorage(doc, { hostname: 'localhost', protocol: 'http:' });
    local.setItem(AGENT_REF_STORAGE_KEY, 'x');
    assert.doesNotMatch(doc.writes[0], /domain=|Secure/);
    local.setItem('other-key', 'y');
    assert.equal(doc.writes.length, 1);
    assert.equal(local.getItem('other-key'), null);
    const lookalike = agentRefCookieStorage(fakeCookieJar(), { hostname: 'evilworldmonitor.app', protocol: 'https:' });
    assert.equal(lookalike.getItem(AGENT_REF_STORAGE_KEY), null);
  });

  it('degrades to no attribution when cookies throw', () => {
    const blocked = { get cookie() { throw new Error('blocked'); }, set cookie(_) { throw new Error('blocked'); } };
    const storage = agentRefCookieStorage(blocked, { hostname: 'www.worldmonitor.app', protocol: 'https:' });
    assert.equal(captureAgentRefFromSearch('?ref=agent-claude', storage, NOW), null);
    assert.equal(loadAgentRef(storage, NOW), null);
  });
});

describe('stored fields', () => {
  it('sanitizes client names for logs', () => {
    assert.equal(sanitizeClientName('claude-ai\u0000\n'), 'claude-ai');
    assert.equal(sanitizeClientName('x'.repeat(500)).length, 64);
    assert.equal(sanitizeClientName('\u202e\u0007'), null);
    assert.equal(sanitizeClientName(undefined), null);
  });

  it('derives the users fields from a ref, dropping invalid refs', () => {
    assert.deepEqual(agentRefColumns(' Agent-Cursor '), { ref: 'agent-cursor', source: 'cursor' });
    assert.equal(agentRefColumns('AFF123'), null);
    assert.deepEqual(signupSourceFields('agent-claude'), { signupRef: 'agent-claude', signupSource: 'claude' });
    assert.deepEqual(signupSourceFields('agent'), { signupRef: 'agent', signupSource: 'other' });
    assert.deepEqual(signupSourceFields('AFF123'), {});
    assert.deepEqual(signupSourceFields(undefined), {});
  });

  it('classifies the OAuth grant name an MCP token is issued with', () => {
    assert.equal(mcpGrantName('Claude'), 'Connected via Claude');
    assert.equal(mcpGrantClientSource(mcpGrantName('Claude')), 'claude');
    assert.equal(mcpGrantClientSource(mcpGrantName('ChatGPT')), 'chatgpt');
    assert.equal(mcpGrantClientSource(mcpGrantName('Cursor')), 'cursor');
    assert.equal(mcpGrantClientSource(mcpGrantName('my-tool')), 'other');
    assert.equal(mcpGrantClientSource('Connected via '), null);
    assert.equal(mcpGrantClientSource(undefined), null);
  });

  it('counts a grant with no client name as no signal, not other', () => {
    assert.equal(mcpGrantName(undefined), `Connected via ${UNKNOWN_CLIENT_NAME}`);
    assert.equal(mcpGrantName('  '), `Connected via ${UNKNOWN_CLIENT_NAME}`);
    assert.equal(mcpGrantClientSource(mcpGrantName(undefined)), null);
    assert.equal(classifyAgentClient('unknown client'), null);
  });

  it('matches the placeholder the legacy OAuth register endpoint stores', async () => {
    const { readFile } = await import('node:fs/promises');
    const register = await readFile(new URL('../api/oauth/register.js', import.meta.url), 'utf8');
    assert.ok(register.includes(`: '${UNKNOWN_CLIENT_NAME}'`), 'api/oauth/register.js placeholder must equal UNKNOWN_CLIENT_NAME');
  });
});
