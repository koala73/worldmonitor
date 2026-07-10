import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const view = JSON.parse(readFileSync(join(ROOT, 'public/agent-view.json'), 'utf-8'));
const serverCard = JSON.parse(
  readFileSync(join(ROOT, 'public/.well-known/mcp/server-card.json'), 'utf-8'),
);
const agentCard = JSON.parse(
  readFileSync(join(ROOT, 'public/.well-known/agent-card.json'), 'utf-8'),
);
const vercelConfig = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf-8'));

// Guards for the ?mode=agent machine-readable homepage view (orank Identity
// `agent-mode-view` bonus): the static JSON must stay in parity with the real
// discovery artifacts it summarizes, and the query-gated rewrite must fire
// BEFORE the / → welcome rewrite or the marketing page wins.
describe('agent-mode view (/?mode=agent)', () => {
  it('agent-view.json carries the machine-readable essentials', () => {
    assert.equal(view.kind, 'agent-view');
    for (const key of ['product', 'url', 'description', 'endpoints', 'authentication', 'rateLimits', 'documentation', 'capabilities', 'discovery']) {
      assert.ok(key in view, `agent-view.json missing ${key}`);
    }
    assert.ok(Array.isArray(view.capabilities) && view.capabilities.length >= 5);
    assert.ok(view.authentication.apiKey.header === 'X-WorldMonitor-Key');
    assert.ok(view.authentication.oauth2.scope === 'mcp');
    assert.match(view.authentication.summary, /Authentication/);
  });

  it('stays in parity with the MCP server card and A2A agent card', () => {
    assert.equal(view.endpoints.mcp.url, serverCard.url);
    assert.equal(view.endpoints.mcp.tools, serverCard.tools.length);
    assert.equal(view.endpoints.a2a.url, agentCard.url);
    assert.equal(view.endpoints.nlweb.url, 'https://www.worldmonitor.app/ask');
  });

  it('vercel.json serves it for /?mode=agent ahead of the welcome rewrite', () => {
    const rewrites = vercelConfig.rewrites;
    const agentIdx = rewrites.findIndex(
      (r) =>
        r.source === '/' &&
        Array.isArray(r.has) &&
        r.has.some((h) => h.type === 'query' && h.key === 'mode' && h.value === 'agent') &&
        r.destination === '/agent-view.json',
    );
    const welcomeIdx = rewrites.findIndex(
      (r) => r.source === '/' && r.destination === '/pro/welcome.html',
    );
    assert.ok(agentIdx >= 0, 'missing /?mode=agent rewrite to /agent-view.json');
    assert.ok(welcomeIdx >= 0, 'welcome rewrite missing');
    assert.ok(agentIdx < welcomeIdx, '?mode=agent rewrite must precede the welcome rewrite (first match wins)');
  });

  it('every discovery URL it advertises resolves to a tracked file or a live rewrite', () => {
    // Static, repo-tracked surfaces — a typo here ships a dead link to agents.
    const trackedPaths = {
      'https://worldmonitor.app/.well-known/agent-skills/index.json':
        'public/.well-known/agent-skills/index.json',
      'https://worldmonitor.app/.well-known/api-catalog': 'public/.well-known/api-catalog',
      'https://worldmonitor.app/.well-known/ai-catalog.json': 'public/.well-known/ai-catalog.json',
      'https://worldmonitor.app/llms.txt': 'public/llms.txt',
    };
    for (const [url, path] of Object.entries(trackedPaths)) {
      assert.equal(
        Object.values(view.discovery).includes(url),
        true,
        `discovery must advertise ${url}`,
      );
      assert.doesNotThrow(() => readFileSync(join(ROOT, path)), `${path} must exist for ${url}`);
    }
    // /index.md is rewrite-served (public/home.md) since #4830.
    const mdRewrite = vercelConfig.rewrites.find((r) => r.source === '/index.md');
    assert.ok(mdRewrite, 'markdownHomepage advertised but /index.md rewrite is gone');
  });
});
