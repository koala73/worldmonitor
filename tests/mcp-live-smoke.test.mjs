import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

test('the smoke CLI writes a partial report and exits 1 after an HTTP contract failure', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json', 'cf-ray': 'fixture-ray' });
    res.end(JSON.stringify({ error: 'fixture failure' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reportDir = mkdtempSync(join(tmpdir(), 'wm-mcp-live-smoke-'));
  const reportPath = join(reportDir, 'report.json');

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_SMOKE_HOSTS: origin,
        MCP_SMOKE_VARIANT_HOSTS: '',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 1, stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.version, 'mcp_live_smoke_report/v1');
    assert.equal(report.completedAllGroups, true);
    assert.deepEqual(report.completedGroups, ['canonical', 'aliases', 'proxy']);
    assert.ok(report.failures.length > 0);
    assert.ok(report.requests.some((request) => request.outcome === 'response' && request.status === 500));
    assert.ok(report.requests.every((request) => !Object.hasOwn(request, 'url')));
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(reportDir, { recursive: true, force: true });
  }
});

test('the smoke CLI preserves a partial report when its whole-run budget expires', async () => {
  const reportDir = mkdtempSync(join(tmpdir(), 'wm-mcp-live-smoke-budget-'));
  const reportPath = join(reportDir, 'report.json');
  const sentinel = 'MCP_SMOKE_BUDGET_SECRET';

  try {
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_SMOKE_HOSTS: `https://user:${sentinel}@example.invalid/mcp?token=${sentinel}`,
        MCP_SMOKE_VARIANT_HOSTS: '',
        MCP_SMOKE_RUN_BUDGET_MS: '1',
      },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.completedAllGroups, false);
    assert.deepEqual(report.completedGroups, []);
    assert.deepEqual(report.requests, []);
    assert.deepEqual(report.failures.map((failure) => ({ host: failure.host, check: failure.check })), [
      { host: 'runner', check: 'execution' },
    ]);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(sentinel));
    assert.doesNotMatch(stdout, new RegExp(sentinel));
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
});

test('the smoke CLI does not report unstarted probes after the run budget expires mid-walk', async () => {
  const server = createServer(async (req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    sendJson(res, 401, { jsonrpc: '2.0', id: 1, error: { code: -32001 } }, {
      'www-authenticate': `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource/mcp"`,
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reportDir = mkdtempSync(join(tmpdir(), 'wm-mcp-live-smoke-mid-budget-'));
  const reportPath = join(reportDir, 'report.json');

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_SMOKE_HOSTS: origin,
        MCP_SMOKE_VARIANT_HOSTS: '',
        MCP_SMOKE_RUN_BUDGET_MS: '17000',
      },
    });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.completedAllGroups, false);
    assert.deepEqual(report.completedGroups, []);
    assert.equal(report.requests.length, 1);
    assert.equal(report.requests[0].pathname, '/mcp');
    assert.equal(report.requests[0].outcome, 'response');
    assert.deepEqual(report.failures.map((failure) => failure.check), ['execution']);
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(reportDir, { recursive: true, force: true });
  }
});

// Answers every probe the way production should. `onTransportList` lets a test
// take over the keyless `tools/list` on /mcp, the check that broke on a
// connection cut mid-body in production (run 39392466642). `skillFor` and
// `onAuthMd` override the advertised agent_auth.skill and the /auth.md answer.
function createHealthyFixtureServer({ onTransportList, skillFor = (origin) => `${origin}/auth.md`, onAuthMd } = {}) {
  return createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const body = req.method === 'POST' ? await readRequestBody(req) : '';
    let rpc = null;
    try { rpc = body ? JSON.parse(body) : null; } catch { /* malformed OAuth bodies are expected */ }
    const commonGuideHeaders = {
      'content-type': 'text/markdown',
      'cache-control': 'no-store',
      vary: 'Accept, Last-Event-ID',
      link: '<https://worldmonitor.app/mcp>; rel="canonical"',
    };

    if (req.url === '/mcp' && req.method === 'GET') {
      if (req.headers.accept?.toLowerCase() === 'text/event-stream') {
        res.writeHead(405).end();
      } else {
        res.writeHead(200, commonGuideHeaders).end('World Monitor MCP Server');
      }
      return;
    }
    if (req.url === '/mcp' && req.method === 'HEAD') {
      res.writeHead(200, commonGuideHeaders).end();
      return;
    }
    if ((req.url === '/mcp' || req.url === '/api/mcp') && req.method === 'POST') {
      if (rpc.method === 'initialize') {
        const documentPath = req.url === '/api/mcp' ? '/api/mcp' : '/mcp';
        sendJson(res, 401, { jsonrpc: '2.0', id: rpc.id, error: { code: -32001 } }, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${documentPath}"`,
        });
      } else if (rpc.method === 'tools/list') {
        if (onTransportList?.(req, res)) return;
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'fixture' }] } });
      } else if (rpc.method === 'tools/call') {
        const value = { source: 'fixture' };
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            structuredContent: rpc.params.arguments.jmespath ? { projection: value } : value,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          },
        });
      } else {
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: {} });
      }
      return;
    }
    if (req.url === '/.well-known/mcp' && req.method === 'GET') {
      if (req.headers.accept?.toLowerCase() === 'text/event-stream') {
        res.writeHead(405).end();
      } else if (req.headers['last-event-id']) {
        sendJson(res, 401, { error: 'authentication required' }, { 'www-authenticate': 'Bearer' });
      } else {
        sendJson(res, 200, { name: 'fixture' }, { vary: 'Accept, Last-Event-ID' });
      }
      return;
    }
    if (req.url === '/.well-known/mcp' && req.method === 'POST') {
      if (rpc.method === 'tools/call') {
        sendJson(res, 401, { jsonrpc: '2.0', id: rpc.id, error: { code: -32001 } }, { 'www-authenticate': 'Bearer' });
      } else if (rpc.method === 'notifications/initialized') {
        res.writeHead(202).end();
      } else if (rpc.method === 'initialize') {
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: { capabilities: { tools: {} } } });
      } else if (rpc.method === 'tools/list') {
        sendJson(res, 200, {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [{
              name: 'fixture',
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
            }],
          },
        });
      } else {
        sendJson(res, 200, { jsonrpc: '2.0', id: rpc.id, result: {} });
      }
      return;
    }
    if (req.url === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      sendJson(res, 200, {
        issuer: origin,
        registration_endpoint: `${origin}/oauth/register`,
        token_endpoint: `${origin}/oauth/token`,
        agent_auth: { skill: skillFor(origin) },
      });
      return;
    }
    if (req.url === '/auth.md' && req.method === 'GET') {
      if (onAuthMd?.(req, res)) return;
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' }).end('# auth.md\n');
      return;
    }
    if ((req.url === '/oauth/register' || req.url === '/oauth/token') && req.method === 'POST') {
      sendJson(res, 400, { error: 'invalid_request' });
      return;
    }
    if (req.url?.startsWith('/api/mcp-proxy')) {
      if (req.method === 'OPTIONS') res.writeHead(204).end();
      else sendJson(res, 401, { error: 'Pro authentication required' });
      return;
    }
    res.writeHead(404).end();
  });
}

// Sends headers and part of the body, then drops the socket: undici surfaces
// this as `TypeError: terminated` while the smoke reads the body.
function cutResponseMidBody(res) {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
  res.write('{"jsonrpc":"2.0","result":{"tools":[');
  setTimeout(() => res.socket.destroy(), 20);
}

async function runSmokeAgainst(server, reportPrefix) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reportDir = mkdtempSync(join(tmpdir(), reportPrefix));
  const reportPath = join(reportDir, 'report.json');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: { ...process.env, MCP_SMOKE_HOSTS: origin, MCP_SMOKE_VARIANT_HOSTS: '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');
    return { exitCode, stdout, stderr, report: JSON.parse(readFileSync(reportPath, 'utf8')) };
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function transportListRequests(report) {
  return report.requests.filter((request) => request.pathname === '/mcp' && request.rpcMethod === 'tools/list');
}

test('a connection cut mid-body is retried once and does not fail the run', async () => {
  let cuts = 0;
  const server = createHealthyFixtureServer({
    onTransportList: (_req, res) => {
      if (cuts >= 1) return false;
      cuts += 1;
      cutResponseMidBody(res);
      return true;
    },
  });
  const { exitCode, stdout, stderr, report } = await runSmokeAgainst(server, 'wm-mcp-live-smoke-retry-');

  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(transportListRequests(report).map((request) => request.outcome), ['transport_error', 'response']);
  assert.match(stdout, /retrying once after a transport error/);
});

test('a connection cut on the retry as well still fails the check', async () => {
  const server = createHealthyFixtureServer({
    onTransportList: (_req, res) => {
      cutResponseMidBody(res);
      return true;
    },
  });
  const { exitCode, report } = await runSmokeAgainst(server, 'wm-mcp-live-smoke-retry-fail-');

  assert.equal(exitCode, 1);
  assert.equal(transportListRequests(report).length, 2);
  assert.deepEqual(report.failures.map((failure) => failure.check), ['tools/list on /mcp (keyless, no initialize → 200)']);
  assert.match(report.failures[0].detail, /HANG\/transport error/);
});

test('an HTTP status failure is never retried', async () => {
  const server = createHealthyFixtureServer({
    onTransportList: (_req, res) => {
      sendJson(res, 503, { error: 'fixture outage' });
      return true;
    },
  });
  const { exitCode, report } = await runSmokeAgainst(server, 'wm-mcp-live-smoke-no-retry-');

  assert.equal(exitCode, 1);
  assert.equal(transportListRequests(report).length, 1);
  assert.match(report.failures[0].detail, /expected HTTP 200, got 503/);
});

test('fails when agent_auth.skill is not the issuer origin /auth.md', async () => {
  const server = createHealthyFixtureServer({ skillFor: () => 'https://www.worldmonitor.app/auth.md' });
  const { exitCode, report } = await runSmokeAgainst(server, 'wm-mcp-live-smoke-skill-host-');

  assert.equal(exitCode, 1);
  assert.deepEqual(report.failures.map((failure) => failure.check), ['agent_auth skill']);
  assert.match(report.failures[0].detail, /expected http:\/\/127\.0\.0\.1:\d+\/auth\.md/);
});

test('fails when the issuer /auth.md redirects instead of serving markdown', async () => {
  const server = createHealthyFixtureServer({
    onAuthMd: (_req, res) => {
      res.writeHead(301, { location: 'https://www.worldmonitor.app/auth.md' }).end();
      return true;
    },
  });
  const { exitCode, report } = await runSmokeAgainst(server, 'wm-mcp-live-smoke-skill-redirect-');

  assert.equal(exitCode, 1);
  assert.deepEqual(report.failures.map((failure) => failure.check), ['agent_auth skill']);
  assert.match(report.failures[0].detail, /expected 200 markdown, got 301/);
});

test('the smoke CLI writes a zero-failure report after every expected check succeeds', async () => {
  const server = createHealthyFixtureServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reportDir = mkdtempSync(join(tmpdir(), 'wm-mcp-live-smoke-success-'));
  const reportPath = join(reportDir, 'report.json');

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_SMOKE_HOSTS: origin,
        MCP_SMOKE_VARIANT_HOSTS: '',
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 0, stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.version, 'mcp_live_smoke_report/v1');
    assert.equal(report.completedAllGroups, true);
    assert.deepEqual(report.completedGroups, ['canonical', 'aliases', 'proxy']);
    assert.equal(report.checks.failures, 0);
    assert.deepEqual(report.failures, []);
    assert.ok(report.requests.length > 0);
    assert.ok(report.requests.every((request) => request.group === 'canonical'));
    assert.ok(report.requests.every((request) => request.pathname !== '/api/mcp'));
    assert.ok(report.requests.every((request) => request.hostname === '127.0.0.1'));
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(reportDir, { recursive: true, force: true });
  }
});

test('default alias labels stay aligned with the shared host-policy module', async () => {
  const { MCP_PRODUCTION_ALIAS_LABELS } = await import('../shared/mcp-host-policy.ts');
  const smoke = readFileSync(join(process.cwd(), 'scripts/mcp-live-smoke.mjs'), 'utf8');
  const match = smoke.match(/const DEFAULT_ALIAS_LABELS = \[([^\]]+)\]/);
  assert.ok(match, 'DEFAULT_ALIAS_LABELS not found in scripts/mcp-live-smoke.mjs');
  const labels = [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  assert.deepEqual(labels, [...MCP_PRODUCTION_ALIAS_LABELS]);
});

test('MCP_SMOKE_HOSTS override skips production aliases and the www proxy', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reportDir = mkdtempSync(join(tmpdir(), 'wm-mcp-live-smoke-override-'));
  const reportPath = join(reportDir, 'report.json');

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_SMOKE_HOSTS: origin,
      },
    });
    const [exitCode] = await once(child, 'close');
    assert.equal(exitCode, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.deepEqual(report.completedGroups, ['canonical', 'aliases', 'proxy']);
    assert.ok(report.requests.every((request) => request.hostname === '127.0.0.1'));
    assert.ok(report.requests.every((request) => request.group === 'canonical'));
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(reportDir, { recursive: true, force: true });
  }
});

test('the smoke CLI asserts alias 308/410 migration and www proxy liveness', async () => {
  const goneHeaders = {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    link: '<https://worldmonitor.app/mcp>; rel="canonical"',
    vary: 'Accept, Last-Event-ID',
  };
  const redirectHeaders = {
    location: 'https://worldmonitor.app/mcp',
    vary: 'Accept, Last-Event-ID',
  };

  const server = createServer(async (req, res) => {
    const body = req.method === 'POST' ? await readRequestBody(req) : '';
    let rpc = null;
    try { rpc = body ? JSON.parse(body) : null; } catch { /* ignore */ }

    if (req.url === '/mcp' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (req.headers.accept?.toLowerCase() === 'text/event-stream' || req.headers['last-event-id']) {
        const payload = JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32000,
            message: 'Use https://worldmonitor.app/mcp',
            data: { reason: 'canonical_endpoint_required', endpoint: 'https://worldmonitor.app/mcp' },
          },
        });
        res.writeHead(410, { 'content-type': 'application/json', ...goneHeaders });
        res.end(req.method === 'HEAD' ? undefined : payload);
        return;
      }
      res.writeHead(308, redirectHeaders);
      res.end();
      return;
    }
    if (req.url === '/api/mcp' && req.method === 'GET') {
      res.writeHead(308, redirectHeaders);
      res.end();
      return;
    }
    if (req.url === '/mcp' && req.method === 'POST') {
      sendJson(res, 410, {
        jsonrpc: '2.0',
        id: rpc?.id ?? null,
        error: {
          code: -32000,
          message: 'Use https://worldmonitor.app/mcp',
          data: { reason: 'canonical_endpoint_required', endpoint: 'https://worldmonitor.app/mcp' },
        },
      }, goneHeaders);
      return;
    }
    if (req.url === '/mcp' && req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
      return;
    }
    if (req.url?.startsWith('/api/mcp-proxy')) {
      if (req.method === 'OPTIONS') res.writeHead(204).end();
      else sendJson(res, 401, { error: 'Pro authentication required' });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const reportDir = mkdtempSync(join(tmpdir(), 'wm-mcp-live-smoke-alias-'));
  const reportPath = join(reportDir, 'report.json');

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const child = spawn(process.execPath, ['scripts/mcp-live-smoke.mjs', '--report', reportPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_SMOKE_HOSTS: '',
        MCP_SMOKE_ALIAS_HOSTS: origin,
        MCP_SMOKE_PROXY_HOSTS: origin,
      },
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'close');

    assert.equal(exitCode, 0, stderr);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.completedAllGroups, true);
    assert.deepEqual(report.completedGroups, ['canonical', 'aliases', 'proxy']);
    assert.equal(report.checks.failures, 0);
    assert.ok(report.requests.some((request) => request.group === 'aliases' && request.method === 'HEAD' && request.pathname === '/mcp'));
    assert.ok(report.requests.some((request) => request.group === 'aliases' && request.method === 'POST' && request.pathname === '/mcp'));
    assert.ok(report.requests.some((request) => request.group === 'aliases' && request.pathname === '/api/mcp'));
    assert.ok(report.requests.some((request) => request.group === 'proxy' && request.pathname === '/api/mcp-proxy'));
    assert.equal(report.requests.filter((request) => request.group === 'canonical').length, 0);
  } finally {
    server.close();
    await once(server, 'close');
    rmSync(reportDir, { recursive: true, force: true });
  }
});
