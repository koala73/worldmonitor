import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  COLLECTOR_PROBES,
  evaluateProbeResult,
  summarizeProbeFailures,
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
  });

  it('alerts on the exact failure signature of the 4-day outage', () => {
    // Cloudflare 502 after the origin OOM-died, on every path.
    for (const name of ['heartbeat', 'tracker-script', 'ingest-route']) {
      assert.match(evaluateProbeResult(probeByName(name), { status: 502 }), /HTTP 502/);
    }
    assert.match(
      evaluateProbeResult(probeByName('heartbeat'), { error: 'The operation was aborted' }),
      /request failed/,
    );
  });

  it('never POSTs to the ingest route, so probing writes no synthetic events', () => {
    const source = readFileSync(
      new URL('../scripts/check-analytics-collector.mjs', import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/i);
    assert.equal(probeByName('ingest-route').path, '/api/send');
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

  it('reports every failing probe, in probe order, and nothing else', () => {
    const failures = summarizeProbeFailures(COLLECTOR_PROBES, {
      heartbeat: { status: 502 },
      'tracker-script': { status: 200, body: 'posts to /api/send' },
      'ingest-route': { error: 'fetch failed' },
    });
    assert.deepEqual(
      failures.map((failure) => failure.name),
      ['heartbeat', 'ingest-route'],
    );
    assert.match(failures[1].reason, /fetch failed/);
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
    assert.match(workflow, /cron:\s*['"]\*\/15 \* \* \* \*['"]/);
    assert.match(workflow, /actions\/setup-node@[a-f0-9]+/);
    assert.match(workflow, /node-version:\s*['"]24['"]/);
    assert.match(workflow, /node scripts\/check-analytics-collector\.mjs/);
    // The gate that seed-freshness-monitor.yml uses must NOT appear here.
    assert.doesNotMatch(workflow, /context\s*==\s*"gate"/);
  });
});
