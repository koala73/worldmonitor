// WORLDMONITOR-10R — the intel-history tools' own pre-flight rejection of an
// unusable `country` must reach the caller with the SAME contract the
// downstream handler's 400 would have produced: `-32602 Invalid params` plus
// `error.data.violations`, not the generic `-32603 Internal error: data fetch
// failed`.
//
// #7170 routed `country` through `normalizeCountry`, which only trims and
// uppercases — it fixed "ua" but not "Ukraine" or "USA", which still fail the
// request message's `^([A-Z]{2})?$` and still buy the 400 round-trip.
//
// A plain `Error` from `_execute` is worse than no check at all:
// `dispatchToolsCall`'s catch has no branch for one, so it is flattened into
// -32603, which an agent reads as transient and retries. WORLDMONITOR-10R
// recorded 13 `search_intel_history` calls from one IP in 40 seconds
// (2026-08-27T01:43:19Z → 01:43:58Z) against a deterministic validation
// failure.
//
// The sibling unscoped-read guard in `get_intel_timeline` (WORLDMONITOR-10Y)
// gets the same treatment in PR #7182; this suite deliberately leaves it alone
// so the two changes do not collide on one block.
//
// The second half locks the diagnosis path: `RpcValidationError` carries
// already-sanitized violations (bounded to 8, field names matched against
// `^[A-Za-z_][A-Za-z0-9_.]{0,63}$`) and hands them to the caller, but
// `downstreamErrorTags` dropped them — so WORLDMONITOR-10R could never name its
// failing field from Sentry alone, which is why the country fix in #7170 could
// not be confirmed or refuted against it.
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { dispatchToolsCall } from '../api/mcp/dispatch.ts';
import { RpcValidationError } from '../api/mcp/billing-denial.ts';
import { downstreamErrorTags } from '../api/mcp/downstream.ts';

const ORIGINAL_FETCH = globalThis.fetch;
process.env.MCP_TELEMETRY = 'false';

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  process.env.MCP_TELEMETRY = 'false';
});

async function callTool(name: string, args: unknown, fetchImpl?: typeof globalThis.fetch) {
  globalThis.fetch = fetchImpl ?? (async () => {
    throw new Error('unreachable: the local scope guard must reject before any fetch');
  });
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await dispatchToolsCall(
      new Request('http://localhost/mcp'),
      { kind: 'env_key', apiKey: 'test' },
      {},
      { id: 42, params: { name, arguments: args } },
      {},
    );
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
}

describe('get_intel_timeline country pre-flight (WORLDMONITOR-10R)', () => {
  it('rejects a country that is not ISO 3166-1 alpha-2 without a round-trip', async () => {
    // Positive control for the guard's other half: `normalizeCountry` only
    // trims + uppercases (#7170 fixed `"ua"`), so `"Ukraine"` still fails the
    // handler's `^([A-Z]{2})?$` and would otherwise buy a 400 round-trip.
    const res = await callTool('get_intel_timeline', { country: 'Ukraine' });
    const parsed = await res.json();
    assert.equal(parsed.error.code, -32602);
    const fields = parsed.error.data.violations.map((v: { field: string }) => v.field);
    assert.deepEqual(fields, ['country']);
  });

  it('does NOT fire when a valid scope is supplied', async () => {
    // Positive control: delete the country check and this goes red instead of
    // the suite staying green on absence alone.
    let fetched = false;
    const res = await callTool('get_intel_timeline', { domain: 'conflict' }, async () => {
      fetched = true;
      return new Response(
        JSON.stringify({ records: [], partial: false, upstreamUnavailable: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    assert.equal(fetched, true, 'a scoped read must still reach the handler');
    const parsed = await res.json();
    assert.equal(parsed.error, undefined);
  });

  it('accepts a lowercase country, so #7170 stays fixed', async () => {
    let fetched = false;
    await callTool('get_intel_timeline', { country: 'ua' }, async (input) => {
      fetched = true;
      assert.match(String(input), /country=UA\b/);
      return new Response(
        JSON.stringify({ records: [], partial: false, upstreamUnavailable: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    assert.equal(fetched, true);
  });
});

describe('search_intel_history country pre-flight (WORLDMONITOR-10R)', () => {
  it('rejects a non-alpha-2 country locally instead of paying the 400 round-trip', async () => {
    const res = await callTool('search_intel_history', { query: 'artillery near Kharkiv', country: 'USA' });
    const parsed = await res.json();
    assert.equal(parsed.error.code, -32602);
    const fields = parsed.error.data.violations.map((v: { field: string }) => v.field);
    assert.deepEqual(fields, ['country']);
  });

  it('does NOT fire for a valid country', async () => {
    let fetched = false;
    await callTool('search_intel_history', { query: 'artillery near Kharkiv', country: 'ua' }, async (_input, init) => {
      fetched = true;
      assert.equal(JSON.parse(String(init?.body)).country, 'UA');
      return new Response(
        JSON.stringify({ records: [], query: 'x', partial: false, upstreamUnavailable: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    assert.equal(fetched, true);
  });
});

describe('RpcValidationError Sentry tags (WORLDMONITOR-10R diagnosability)', () => {
  it('names the violated fields so the issue can be diagnosed from Sentry alone', () => {
    const tags = downstreamErrorTags(
      new RpcValidationError('search-intel-history', [
        { field: 'country', description: 'value does not match regex pattern `^([A-Z]{2})?$`' },
        { field: 'limit', description: 'value must be less than or equal to 64' },
      ]),
    );
    assert.equal(tags.downstream_error_code, 'rpc_validation');
    assert.equal(tags.downstream_operation, 'search-intel-history');
    assert.equal(
      tags.downstream_violation_fields,
      'country,limit',
      'without this the Sentry issue carries only `<operation> HTTP 400` and the failing field is unrecoverable',
    );
  });

  it('bounds the tag value so a long violation list cannot be truncated mid-field', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      field: `f${i}`.padEnd(60, 'x'),
      description: 'bad',
    }));
    const tags = downstreamErrorTags(new RpcValidationError('search-intel-history', many));
    assert.ok(
      tags.downstream_violation_fields.length <= 200,
      'Sentry truncates tag values past 200 chars; truncate on a field boundary ourselves',
    );
    assert.ok(
      !tags.downstream_violation_fields.endsWith(','),
      'a bounded list must not end on a dangling separator',
    );
  });
});
