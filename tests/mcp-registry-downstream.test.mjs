import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { createMcpToolExecutionContext } from '../api/mcp/downstream.ts';
import { verifyInternalMcpRequest } from '../server/_shared/mcp-internal-hmac.ts';
import { HMAC_SECRET } from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const cases = [
  ['get_company_intelligence', { ticker: 'AAPL' }],
  ['classify_event', { text: 'A port closes after a storm' }],
  ['extract_entities', {}],
  ['get_news_clusters', {}],
  ['get_food_stocks', { country_code: 'US' }],
  ['get_country_brief', { country_code: 'US' }],
];
for (const origin of ['http://127.0.0.1:46123', 'https://api.worldmonitor.app']) {
  for (const kind of ['env_key', 'pro', 'user_key']) {
    describe(`${kind} downstream at ${origin}`, () => {
      for (const [name, args] of cases) {
        it(`${name} preserves identity and isolates the transport token`, async () => {
          process.env.LOCAL_API_TOKEN = 'test-local-token';
          process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
          const requests = [];
          globalThis.fetch = async (url, init) => {
            requests.push({ url, init });
            return Response.json({ categories: {}, feedStatuses: { fixture: 'ok' }, coverage: { state: 'complete' }, records: [], brief: 'test brief' });
          };
          const tool = TOOL_REGISTRY.find((entry) => entry.name === name);
          const context = kind === 'env_key' ? { kind, apiKey: 'test-key' } : { kind, userId: 'test-user', mcpTokenId: 'test-token' };
          await tool._execute(args, origin, context, createMcpToolExecutionContext(`${origin}/mcp`));
          assert.equal(requests.length, name === 'get_country_brief' ? 2 : 1);
          for (const { url, init } of requests) {
            const headers = new Headers(init.headers);
            assert.equal(headers.get('X-WorldMonitor-Local-Token'), origin.startsWith('http:') ? 'test-local-token' : null);
            assert.ok(headers.get('User-Agent'));
            if (kind === 'env_key') assert.equal(headers.get('X-WorldMonitor-Key'), 'test-key');
            else {
              const request = new Request(url, init);
              const result = await verifyInternalMcpRequest(request, HMAC_SECRET);
              assert.equal(result?.userId, 'test-user');
            }
          }
        });
      }
    });
  }
}

describe('downstream transport boundaries', () => {
  for (const origin of ['http://localhost:46123', 'http://[::1]:46123']) {
    it(`recognizes the expected loopback origin ${origin}`, async () => {
      const { fetchMcpDownstream } = await import('../api/mcp/downstream.ts');
      process.env.LOCAL_API_TOKEN = 'test-local-token';
      globalThis.fetch = async (_url, init) => {
        assert.equal(new Headers(init.headers).get('X-WorldMonitor-Local-Token'), 'test-local-token');
        assert.equal(init.redirect, 'error');
        return Response.json({});
      };
      await fetchMcpDownstream(`${origin}/api/test`, { headers: {} }, createMcpToolExecutionContext(`${origin}/mcp`));
    });
  }

  it('covers every registry fetch with the shared transport policy', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const ts = await import('typescript');
    // Any identifier named `fetch` is a bypass — a bare call, `globalThis.fetch(`,
    // an alias (`const f = fetch`) or passing it as a value. Matching only a
    // callee whose text is exactly `fetch` would let all but the first through.
    const auditSource = (filename, source) => {
      let calls = 0;
      const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      const visit = (node) => {
        if (ts.isIdentifier(node) && node.text === 'fetch') {
          assert.fail(`${filename}: direct fetch bypasses downstream transport policy`);
        }
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 'fetchMcpDownstream') {
          calls++;
          assert.equal(node.arguments[2]?.getText(ast), 'execution', `${filename}: missing execution context`);
        }
        // A helper that declares `execution` optional or defaulted lets a
        // caller omit it: the call above still reads `execution` and passes
        // this guard while the token is silently dropped. Require the
        // required-but-nullable shape fetchMcpDownstream itself uses.
        if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'execution' && (node.questionToken || node.initializer)) {
          assert.fail(`${filename}: optional execution parameter can drop the transport token`);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      return calls;
    };
    // Negative controls: the guard must go red on every bypass shape it claims to catch.
    for (const bypass of ['fetch(url)', 'globalThis.fetch(url)', 'const f = fetch; f(url)', 'run(fetch)', 'fetchMcpDownstream(url, init)']) {
      assert.throws(() => auditSource('fixture.ts', `async function t() { ${bypass}; }`), `guard must reject: ${bypass}`);
    }
    for (const helper of ['execution?: X', 'execution = undefined', 'execution: X | undefined = undefined']) {
      assert.throws(() => auditSource('fixture.ts', `async function h(base: string, ${helper}) { await fetchMcpDownstream(url, init, execution); }`), `guard must reject helper param: ${helper}`);
    }
    assert.equal(auditSource('fixture.ts', 'async function t() { await fetchMcpDownstream(url, init, execution); }'), 1);
    assert.equal(auditSource('fixture.ts', 'async function h(base: string, execution: X | undefined) { await fetchMcpDownstream(url, init, execution); }'), 1);
    let calls = 0;
    const registryDir = new URL('../api/mcp/registry/', import.meta.url);
    for (const filename of readdirSync(registryDir, { recursive: true }).filter((name) => name.endsWith('.ts'))) {
      calls += auditSource(filename, readFileSync(new URL(filename, registryDir), 'utf8'));
    }
    assert.ok(calls >= 30, 'all RPC, company, and NLP downstream calls were inspected');
  });

  it('excludes tokens outside the expected loopback origin and preserves request options', async () => {
    const { fetchMcpDownstream } = await import('../api/mcp/downstream.ts');
    process.env.LOCAL_API_TOKEN = 'test-local-token';
    const execution = createMcpToolExecutionContext('http://127.0.0.1:46123/mcp');
    const controller = new AbortController();
    const init = { method: 'POST', headers: { 'User-Agent': 'test', 'Content-Type': 'application/json' }, body: '{"data":1}', signal: controller.signal, redirect: 'manual' };
    for (const target of ['https://example.test/path', 'http://127.0.0.1:46124/path', 'http://localhost:46123/path']) {
      globalThis.fetch = async (url, options) => {
        assert.equal(new Headers(options.headers).get('X-WorldMonitor-Local-Token'), null);
        assert.equal(options.body, init.body);
        assert.equal(options.signal, init.signal);
        assert.equal(options.redirect, 'manual');
        return Response.json({});
      };
      await fetchMcpDownstream(target, init, execution);
    }
  });

  it('does not follow a redirect carrying the local token to a second origin', async () => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const { fetchMcpDownstream } = await import('../api/mcp/downstream.ts');
    process.env.LOCAL_API_TOKEN = 'test-local-token';
    let remoteHits = 0;
    const remote = createServer((req, res) => { remoteHits++; res.end('remote'); });
    remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
    let localToken;
    const local = createServer((req, res) => {
      localToken = req.headers['x-worldmonitor-local-token'];
      res.writeHead(302, { Location: `http://127.0.0.1:${remote.address().port}/secret` }); res.end();
    });
    local.listen(0, '127.0.0.1'); await once(local, 'listening');
    const origin = `http://127.0.0.1:${local.address().port}`;
    try {
      await assert.rejects(fetchMcpDownstream(`${origin}/start`, { headers: { 'User-Agent': 'test' } }, createMcpToolExecutionContext(`${origin}/mcp`)));
      assert.equal(localToken, 'test-local-token');
      assert.equal(remoteHits, 0);
    } finally {
      await Promise.all([new Promise((resolve) => local.close(resolve)), new Promise((resolve) => remote.close(resolve))]);
    }
  });

  it('authenticates a registry call through the real sidecar gate', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createLocalApiServer } = await import('../src-tauri/sidecar/local-api-server.mjs');
    const root = await mkdtemp(join(tmpdir(), 'mcp-sidecar-token-'));
    const apiDir = join(root, 'api');
    await mkdir(join(apiDir, 'intelligence/v1'), { recursive: true });
    await writeFile(join(apiDir, 'intelligence/v1/get-company-enrichment.js'), `export default function(req) { return Response.json({ company: { ticker: 'AAPL' }, key: req.headers.get('X-WorldMonitor-Key') }); }`);
    process.env.LOCAL_API_TOKEN = 'test-local-token';
    const app = await createLocalApiServer({ port: 0, apiDir, mode: 'docker', cloudFallback: 'false', logger: { log() {}, warn() {}, error() {} } });
    const { port } = await app.start();
    // Keep the sidecar-installed fetch wrapper in place: the tool call below
    // must go through the same SSRF allowlist and upstream-slot limiter the
    // production self-hosted path uses. Only the raw unauthorized probe uses
    // the pre-import fetch.
    const origin = `http://127.0.0.1:${port}`;
    try {
      const unauthorized = await originalFetch(`${origin}/api/intelligence/v1/get-company-enrichment`);
      assert.equal(unauthorized.status, 401);
      const tool = TOOL_REGISTRY.find((entry) => entry.name === 'get_company_intelligence');
      const result = await tool._execute({ ticker: 'AAPL' }, origin, { kind: 'env_key', apiKey: 'test-key' }, createMcpToolExecutionContext(`${origin}/mcp`));
      assert.equal(result.enrichment.company.ticker, 'AAPL');
      assert.equal(result.enrichment.key, 'test-key');
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
