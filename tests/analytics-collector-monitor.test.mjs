import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ANALYTICS_CANARY_WEBSITE_ID,
  COLLECTOR_PROBES,
  buildProbeRequest,
  evaluateProbeResult,
  extractCollectorFailureMetadata,
  isBotFilteredBody,
  runCollectorChecks,
  summarizeProbeFailures,
  summarizeWriteCanaryResults,
} from '../scripts/check-analytics-collector.mjs';

const receiptBody = JSON.stringify({ cache: 'cache-id', sessionId: 'session-id', visitId: 'visit-id' });
const OK_RECEIPT = { status: 200, body: receiptBody };
const P2002_BODY = JSON.stringify({
  error: { errorObject: { code: 'P2002', meta: { target: ['session_data_pkey'] } } },
});

/** Healthy response for a non-write probe, matching each one's own assertion. */
const healthyLiveness = (probe) => {
  if (probe.name === 'tracker-script') return { status: 200, body: "!function(){'/api/send'}" };
  if (probe.name === 'ingest-route') return { status: 405 };
  return { status: 200 };
};

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

  it('contends two concurrent identify writes on one session_data key', () => {
    assert.equal(probeByName('ingest-route').path, '/api/send');
    assert.equal(buildProbeRequest(probeByName('ingest-route')).method, 'GET');

    const writeCanaries = COLLECTOR_PROBES.filter((candidate) => candidate.writeCanary);
    const payloads = writeCanaries.map((probe) => {
      const request = buildProbeRequest(probe);
      assert.equal(probe.path, '/api/send');
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['Content-Type'], 'application/json');
      assert.match(request.headers['User-Agent'], /^Mozilla\/5\.0 /);
      return JSON.parse(request.body);
    });

    // Umami routes type:'event' through saveEvent()/saveEventData(), which never
    // touches session_data; only type:'identify' reaches saveSessionData(), where
    // #4183's updateMany() race lives. A burst of events therefore cannot
    // reproduce the race no matter how concurrent it is — at least TWO identify
    // writes sharing one data key are required.
    const identifies = payloads.filter((body) => body.type === 'identify');
    assert.ok(
      identifies.length >= 2,
      'at least two identify writes are required to contend on session_data',
    );
    const contendedKeys = identifies.map((body) => Object.keys(body.payload.data).join(','));
    assert.equal(
      new Set(contendedKeys).size,
      1,
      'contending identify writes must target the SAME session_data key',
    );

    // General write-path coverage that identify alone does not give.
    assert.ok(payloads.some((body) => body.type === 'event' && body.payload.name === undefined));
    assert.ok(payloads.some((body) => body.payload.name === 'collector-write-canary'));

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

  it('does not publish a stable canary session id an outsider can squat on', () => {
    const source = readFileSync(new URL('../scripts/check-analytics-collector.mjs', import.meta.url), 'utf8');
    assert.match(source, /randomUUID\(\)/, 'the canary session id must be generated per run');
    assert.doesNotMatch(
      source,
      /ANALYTICS_CANARY_SESSION_ID\s*=\s*['"]/,
      '/api/send is unauthenticated and this repo is public — a literal session id is a griefing target',
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
    // A bot-filtered 200 must be NAMED as such. Reporting it as a generic
    // missing receipt blames the write path for a drop Umami made on purpose,
    // which sends the on-call reader looking for a database fault that is not
    // there. The canary sends a browser User-Agent, so this firing at all means
    // the bot heuristic now matches us and the probe has stopped measuring the
    // write path it claims to measure.
    assert.match(
      evaluateProbeResult(writeCanary, { status: 200, body: '{"beep":"boop"}' }),
      /bot-filtered/,
    );
    assert.match(
      evaluateProbeResult(writeCanary, { status: 200, body: '{not json' }),
      /receipt was not valid JSON/,
    );
  });

  it('detects the Umami bot-filter sentinel without matching a real receipt', () => {
    assert.equal(isBotFilteredBody('{"beep":"boop"}'), true);
    assert.equal(isBotFilteredBody('  {"beep":"boop"}  '), true);
    // A genuine receipt is never the sentinel, even if a field value happens to
    // spell one of the sentinel's words — this must key off the parsed `beep`
    // property, not a substring scan an upstream value could forge.
    assert.equal(isBotFilteredBody(receiptBody), false);
    assert.equal(
      isBotFilteredBody(JSON.stringify({ cache: 'beep', sessionId: 'boop', visitId: 'v' })),
      false,
    );
    assert.equal(isBotFilteredBody('{"beep":"something-else"}'), false);
    assert.equal(isBotFilteredBody('{not json'), false);
    assert.equal(isBotFilteredBody(''), false);
    assert.equal(isBotFilteredBody(undefined), false);
    assert.equal(isBotFilteredBody(null), false);
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
    const reason = evaluateProbeResult(probeByName('write-canary-identify-a'), { status: 500, body });
    assert.match(reason, /HTTP 500/);
    assert.match(reason, /P2002/);
    assert.match(reason, /session_data_pkey/);
    assert.doesNotMatch(reason, /session_data_id/);
  });

  it('computes the write failure rate over every attempt, not the survivor', () => {
    // Six attempts (two bursts of three), two of which failed.
    const attempts = [
      { name: 'write-canary-identify-a', reason: null },
      { name: 'write-canary-identify-b', reason: 'HTTP 500 (expected 200) — Prisma P2002 constraint session_data_pkey' },
      { name: 'write-canary-pageview', reason: null },
      { name: 'write-canary-identify-a', reason: null },
      { name: 'write-canary-identify-b', reason: 'request failed: fetch failed' },
      { name: 'write-canary-pageview', reason: null },
    ];

    assert.deepEqual(summarizeWriteCanaryResults(attempts), {
      total: 6,
      failed: 2,
      failureRate: 2 / 6,
      failures: [
        { name: 'write-canary-identify-b', reason: 'HTTP 500 (expected 200) — Prisma P2002 constraint session_data_pkey' },
        { name: 'write-canary-identify-b', reason: 'request failed: fetch failed' },
      ],
    });
  });

  it('fires every write canary concurrently, in each burst', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const burstSizes = [];
    let pending = 0;

    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        inFlight += 1;
        pending += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (inFlight === 0) { burstSizes.push(pending); pending = 0; }
        return OK_RECEIPT;
      },
    });

    const canaryCount = COLLECTOR_PROBES.filter((probe) => probe.writeCanary).length;
    assert.equal(maxInFlight, canaryCount, 'every canary in a burst must be in flight together');
    assert.ok(burstSizes.length > 1, 'the canary must run more than one burst');
    assert.ok(
      burstSizes.every((size) => size === canaryCount),
      `every burst must stay concurrent, saw ${JSON.stringify(burstSizes)}`,
    );
    assert.equal(report.alerting, false);
  });

  it('still reports a non-zero write failure rate when a later attempt succeeds', async () => {
    // The regression this monitor exists for: a per-probe first-success-wins
    // retry reports 0.0% through exactly the incident it should catch.
    let identifyAttempts = 0;
    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        if (probe.name === 'write-canary-identify-b') {
          identifyAttempts += 1;
          if (identifyAttempts === 1) return { status: 500, body: P2002_BODY };
        }
        return OK_RECEIPT;
      },
    });

    assert.ok(report.writeSummary.failed > 0, 'a failed attempt must survive a later success');
    assert.ok(report.writeSummary.failureRate > 0, 'the reported rate must not be 0.0%');
    assert.equal(report.alerting, true, 'any failed write attempt is actionable after #5715 remediation');
    assert.match(report.writeSummary.failures[0].reason, /P2002/);
  });

  it('exits non-zero when the write path is dead even though liveness is green', async () => {
    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        return { status: 500, body: P2002_BODY };
      },
    });

    assert.equal(report.livenessFailures.length, 0, 'liveness is deliberately green here');
    assert.equal(report.writePathDead, true);
    assert.equal(report.alerting, true, 'a dead write path must alert on its own');
  });

  it('alerts on any known #4183 conflict until the upstream race is remediated', async () => {
    // A single collision is enough to fail the acceptance contract: every
    // canary burst must be 4/4 successful, and two consecutive scheduled runs
    // must remain clean after the upstream upsert fix is deployed.
    let seen = 0;
    const report = await runCollectorChecks({
      sleep: async () => {},
      runner: async (_origin, probe) => {
        if (!probe.writeCanary) return healthyLiveness(probe);
        seen += 1;
        if (seen === 1) return { status: 500, body: P2002_BODY };
        return OK_RECEIPT;
      },
    });

    assert.ok(report.writeSummary.failureRate > 0, 'the rate is still reported');
    assert.equal(report.hasWriteFailures, true);
    assert.equal(report.alerting, true, 'the known race must remain visible until fixed');
  });

  it('reports every failing probe, in probe order, and nothing else', () => {
    const failures = summarizeProbeFailures(COLLECTOR_PROBES, {
      heartbeat: { status: 502 },
      'tracker-script': { status: 200, body: 'posts to /api/send' },
      'ingest-route': { error: 'fetch failed' },
      'write-canary-pageview': { status: 500 },
      'write-canary-event': { status: 200, body: JSON.stringify({ cache: 'x', sessionId: 'y', visitId: 'z' }) },
      'write-canary-identify-a': { status: 200, body: JSON.stringify({ cache: 'x', sessionId: 'y', visitId: 'z' }) },
      'write-canary-identify-b': { status: 200, body: JSON.stringify({ cache: 'x', sessionId: 'y', visitId: 'z' }) },
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
