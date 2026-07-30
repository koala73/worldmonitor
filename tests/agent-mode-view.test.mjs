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

  it('advertises the sandbox, quickstart, and docs MCP endpoints', () => {
    assert.equal(view.endpoints.sandbox.url, 'https://www.worldmonitor.app/sandbox/index.json');
    assert.doesNotThrow(
      () => readFileSync(join(ROOT, 'public/sandbox/index.json')),
      'sandbox index advertised but public/sandbox/index.json is missing',
    );
    assert.equal(view.endpoints.docsMcp.url, 'https://www.worldmonitor.app/docs/mcp');
    assert.ok(view.quickstart && typeof view.quickstart === 'object');
    for (const key of ['sandbox', 'rest', 'mcp']) {
      assert.match(view.quickstart[key], /^curl /, `quickstart.${key} must be a runnable curl line`);
    }
    // The sandbox quickstart must reference a fixture that actually ships.
    assert.doesNotThrow(() => readFileSync(join(ROOT, 'public/sandbox/get-resilience-score.json')));
  });

  it('advertises every official SDK ecosystem with an install command', () => {
    const sdks = view.endpoints.sdks;
    assert.deepEqual(
      Object.keys(sdks).filter((k) => !['guide', 'note'].includes(k)).sort(),
      ['go', 'javascript', 'python', 'ruby'],
    );
    assert.equal(sdks.python.install, 'pip install worldmonitor-sdk');
    assert.match(sdks.go.install, /^go get github\.com\/koala73\/worldmonitor\/sdk\/go$/);
    for (const key of ['javascript', 'python', 'ruby', 'go']) {
      assert.match(sdks[key].url, /^https:\/\//, `sdks.${key}.url must be a registry URL`);
    }
    // The SDK sources these advertise must exist in-repo.
    for (const dir of ['sdk/python', 'sdk/ruby', 'sdk/go']) {
      assert.doesNotThrow(() => readFileSync(join(ROOT, dir, 'README.md')), `${dir} must exist`);
    }
  });

  it('the marketing homepage points at the agent view via link rel=alternate', () => {
    // Hand-synced pair: the pro-test source and the committed build artifact
    // must both carry the pointer (the pre-push gate rebuilds and compares).
    const linkTag =
      '<link rel="alternate" type="application/json" href="https://www.worldmonitor.app/?mode=agent"';
    for (const path of ['pro-test/welcome.html', 'public/pro/welcome.html']) {
      assert.ok(
        readFileSync(join(ROOT, path), 'utf-8').includes(linkTag),
        `${path} must advertise the agent-mode view via <link rel="alternate">`,
      );
    }
  });

  it('advertises the schemamap and every section llms.txt', () => {
    assert.equal(view.discovery.schemamap, 'https://www.worldmonitor.app/schemamap.xml');
    assert.doesNotThrow(() => readFileSync(join(ROOT, 'public/schemamap.xml')));
    const sections = view.discovery.sectionLlmsTxt;
    assert.deepEqual(Object.keys(sections).sort(), ['api', 'blog', 'developers', 'docs']);
    const trackedSectionFiles = {
      api: 'public/api/llms.txt',
      developers: 'public/developers/llms.txt',
      blog: 'blog-site/src/pages/llms.txt.ts', // generated at /blog/llms.txt by Astro
    };
    for (const [section, path] of Object.entries(trackedSectionFiles)) {
      assert.doesNotThrow(
        () => readFileSync(join(ROOT, path)),
        `${path} must exist for discovery.sectionLlmsTxt.${section}`,
      );
    }
    // /docs/llms.txt is Mintlify-served; pin the URL so a docs-host move shows up here.
    assert.equal(sections.docs, 'https://www.worldmonitor.app/docs/llms.txt');
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
