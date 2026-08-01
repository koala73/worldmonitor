import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ANALYTICS_CANARY_WEBSITE_ID,
  COLLECTOR_PROBES,
  buildProbeRequest,
  evaluateProbeResult,
  extractCollectorFailureMetadata,
  summarizeProbeFailures,
  summarizeWriteCanaryResults,
} from '../scripts/check-analytics-collector.mjs';

const probeByName = (name) => COLLECTOR_PROBES.find((probe) => probe.name === name);

describe('scheduled analytics collector monitor', () => {
  it('accepts the live shape of a healthy collector', () => {
    // Verified against production 2026-07-24 after the #5565 restore.
    assert.equal(evaluateProbeResult(probeByName('heartbeat'), { status: 200 }), null);
    assert.equal(
      evaluateProbeResult(probeByName('tracker-script'), {
        status: 200,
        body: '!function(){"use strict";...\'/api/send\'...}',
      }),
      null,
    );
    assert.equal(evaluateProbeResult(probeByName('ingest-route'), { status: 405 }), null);
    for (const probe of COLLECTOR_PROBES.filter((candidate) => candidate.writeCanary)) {
      assert.equal(
        evaluateProbeResult(probe, {
          status: 200,
          body: JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' }),
        }),
        null,
      );
    }
  });

  it('alerts on the exact failure signature of the 4-day outage', () => {
    // Cloudflare 502 after the origin OOM-died, on every path.
    for (const probe of COLLECTOR_PROBES) {
      const name = probe.name;
      assert.match(evaluateProbeResult(probeByName(name), { status: 502 }), /HTTP 502/);
    }
    assert.match(
      evaluateProbeResult(probeByName('heartbeat'), { error: 'The operation was aborted' }),
      /request failed/,
    );
  });

  it('POSTs concurrent pageview, named-event, and identify shapes to one canary session', () => {
    assert.equal(probeByName('ingest-route').path, '/api/send');
    assert.equal(buildProbeRequest(probeByName('ingest-route')).method, 'GET');

    const writeCanaries = COLLECTOR_PROBES.filter((candidate) => candidate.writeCanary);
    assert.deepEqual(
      writeCanaries.map((probe) => probe.name),
      ['write-canary-pageview', 'write-canary-event', 'write-canary-identify'],
    );

    const payloads = writeCanaries.map((probe) => {
      const request = buildProbeRequest(probe);
      assert.equal(probe.path, '/api/send');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['Content-Type'], 'application/json');
      assert.match(request.headers['User-Agent'], /^Mozilla\/5\.0 /);
      return JSON.parse(request.body);
    });

    assert.deepEqual(payloads.map((body) => body.type), ['event', 'event', 'identify']);
    assert.equal(payloads[0].payload.name, undefined, 'first write must be a real pageview');
    assert.equal(payloads[0].payload.data, undefined, 'pageview must not masquerade as a named event');
    assert.equal(payloads[1].payload.name, 'collector-write-canary');
    assert.deepEqual(payloads[1].payload.data, { source: 'github-actions' });
    assert.deepEqual(payloads[2].payload.data, { monitor: 'github-actions' });

    assert.equal(new Set(payloads.map((body) => body.payload.website)).size, 1);
    assert.equal(new Set(payloads.map((body) => body.payload.id)).size, 1);
    assert.equal(payloads[0].payload.website, ANALYTICS_CANARY_WEBSITE_ID);
    assert.equal(payloads[0].payload.hostname, 'analytics-canary.worldmonitor.app');
    assert.notEqual(
      ANALYTICS_CANARY_WEBSITE_ID,
      'e8800335-c853-46a8-8497-c993ed2f58bc',
      'the monitor must never pollute the product analytics website',
    );
  });

  it('blames the probe, not the collector, when the WAF rejects the User-Agent', () => {
    // A bare `curl/*` agent 403s on this host — that is a monitor bug, and the
    // alert has to say so or it reads as an outage.
    const reason = evaluateProbeResult(probeByName('heartbeat'), { status: 403 });
    assert.match(reason, /User-Agent/);
    assert.match(reason, /not the collector/);
  });

  it('rejects a 200 that is not actually the tracker', () => {
    // An error page or a proxy interstitial can answer 200 on /script.js.
    const reason = evaluateProbeResult(probeByName('tracker-script'), {
      status: 200,
      body: '<!doctype html><title>Bad gateway</title>',
    });
    assert.match(reason, /did not contain \/api\/send/);
  });

  it('rejects bot-filtered and malformed write-canary receipts despite HTTP 200', () => {
    const writeCanary = probeByName('write-canary-event');
    assert.match(
      evaluateProbeResult(writeCanary, { status: 200, body: '{"beep":"boop"}' }),
      /receipt missing non-empty string cache/,
    );
    assert.match(
      evaluateProbeResult(writeCanary, { status: 200, body: '{not json' }),
      /receipt was not valid JSON/,
    );
  });

  it('surfaces Prisma failure metadata without retaining the analytics payload', () => {
    const body = JSON.stringify({
      error: {
        errorObject: {
          code: 'P2002',
          meta: { target: ['session_data_pkey'] },
          message: 'Unique constraint failed on the fields: (session_data_id)',
          stack: 'not emitted',
        },
      },
    });

    assert.deepEqual(extractCollectorFailureMetadata(body), {
      prismaCode: 'P2002',
      constraint: 'session_data_pkey',
    });
    const reason = evaluateProbeResult(probeByName('write-canary-identify'), { status: 500, body });
    assert.match(reason, /HTTP 500/);
    assert.match(reason, /P2002/);
    assert.match(reason, /session_data_pkey/);
    assert.doesNotMatch(reason, /session_data_id/);
  });

  it('reports the write failure rate separately from liveness failures', () => {
    const resultsByName = {
      'write-canary-pageview': {
        status: 200,
        body: JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' }),
      },
      'write-canary-event': {
        status: 500,
        body: JSON.stringify({ error: { code: 'P2002', meta: { target: ['session_data_pkey'] } } }),
      },
      'write-canary-identify': {
        error: 'fetch failed',
      },
    };

    assert.deepEqual(summarizeWriteCanaryResults(COLLECTOR_PROBES, resultsByName), {
      total: 3,
      failed: 2,
      failureRate: 2 / 3,
      failures: [
        { name: 'write-canary-event', reason: 'HTTP 500 (expected 200) — Prisma P2002 constraint session_data_pkey' },
        { name: 'write-canary-identify', reason: 'request failed: fetch failed' },
      ],
    });
  });

  it('reports every failing probe, in probe order, and nothing else', () => {
    const failures = summarizeProbeFailures(COLLECTOR_PROBES, {
      heartbeat: { status: 502 },
      'tracker-script': { status: 200, body: 'posts to /api/send' },
      'ingest-route': { error: 'fetch failed' },
      'write-canary-pageview': { status: 500 },
      'write-canary-event': { status: 200, body: JSON.stringify({ cache: 'x', sessionId: 'y', visitId: 'z' }) },
      'write-canary-identify': { status: 200, body: JSON.stringify({ cache: 'x', sessionId: 'y', visitId: 'z' }) },
    });
    assert.deepEqual(
      failures.map((failure) => failure.name),
      ['heartbeat', 'ingest-route', 'write-canary-pageview'],
    );
    assert.match(failures[1].reason, /fetch failed/);
    assert.match(failures[2].reason, /HTTP 500/);
  });

  it('refuses malformed probes and results instead of passing them', () => {
    assert.throws(() => evaluateProbeResult(null, { status: 200 }), /probe must be an object/);
    assert.throws(
      () => evaluateProbeResult({ name: 'x', okStatuses: [] }, { status: 200 }),
      /okStatuses/,
    );
    assert.throws(() => evaluateProbeResult(probeByName('heartbeat'), null), /result must be/);
  });

  it('runs on a schedule and invokes the monitor script without a main-green gate', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/analytics-collector-monitor.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /schedule:/);
    assert.match(workflow, /cron:\s*['"]\*\/5 \* \* \* \*['"]/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]+/);
    assert.match(workflow, /node-version:\s*['"]24['"]/);
    assert.match(workflow, /node scripts\/check-analytics-collector\.mjs/);
    // The gate that seed-freshness-monitor.yml uses must NOT appear here.
    assert.doesNotMatch(workflow, /context\s*==\s*"gate"/);
  });
});
