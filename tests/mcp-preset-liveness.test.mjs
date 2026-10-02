import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { extractPresets, isTemplatePreset, probePreset } from '../scripts/lib/mcp-preset-liveness.mjs';
import { publishFindings, ISSUE_TITLE } from '../scripts/report-mcp-preset-liveness.mjs';

const openPreset = { name: 'New vendor', serverUrl: 'https://new.vendor.test/mcp' };
const keyedPreset = { ...openPreset, authNote: 'Requires an API key' };

describe('MCP preset catalog and probes', () => {
  it('derives new and reformatted entries from MCP_PRESETS without a URL roster', () => {
    const presets = extractPresets(`export const MCP_PRESETS: McpPreset[] = [
      {name: "New vendor", serverUrl: "https://new.vendor.test/mcp", defaultTool: 'query'},
      { name: 'Keyed vendor', serverUrl: 'https://keyed.vendor.test/mcp', authNote: 'Requires key' },
      { name: 'Any template name', serverUrl: 'https://my-server.example.com/mcp' }
    ];`);
    assert.equal(presets.length, 3);
    assert.equal(presets[0].serverUrl, openPreset.serverUrl);
    assert.equal(presets[1].authNote, 'Requires key');
    assert.equal(isTemplatePreset(presets[0]), false);
    assert.equal(isTemplatePreset(presets[2]), true);
    assert.equal(isTemplatePreset({ serverUrl: 'https://example.com.vendor.test/mcp' }), false);
  });

  it('fails visibly when the catalog is empty or an entry cannot be read', () => {
    for (const source of [
      '', 'export const MCP_PRESETS = [];',
      'export const MCP_PRESETS = [{ name: "Unreadable", serverUrl: computedUrl }];',
      'export const MCP_PRESETS = [...anotherCatalog];',
    ]) assert.throws(() => extractPresets(source), /MCP_PRESETS/);
  });

  it('accepts expected authentication responses and reports status drift', async () => {
    for (const [preset, statuses] of [[openPreset, [200]], [keyedPreset, [200, 401, 403]]]) {
      for (const status of [200, 301, 302, 307, 308, 401, 403, 404, 429, 500, 503]) {
        const result = await probePreset(preset, { fetchImpl: async () => new Response('', { status }) });
        assert.equal(result.ok, statuses.includes(status), `${preset.authNote || 'open'} HTTP ${status}`);
        assert.equal(result.observed, `HTTP ${status}`);
      }
    }
  });

  // The monitor's pass/fail must not be stricter than what api/mcp-proxy.ts can
  // actually serve: it follows one method-preserving hop, so a vendor moving
  // behind a stable front door is drift, not an outage. 301/302/303 stay
  // failures because they permit a rewrite to GET, which kills the JSON-RPC
  // handshake (#4938) and which the proxy refuses for the same reason.
  describe('redirect handling mirrors the proxy', () => {
    // Redirect targets are SSRF-checked, so the fake vendor hosts must resolve
    // to something public or every follow test would fail for the wrong reason.
    const publicAddress = async () => ['93.184.216.34'];
    const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return ''; } };

    function hops(...responses) {
      const seen = [];
      const queue = [...responses];
      return {
        seen,
        fetchImpl: async (url) => {
          seen.push(String(url));
          const next = queue.shift();
          if (!next) throw new Error(`unexpected extra request to ${url}`);
          return next;
        },
      };
    }
    const redirect = (status, location) => new Response('', { status, headers: { location } });

    for (const status of [307, 308]) {
      it(`follows a single ${status} and judges the resolved endpoint`, async () => {
        const h = hops(redirect(status, 'https://moved.vendor.test/mcp'), new Response('', { status: 200 }));
        const result = await probePreset(openPreset, { fetchImpl: h.fetchImpl, resolveHostname: publicAddress });
        assert.equal(result.ok, true);
        assert.equal(result.observed, `HTTP ${status} -> HTTP 200 https://moved.vendor.test/mcp`);
        assert.deepEqual(h.seen, [openPreset.serverUrl, 'https://moved.vendor.test/mcp']);
      });
    }

    it('judges a keyed preset from the resolved status, not the hop', async () => {
      const h = hops(redirect(308, 'https://moved.vendor.test/mcp'), new Response('', { status: 401 }));
      const result = await probePreset(keyedPreset, { fetchImpl: h.fetchImpl, resolveHostname: publicAddress });
      assert.equal(result.ok, true, '401 behind a hop is still healthy for a keyed preset');
      assert.match(result.observed, /HTTP 308 -> HTTP 401/);
    });

    it('reports a finding when the resolved endpoint is itself broken', async () => {
      const h = hops(redirect(308, 'https://moved.vendor.test/mcp'), new Response('', { status: 404 }));
      const result = await probePreset(openPreset, { fetchImpl: h.fetchImpl, resolveHostname: publicAddress });
      assert.equal(result.ok, false);
      assert.equal(result.observed, 'HTTP 308 -> HTTP 404 https://moved.vendor.test/mcp');
    });

    for (const status of [301, 302, 303]) {
      it(`refuses to follow a ${status}, which would rewrite the POST to GET`, async () => {
        const h = hops(redirect(status, 'https://moved.vendor.test/mcp'));
        const result = await probePreset(openPreset, { fetchImpl: h.fetchImpl, resolveHostname: publicAddress });
        assert.equal(result.ok, false);
        assert.equal(result.observed, `HTTP ${status}`);
        assert.deepEqual(h.seen, [openPreset.serverUrl], 'the redirect target must never be dispatched');
      });
    }

    it('refuses a second hop rather than chasing a chain', async () => {
      const h = hops(
        redirect(308, 'https://one.vendor.test/mcp'),
        redirect(308, 'https://two.vendor.test/mcp'),
      );
      const result = await probePreset(openPreset, { fetchImpl: h.fetchImpl, resolveHostname: publicAddress });
      assert.equal(result.ok, false);
      assert.match(result.observed, /HTTP 308 -> HTTP 308 https:\/\/one\.vendor\.test/);
      // Compare parsed hosts, never a substring of the URL: `includes` would
      // also match https://two.vendor.test.attacker.example, so it models the
      // dispatch less precisely than the code under test does.
      assert.ok(
        !h.seen.some(u => hostOf(u) === 'two.vendor.test'),
        'the second hop must never be dispatched',
      );
    });

    it('refuses a redirect onto a private address even over https', async () => {
      for (const [label, resolver] of [
        ['literal loopback', publicAddress],
        ['DNS into a reserved range', async () => ['10.0.0.7']],
      ]) {
        const location = label === 'literal loopback'
          ? 'https://127.0.0.1/mcp'
          : 'https://internal.vendor.test/mcp';
        const h = hops(redirect(308, location));
        const result = await probePreset(openPreset, { fetchImpl: h.fetchImpl, resolveHostname: resolver });
        assert.equal(result.ok, false, label);
        assert.equal(result.observed, 'HTTP 308', label);
        assert.deepEqual(h.seen, [openPreset.serverUrl], `${label}: the blocked target must never be dispatched`);
      }
    });

    it('refuses an http:// Location instead of downgrading the probe', async () => {
      const h = hops(redirect(308, 'http://moved.vendor.test/mcp'));
      const result = await probePreset(openPreset, { fetchImpl: h.fetchImpl, resolveHostname: publicAddress });
      assert.equal(result.ok, false);
      assert.equal(result.observed, 'HTTP 308');
      assert.deepEqual(h.seen, [openPreset.serverUrl]);
    });
  });

  it('names DNS failures instead of rejecting before the finding is recorded', async () => {
    const result = await probePreset(openPreset, { fetchImpl: async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' }) });
    } });
    assert.equal(result.ok, false);
    assert.match(result.observed, /ENOTFOUND/);
    assert.equal(result.name, openPreset.name);
    assert.equal(result.serverUrl, openPreset.serverUrl);
  });

  it('preserves the HTTP result when response-body cleanup rejects', async () => {
    for (const status of [200, 401, 403, 308]) {
      const response = new Response(new ReadableStream({ cancel() { throw new Error('stream already aborted'); } }), { status });
      const result = await probePreset(keyedPreset, { fetchImpl: async () => response });
      assert.equal(result.observed, `HTTP ${status}`);
      assert.equal(result.ok, status !== 308);
    }
  });

  // The redirect leg here is the http:// downgrade refusal, not a blanket
  // no-follow rule: the server is plain http, so the Location resolves to an
  // http target and the scheme guard rejects it. The follow path itself is
  // covered against https targets in 'redirect handling mirrors the proxy'.
  it('refuses an http redirect target, releases streaming bodies, and bounds a stalled request', { timeout: 2_000 }, async (t) => {
    const requests = [];
    const streamClosed = Promise.withResolvers();
    const server = createServer((req, res) => {
      requests.push({ url: req.url, method: req.method, headers: req.headers });
      req.resume();
      if (req.url === '/redirect') res.writeHead(308, { Location: '/stream' }).end();
      if (req.url === '/stream') {
        res.on('close', () => streamClosed.resolve());
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }).write(': connected\n\n');
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const redirect = await probePreset({ ...openPreset, serverUrl: `${base}/redirect` });
    assert.equal(redirect.ok, false);
    assert.equal(redirect.observed, 'HTTP 308');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.match(requests[0].headers['user-agent'], /WorldMonitor/);
    assert.equal(requests[0].headers.authorization, undefined);
    const stream = await probePreset({ ...openPreset, serverUrl: `${base}/stream` });
    assert.equal(stream.ok, true);
    await streamClosed.promise;
    const stalled = await probePreset({ ...openPreset, serverUrl: `${base}/stall` }, { timeoutMs: 30 });
    assert.equal(stalled.ok, false);
    assert.match(stalled.observed, /timeout/i);
  });
});

const failure = { ...openPreset, ok: false, observed: 'HTTP 308' };
const report = { checkedAt: '2026-09-13T00:00:00Z', expectedCount: 1, results: [failure] };

describe('MCP preset incident reporting', () => {
  it('escapes existing backslashes before table delimiters', () => {
    let payload;
    publishFindings({ ...report, results: [{ ...failure, name: 'Vendor\\|extra' }] }, {
      repository: 'owner/repo', gh: (_args, body) => { payload = body; return []; },
    });
    assert.ok(payload.body.includes('Vendor' + '\\'.repeat(3) + '|extra'));
  });

  it('publishes through the CLI when paginated issue bodies exceed the default subprocess buffer', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-preset-gh-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const reportPath = join(dir, 'report.json');
    const payloadPath = join(dir, 'payload.json');
    writeFileSync(reportPath, JSON.stringify(report));
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--paginate')) {
  console.log(JSON.stringify([[{ title: 'Unrelated issue', body: 'x'.repeat(1_100_000) }]]));
} else {
  fs.writeFileSync(process.env.MOCK_PAYLOAD, fs.readFileSync(0, 'utf8'));
  console.log(JSON.stringify({ number: 123 }));
}
`, { mode: 0o755 });
    const result = spawnSync(process.execPath, ['scripts/report-mcp-preset-liveness.mjs'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, MCP_PRESET_REPORT: reportPath,
        GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        MOCK_PAYLOAD: payloadPath, GITHUB_REPOSITORY: 'owner/repo', PROBE_OUTCOME: 'failure' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { findings: 1, action: 'created' });
    const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
    assert.equal(payload.title, ISSUE_TITLE);
    assert.match(payload.body, /HTTP 308/);
  });

  it('creates one issue with preset, URL, status and run evidence', () => {
    const calls = [];
    publishFindings(report, { repository: 'owner/repo', runUrl: 'https://github.com/owner/repo/actions/runs/123', gh: (args, payload) => {
      calls.push({ args, payload });
      return args.includes('--paginate') ? [[], []] : { number: 1 };
    } });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes('--paginate'));
    assert.equal(calls[1].payload.title, ISSUE_TITLE);
    assert.match(calls[1].payload.body, /New vendor.*https:\/\/new.vendor.test\/mcp.*HTTP 308/);
    assert.match(calls[1].payload.body, /actions\/runs\/123/);
  });

  it('updates the existing open incident across paginated results without comments or duplicates', () => {
    const calls = [];
    publishFindings(report, { repository: 'owner/repo', gh: (args, payload) => {
      calls.push({ args, payload });
      return args.includes('--paginate') ? [[{ title: ISSUE_TITLE, number: 2, pull_request: {} }], [{ title: ISSUE_TITLE, number: 3 }]] : {};
    } });
    assert.ok(calls[1].args.includes('PATCH'));
    assert.ok(calls[1].args.includes('repos/owner/repo/issues/3'));
    assert.equal(calls.length, 2);
  });

  it('creates nothing for healthy probes and fails visibly on missing/partial reports or API errors', () => {
    const unexpectedGh = () => { throw new Error('unexpected GitHub call'); };
    publishFindings({ ...report, results: [{ ...failure, ok: true, observed: 'HTTP 200' }] }, { gh: unexpectedGh });
    for (const invalid of [{}, { ...report, results: [] }, { ...report, expectedCount: 2 }]) {
      assert.throws(() => publishFindings(invalid, { gh: unexpectedGh }), /incomplete/i);
    }
    assert.throws(() => publishFindings(report, { repository: 'owner/repo', gh: () => { throw new Error('API unavailable'); } }), /API unavailable/);
    assert.throws(() => publishFindings({ ...report, results: [{ ...failure, ok: true }] }, {
      gh: unexpectedGh, probeOutcome: 'failure',
    }), /suite failed without endpoint findings/);
  });

  it('runs the real suite through report creation and incident formatting with a controlled redirect', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-preset-report-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const presets = extractPresets(readFileSync(new URL('../src/services/mcp-store.ts', import.meta.url), 'utf8'));
    const hosted = presets.filter(preset => !isTemplatePreset(preset));
    const preload = join(dir, 'fetch.mjs');
    const reportPath = join(dir, 'report.json');
    writeFileSync(preload, `globalThis.fetch = async url => new Response('', { status: url === ${JSON.stringify(hosted[0].serverUrl)} ? 308 : 200 });`);
    const env = { ...process.env, LIVE_MCP_TESTS: '1', MCP_PRESET_REPORT: reportPath, GITHUB_STEP_SUMMARY: join(dir, 'summary.md') };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', preload, '--test', 'tests/mcp-presets.test.mjs'], {
      cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const observation = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(observation.expectedCount, hosted.length);
    assert.equal(observation.results.length, hosted.length);
    assert.deepEqual(observation.results.filter(item => !item.ok), [{
      name: hosted[0].name, serverUrl: hosted[0].serverUrl, ok: false, observed: 'HTTP 308',
    }]);
    const writes = [];
    publishFindings(observation, { repository: 'owner/repo', probeOutcome: 'failure', gh: (_args, payload) => {
      if (payload) writes.push(payload);
      return [];
    } });
    assert.equal(writes.length, 1);
    assert.ok(writes[0].body.includes(hosted[0].name));
    assert.match(writes[0].body, /HTTP 308/);

    // A healthy report reaches the CLI entrypoint without needing GitHub access.
    observation.results.forEach(item => { item.ok = true; item.observed = 'HTTP 200'; });
    writeFileSync(reportPath, JSON.stringify(observation));
    const runReporter = extraEnv => spawnSync(process.execPath, ['scripts/report-mcp-preset-liveness.mjs'], {
      cwd: new URL('..', import.meta.url), env: { ...env, PROBE_OUTCOME: 'success', ...extraEnv }, encoding: 'utf8', timeout: 10_000,
    });
    const healthy = runReporter({});
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.deepEqual(JSON.parse(healthy.stdout), { findings: 0 });
    const incomplete = runReporter({ MCP_PRESET_REPORT: join(dir, 'missing.json') });
    assert.equal(incomplete.status, 1);
    assert.match(incomplete.stderr, /could not report/);
  });
});

describe('MCP preset scheduled workflow', () => {
  it('runs the existing opt-in suite weekly, reports failures, and never runs on PRs or pushes', () => {
    const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/mcp-preset-liveness.yml', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
    assert.equal(workflow.on.schedule[0].cron, '23 6 * * 1');
    assert.equal(workflow.concurrency['cancel-in-progress'], false);
    assert.deepEqual(workflow.permissions, { contents: 'read', issues: 'write' });
    assert.ok(workflow.jobs.monitor['timeout-minutes'] <= 10);
    const steps = workflow.jobs.monitor.steps;
    const probe = steps.find(step => step.id === 'probe');
    assert.match(probe.run, /node --test tests\/mcp-presets.test.mjs/);
    assert.equal(probe.env.LIVE_MCP_TESTS, '1');
    assert.ok(probe.env.MCP_PRESET_REPORT);
    assert.equal(probe['continue-on-error'], true);
    const publish = steps.find(step => step.id === 'report');
    assert.match(publish.run, /node scripts\/report-mcp-preset-liveness.mjs/);
    assert.equal(publish.env.MCP_PRESET_REPORT, probe.env.MCP_PRESET_REPORT);
    assert.equal(publish.env.PROBE_OUTCOME, '${{ steps.probe.outcome }}');
    assert.equal(publish['continue-on-error'], undefined);
  });
});
