/**
 * Operator retraction CLI (#5743).
 *
 * The argument rules here decide whether an intelligence record is deleted
 * from a durable, agent-facing archive, so they are tested as logic rather
 * than exercised by hand: a flag that silently swallows the next flag as its
 * value would record "--dry-run" as the audit reason for a deletion, and a
 * `--restore` that accepted a document id would send a request that can never
 * resolve.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  RETRACT_MAX_IDENTIFIERS,
  parseRetractArgs,
  resolveRetractTarget,
  runRetractCli,
} from '../scripts/retract-intel-history.mjs';

const ENV = {
  CONVEX_SITE_URL: 'https://example-deployment.convex.site',
  RELAY_RETRACT_SECRET: 'relay-secret',
};

/** Capture the outgoing request without touching the network. */
function stubFetch({ status = 200, body = { deleted: 1, tombstoned: 1 } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { fetchImpl, calls };
}

describe('parseRetractArgs', () => {
  it('builds a retract payload from mixed ids and dedupe keys', () => {
    const parsed = parseRetractArgs([
      '--id',
      'doc-1',
      '--dedupe-key',
      'energy:intelligence:abc',
      '--id',
      'doc-2',
      '--reason',
      '  poisoned RSS item, #5743  ',
    ]);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'retract');
    assert.deepEqual(parsed.payload, {
      ids: ['doc-1', 'doc-2'],
      dedupeKeys: ['energy:intelligence:abc'],
      reason: 'poisoned RSS item, #5743',
    });
  });

  it('requires a reason when retracting', () => {
    const parsed = parseRetractArgs(['--dedupe-key', 'k']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--reason is required/);
  });

  it('requires at least one identifier', () => {
    const parsed = parseRetractArgs(['--reason', 'why']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /at least one --id or --dedupe-key/);
  });

  // A flag-shaped value is the failure that matters: `--reason --dry-run`
  // would otherwise retract for the stated reason "--dry-run" AND send the
  // request the operator meant to preview.
  for (const argv of [
    ['--reason'],
    ['--reason', '--dry-run', '--dedupe-key', 'k'],
    ['--dedupe-key', '--reason', 'why'],
    ['--id'],
  ]) {
    it(`rejects a missing or flag-shaped value: ${JSON.stringify(argv)}`, () => {
      const parsed = parseRetractArgs(argv);
      assert.equal(parsed.ok, false);
      assert.match(parsed.error, /requires a value/);
    });
  }

  it('rejects more identifiers than the relay accepts in one call', () => {
    const argv = [];
    for (let i = 0; i <= RETRACT_MAX_IDENTIFIERS; i++) {
      argv.push('--dedupe-key', `k-${i}`);
    }
    argv.push('--reason', 'sweep');

    const parsed = parseRetractArgs(argv);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /at most 100 identifiers/);
  });

  it('rejects an identifier with leading or trailing whitespace', () => {
    // Caught at the CLI so a copy-paste typo is an actionable message rather
    // than a 400 — and never a request that tombstones the typo and reports
    // success while the real record stays live.
    for (const argv of [
      ['--dedupe-key', ' energy:intelligence:abc', '--reason', 'r'],
      ['--dedupe-key', 'energy:intelligence:abc ', '--reason', 'r'],
      ['--id', ' abc', '--reason', 'r'],
    ]) {
      const parsed = parseRetractArgs(argv);
      assert.equal(parsed.ok, false, `${JSON.stringify(argv)} must be rejected`);
      assert.match(parsed.error, /leading or trailing whitespace/);
    }
  });

  it('rejects --list combined with retraction arguments', () => {
    // --list used to win outright, so this listed the tombstones and exited 0
    // having retracted nothing.
    const parsed = parseRetractArgs(['--list', '--dedupe-key', 'k', '--reason', 'r']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--list cannot be combined with/);

    const limitOutsideList = parseRetractArgs(['--dedupe-key', 'k', '--reason', 'r', '--limit', '5']);
    assert.equal(limitOutsideList.ok, false);
    assert.match(limitOutsideList.error, /--limit applies to --list only/);
  });

  it('rejects an unknown flag rather than ignoring it', () => {
    const parsed = parseRetractArgs(['--purge-all', '--reason', 'x']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /unknown argument: --purge-all/);
  });

  it('builds a restore payload from dedupe keys alone', () => {
    const parsed = parseRetractArgs(['--restore', '--dedupe-key', 'k1', '--dedupe-key', 'k2']);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.mode, 'restore');
    assert.deepEqual(parsed.payload, { dedupeKeys: ['k1', 'k2'] });
  });

  it('rejects --restore with a document id, which cannot resolve', () => {
    const parsed = parseRetractArgs(['--restore', '--id', 'doc-1']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--dedupe-key only/);
  });

  it('parses a bounded list request', () => {
    assert.deepEqual(parseRetractArgs(['--list']), {
      ok: true,
      mode: 'list',
      payload: {},
      dryRun: false,
    });
    assert.deepEqual(parseRetractArgs(['--list', '--limit', '5']).payload, { limit: 5 });

    for (const bad of ['0', '-3', '2.5', 'many']) {
      const parsed = parseRetractArgs(['--list', '--limit', bad]);
      assert.equal(parsed.ok, false, `--limit ${bad} must be rejected`);
      assert.match(parsed.error, /positive integer/);
    }
  });

  it('rejects --list combined with --restore', () => {
    const parsed = parseRetractArgs(['--list', '--restore']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /mutually exclusive/);
  });

  it('treats --help as a success, not a usage failure', async () => {
    const { code, lines } = await runRetractCli(['--help'], { env: ENV });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Usage:/);
  });
});

describe('resolveRetractTarget', () => {
  it('derives the site URL from CONVEX_URL and trims trailing slashes', () => {
    const target = resolveRetractTarget({
      CONVEX_URL: 'https://example-deployment.convex.cloud/',
      RELAY_RETRACT_SECRET: 's',
    });
    assert.equal(target.ok, true);
    assert.equal(target.siteUrl, 'https://example-deployment.convex.site');
  });

  it('names every missing variable at once', () => {
    const target = resolveRetractTarget({});
    assert.equal(target.ok, false);
    assert.deepEqual(target.missing, [
      'CONVEX_SITE_URL (or CONVEX_URL)',
      'RELAY_RETRACT_SECRET',
    ]);
  });

  it('requires the retraction-scoped secret and ignores the seeder fleet secret', () => {
    const both = resolveRetractTarget({
      CONVEX_SITE_URL: ENV.CONVEX_SITE_URL,
      RELAY_SHARED_SECRET: 'fleet-secret',
      RELAY_RETRACT_SECRET: 'retract-only-secret',
    });
    assert.equal(both.secret, 'retract-only-secret');

    const fleetOnly = resolveRetractTarget({
      CONVEX_SITE_URL: ENV.CONVEX_SITE_URL,
      RELAY_SHARED_SECRET: 'fleet-secret',
    });
    assert.equal(fleetOnly.ok, false);
    assert.deepEqual(fleetOnly.missing, ['RELAY_RETRACT_SECRET']);
  });
});

describe('runRetractCli', () => {
  it('posts a retraction to the retract route with the bearer secret', async () => {
    const { fetchImpl, calls } = stubFetch();

    const { code, lines } = await runRetractCli(
      ['--dedupe-key', 'energy:intelligence:abc', '--reason', 'poisoned'],
      { env: ENV, fetchImpl },
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://example-deployment.convex.site/relay/intel-history/retract',
    );
    assert.equal(calls[0].init.headers.Authorization, 'Bearer relay-secret');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      ids: [],
      dedupeKeys: ['energy:intelligence:abc'],
      reason: 'poisoned',
    });
    assert.match(lines.join('\n'), /"tombstoned": 1/);
    // An operator who re-queries immediately will still see the record; if the
    // tool does not say why, the obvious read is "the retraction failed".
    assert.match(lines.join('\n'), /Allow ~1 hour/);
  });

  it('does not print the cache caveat on restore or list', async () => {
    for (const argv of [['--restore', '--dedupe-key', 'k'], ['--list']]) {
      const { fetchImpl } = stubFetch({ body: { removed: 1, notRetracted: [] } });
      const { lines } = await runRetractCli(argv, { env: ENV, fetchImpl });
      assert.doesNotMatch(lines.join('\n'), /Allow ~1 hour/);
    }
  });

  it('routes --restore and --list to their own paths', async () => {
    for (const [argv, path] of [
      [['--restore', '--dedupe-key', 'k'], '/relay/intel-history/restore'],
      [['--list'], '/relay/intel-history/retractions'],
    ]) {
      const { fetchImpl, calls } = stubFetch({ body: { removed: 1, notRetracted: [] } });
      const { code } = await runRetractCli(argv, { env: ENV, fetchImpl });
      assert.equal(code, 0);
      assert.equal(calls[0].url, `https://example-deployment.convex.site${path}`);
      assert.equal(
        calls[0].init.headers['User-Agent'],
        'worldmonitor-retract-intel-history/1.0',
      );
    }
  });

  it('exits non-zero when restore leaves requested keys untouched', async () => {
    const { fetchImpl } = stubFetch({
      body: { removed: 1, notRetracted: ['missing-key'] },
    });
    const { code, lines } = await runRetractCli(
      ['--restore', '--dedupe-key', 'restored-key', '--dedupe-key', 'missing-key'],
      { env: ENV, fetchImpl },
    );

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /missing-key/);
    assert.match(lines.join('\n'), /partial/);
  });

  it('sends nothing on --dry-run', async () => {
    const { fetchImpl, calls } = stubFetch();

    const { code, lines } = await runRetractCli(
      ['--dedupe-key', 'k', '--reason', 'why', '--dry-run'],
      { env: ENV, fetchImpl },
    );

    assert.equal(code, 0);
    assert.equal(calls.length, 0, 'a dry run must not reach the relay');
    assert.match(lines.join('\n'), /\[dry-run\] POST \/relay\/intel-history\/retract/);
  });

  it('fails before sending when the environment is incomplete', async () => {
    const { fetchImpl, calls } = stubFetch();

    const { code, lines } = await runRetractCli(['--dedupe-key', 'k', '--reason', 'why'], {
      env: { CONVEX_SITE_URL: ENV.CONVEX_SITE_URL },
      fetchImpl,
    });

    assert.equal(code, 1);
    assert.equal(calls.length, 0);
    assert.match(lines.join('\n'), /RELAY_RETRACT_SECRET/);
  });

  it('surfaces a relay rejection as a non-zero exit with the body', async () => {
    const { fetchImpl } = stubFetch({ status: 400, body: { error: 'MISSING_REASON' } });

    const { code, lines } = await runRetractCli(['--dedupe-key', 'k', '--reason', 'why'], {
      env: ENV,
      fetchImpl,
    });

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /HTTP 400/);
    assert.match(lines.join('\n'), /MISSING_REASON/);
  });

  it('treats an unparseable 200 as a failure, not a completed retraction', async () => {
    // A 200 whose body will not parse is a proxy/gateway interstitial in front
    // of the Convex site domain. Exiting 0 would let a scripted
    // `retract ... || alert` report success for a request that never landed.
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '<html>gateway error</html>' };
    };

    const { code, lines } = await runRetractCli(['--dedupe-key', 'k', '--reason', 'why'], {
      env: ENV,
      fetchImpl,
    });

    assert.equal(code, 1);
    assert.match(lines.join('\n'), /UNPARSEABLE_RESPONSE/);
    assert.doesNotMatch(lines.join('\n'), /Allow ~1 hour/, 'no reassurance on a failed request');
  });

  it('returns its failure result when the request itself throws', async () => {
    // DNS failure, connection reset, or AbortSignal.timeout firing. Without a
    // catch this escapes as an unhandled rejection and the operator gets a
    // stack trace instead of the exit code the tool exists to return.
    for (const err of [new Error('getaddrinfo ENOTFOUND'), new DOMException('t', 'TimeoutError')]) {
      const fetchImpl = async () => { throw err; };
      const { code, lines } = await runRetractCli(
        ['--dedupe-key', 'k', '--reason', 'why'],
        { env: ENV, fetchImpl },
      );
      assert.equal(code, 1);
      assert.match(lines.join('\n'), /request failed:/);
    }
  });

  it('warns loudly about ids that resolved to nothing', async () => {
    // A mixed batch succeeds while leaving those identities unsuppressed, and
    // the cache note would otherwise be the last thing the operator reads.
    const { fetchImpl } = stubFetch({
      body: { deleted: 1, tombstoned: 1, refreshed: 0, keys: ['k'], unresolvedIds: ['gone-1'] },
    });

    const { code, lines } = await runRetractCli(
      ['--id', 'gone-1', '--dedupe-key', 'k', '--reason', 'mixed'],
      { env: ENV, fetchImpl },
    );

    const out = lines.join('\n');
    // Non-zero: a partial application left named identities unsuppressed, and
    // a scripted `retract ... || alert` must not stay silent on that.
    assert.equal(code, 1);
    assert.match(out, /FAILED: 1 id\(s\) did not resolve and were NOT tombstoned/);
    assert.match(out, /gone-1/);
    assert.match(out, /partial/i);
  });

  it('tells the operator when the retraction list was truncated', async () => {
    const { fetchImpl } = stubFetch({ body: { retractions: [{ dedupeKey: 'a' }], partial: true } });
    const { lines } = await runRetractCli(['--list', '--limit', '1'], { env: ENV, fetchImpl });
    assert.match(lines.join('\n'), /raise --limit/);
  });
});
