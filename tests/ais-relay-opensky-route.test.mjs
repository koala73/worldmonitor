// Guards for the OpenSky route selector and the 403-vs-429 metric split.
//
// Why the route is SELECTED and never cascades: OpenSky's rate limit is per ACCOUNT
// (4,000 credits/day keyed on OPENSKY_CLIENT_ID — scripts/_opensky-account-cooldown.cjs
// says so outright, and docs/solutions/integration-issues/
// opensky-bbox-area-billing-flat-top-tier.md measured the exhaustion), NOT per exit IP.
// A residential exit buys no quota, so an automatic proxy-on-failure fallback would
// spend a SECOND account credit retrying the one error class a different IP cannot fix.
// Reintroducing a cascade would be a cost regression that no panel would show.
//
// ais-relay.cjs is a non-exported monolith that executes on import (see its own note at
// the top), so — as with tests/ais-relay-opensky-proxy-tls.test.mjs — the durable
// coverage is a source guard plus a behavioural test of the shared helper it overrides.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyUpstreamOutcome } = require('../scripts/_ingestion-coverage.cjs');
const SRC = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

/** Balanced `{...}` starting at or after `from`. */
function balancedBlockAt(from, label) {
  const open = SRC.indexOf('{', from);
  assert.notEqual(open, -1, `no block found for ${label}`);
  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${label}`);
}

/** Extract the balanced `{...}` literal that follows a marker. */
function blockAfter(marker) {
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, `marker not found in ais-relay.cjs: ${marker}`);
  return balancedBlockAt(start, marker);
}

/**
 * A function's BODY, skipping its parameter list — a destructured parameter
 * (`function f({ a, b } = {})`) opens a brace before the body does.
 */
function functionBody(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in ais-relay.cjs`);
  const paramsOpen = SRC.indexOf('(', start);
  let depth = 0;
  for (let i = paramsOpen; i < SRC.length; i += 1) {
    if (SRC[i] === '(') depth += 1;
    else if (SRC[i] === ')') {
      depth -= 1;
      if (depth === 0) return balancedBlockAt(i + 1, `body of ${name}`);
    }
  }
  throw new Error(`unbalanced parens in ${name} parameter list`);
}

test('the shared classifier really does collapse 401 and 403 — the premise for overriding it', () => {
  // If this ever stops being true the OpenSky override should be revisited, not kept
  // out of habit. 401 (bad credentials) and 403 (refused exit IP) imply opposite fixes.
  assert.equal(classifyUpstreamOutcome({ status: 401 }), 'authRejection');
  assert.equal(classifyUpstreamOutcome({ status: 403 }), 'authRejection');
  assert.equal(classifyUpstreamOutcome({ status: 429 }), 'throttle');
});

test('OPENSKY_ROUTE defaults to direct — the free route', () => {
  assert.match(
    SRC,
    /const OPENSKY_ROUTE_DEFAULT = 'direct';/,
    'The default route must stay `direct`. `proxy` costs ~$137/quarter of residential '
    + 'bandwidth and buys no OpenSky quota, because the quota is account-scoped.',
  );
});

test('the proxy route is gated on OPENSKY_ROUTE, not merely on a configured proxy string', () => {
  const gate = SRC.match(/const OPENSKY_PROXY_ENABLED = ([^;]+);/);
  assert.ok(gate, 'OPENSKY_PROXY_ENABLED declaration not found');
  assert.match(
    gate[1],
    /OPENSKY_ROUTE === 'proxy'/,
    'OPENSKY_PROXY_ENABLED reverted to keying off OPENSKY_PROXY_AUTH alone. PROXY_URL is '
    + 'set on ais-relay for other consumers, so that form silently re-enables the paid '
    + 'OpenSky route and there is no env-only way back to direct.',
  );
});

test('no automatic proxy fallback: OPENSKY_ROUTE is read once, never re-selected on failure', () => {
  const reads = SRC.match(/process\.env\.OPENSKY_ROUTE/g) || [];
  assert.equal(
    reads.length,
    1,
    `OPENSKY_ROUTE is read ${reads.length} times; expected exactly one (the module-level `
    + 'selection). A second read is how a per-request "retry through the proxy" cascade '
    + 'gets reintroduced — which would burn a second account credit per 429.',
  );
});

test('every OpenSky outcome is classified through classifyOpenSkyOutcome, not the shared classifier', () => {
  const leaked = SRC.match(/recordRelayOutcome\(\s*'opensky'\s*,\s*classifyUpstreamOutcome/g) || [];
  assert.equal(
    leaked.length,
    0,
    `${leaked.length} OpenSky call site(s) still classify through classifyUpstreamOutcome, `
    + 'which folds 403 into authRejection and hides the one signal that decides the route.',
  );
  const used = SRC.match(/classifyOpenSkyOutcome\(/g) || [];
  assert.ok(
    used.length >= 5,
    `Expected >= 5 classifyOpenSkyOutcome call sites (4 OpenSky sites + the definition); `
    + `found ${used.length}.`,
  );
});

test('classifyOpenSkyOutcome splits IP-level refusals out and delegates everything else', () => {
  const body = functionBody('classifyOpenSkyOutcome');
  assert.match(body, /status === 403/, '403 must map to routeRejection');
  assert.match(body, /status === 451/, '451 must map to routeRejection');
  assert.match(body, /return 'routeRejection'/, 'the routeRejection outcome must be returned');
  assert.match(
    body,
    /return classifyUpstreamOutcome\(/,
    'everything that is not an explicit origin refusal must delegate to the shared '
    + 'classifier, so OpenSky cannot drift from the other routes on 401/429/timeout.',
  );
  assert.doesNotMatch(
    body,
    /ECONNRESET|EPROTO/,
    'Socket errors are ordinary noise on either route (EPROTO was the #5074 double-TLS '
    + 'bug, not a block). Classifying them as routeRejection sends operators to flip the '
    + 'route over a transient blip.',
  );
});

test('routeRejection is wired for OpenSky only — other routes keep folding 403 into authRejection', () => {
  const fields = blockAfter('const RELAY_OUTCOME_FIELDS =');
  const openskyMap = blockAfter("  opensky: Object.freeze(");
  assert.match(openskyMap, /routeRejection: 'openskyRouteRejection'/);
  const allRouteRejections = fields.match(/routeRejection:/g) || [];
  assert.equal(
    allRouteRejections.length,
    1,
    'Only the opensky route may declare routeRejection. Adding it elsewhere silently '
    + 'moves 403s out of those routes\' authRejection counters.',
  );
});

// This would have caught a half-wired openskyRouteRejection: a counter present in the
// lifetime object but missing from the bucket factory or the rollup reads a constant
// zero, so the health surface reports "no IP rejections" whether or not there are any.
test('every rolling metric is declared in the bucket factory and summed in the rollup', () => {
  const keysOf = (blk) => new Set([...blk.matchAll(/^\s*(\w+):\s*0,/gm)].map((m) => m[1]));
  const lifetime = keysOf(blockAfter('const relayMetricsLifetime ='));
  const bucket = keysOf(blockAfter('function createRelayMetricsBucket()'));
  const rollup = new Set(
    [...SRC.matchAll(/rollup\.(\w+)\s*\+=\s*bucket\.(\w+)/g)]
      .filter((m) => m[1] === m[2])
      .map((m) => m[1]),
  );

  assert.ok(lifetime.has('openskyRouteRejection'), 'openskyRouteRejection must be a lifetime counter');
  assert.deepEqual([...lifetime].filter((k) => !bucket.has(k)), [], 'lifetime counters missing from createRelayMetricsBucket');
  assert.deepEqual([...lifetime].filter((k) => !rollup.has(k)), [], 'lifetime counters never summed into the rollup');
});

test('/health reports the selected route alongside the two blocked-for-different-reasons signals', () => {
  const aviation = blockAfter('    aviation: {');
  assert.match(aviation, /openskyRoute: OPENSKY_ROUTE/, 'operators must see which route is live');
  assert.match(aviation, /openskyRouteRejection: rollup\.openskyRouteRejection/, '403/451 → flip the route');
  assert.match(aviation, /openskyProviderBlocked/, '429 → the account is out of credits; no route change helps');
});
