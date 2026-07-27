import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { readChinaDecisionSignalWireContract } from '../scripts/lib/openapi-codegen.mjs';
import { validateChinaDecisionSignalSnapshot } from '../scripts/seed-china-decision-signals.mjs';
import { CHINA_DECISION_SIGNAL_GROUP_MANIFEST } from '../shared/china-decision-signal-manifest.ts';
import {
  CHINA_DECISION_PARITY_MANIFEST,
  CHINA_DECISION_PARITY_USER_AGENT,
  CHINA_DECISION_STRUCTURAL_CHECKS,
  auditChinaDecisionAccessGating,
  auditChinaDecisionStaticRegistrations,
  canonicalAccessSnapshot,
  isMainModule,
  parseChinaParityAuditArgs,
  probeChinaDecisionParity,
  resolveChinaParityExitCode,
} from '../scripts/audit-china-decision-parity.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const ROUTE = '/api/intelligence/v1/get-china-decision-signals';

describe('China decision-signal static and staging audit (#5580)', () => {
  it('pins all six domains across API, MCP, bootstrap, health, alerts, Railway, and docs', () => {
    const result = auditChinaDecisionStaticRegistrations(REPO_ROOT);
    assert.deepEqual(result.groupIds, [
      'macro',
      'policy-enforcement',
      'cross-strait-activity',
      'corporate-disclosures',
      'corridor-conditions',
      'activity-nowcast',
    ]);
    assert.equal(result.canonicalKey, 'intelligence:china-decision-signals:v1');
    assert.equal(result.seedMetaKey, 'seed-meta:intelligence:china-decision-signals');
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.deepEqual(
      CHINA_DECISION_PARITY_MANIFEST,
      CHINA_DECISION_SIGNAL_GROUP_MANIFEST,
    );
    assert.deepEqual(result.structuralCheckIds, [
      'gateway-cache-tier',
      'gateway-public-no-auth',
      'access-tier-composition',
      'access-tier-validator',
    ]);
  });

  it('returns a sanitized live probe without source payloads or credentials', async () => {
    const groups = CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => ({
      id: groupId,
      state: 'unavailable',
      reason: 'No reviewed source observation is available.',
      items: [],
      metadata: {},
    }));
    const canonical = {
      schemaVersion: 1,
      generatedAt: '2026-07-26T12:00:00Z',
      groups,
      access: {
        anonymous: 'bounded_public_summary',
        pro: 'same_provenance_via_mcp',
        operator: 'source_health_only',
      },
    };
    let tick = Date.parse('2026-07-26T12:00:00Z');
    const result = await probeChinaDecisionParity('https://staging.example', {
      now: () => ++tick,
      fetchImpl: async (url) => {
        if (String(url).includes('/api/bootstrap?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                chinaDecisionSignals: canonical,
              },
              missing: [],
            }),
          };
        }
        assert.equal(String(url), 'https://staging.example/api/intelligence/v1/get-china-decision-signals');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            payloadJson: JSON.stringify({
              ...canonical,
              apiKey: 'must-not-leak',
            }),
          }),
        };
      },
    });
    assert.deepEqual(result, {
      ok: true,
      route: '/api/intelligence/v1/get-china-decision-signals',
      bootstrapRoute: '/api/bootstrap?keys=chinaDecisionSignals&public=1',
      httpStatus: 200,
      bootstrapHttpStatus: 200,
      latencyMs: 1,
      bootstrapLatencyMs: 1,
      generatedAt: '2026-07-26T12:00:00Z',
      bootstrapGeneratedAt: '2026-07-26T12:00:00Z',
      groupStates: {
        macro: 'unavailable',
        'policy-enforcement': 'unavailable',
        'cross-strait-activity': 'unavailable',
        'corporate-disclosures': 'unavailable',
        'corridor-conditions': 'unavailable',
        'activity-nowcast': 'unavailable',
      },
      bootstrapGroupStates: {
        macro: 'unavailable',
        'policy-enforcement': 'unavailable',
        'cross-strait-activity': 'unavailable',
        'corporate-disclosures': 'unavailable',
        'corridor-conditions': 'unavailable',
        'activity-nowcast': 'unavailable',
      },
    });
    assert.doesNotMatch(JSON.stringify(result), /apiKey|private-document|must-not-leak/);
  });

  it('fails closed when staging returns malformed group states', async () => {
    const groups = CHINA_DECISION_PARITY_MANIFEST.map(({ groupId }) => ({
      id: groupId,
      state: groupId === 'macro' ? 'healthy' : 'unavailable',
      reason: null,
      items: [],
      metadata: {},
    }));
    const result = await probeChinaDecisionParity('https://staging.example', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            generatedAt: '2026-07-26T12:00:00Z',
            groups,
            access: {
              anonymous: 'bounded_public_summary',
              pro: 'same_provenance_via_mcp',
              operator: 'source_health_only',
            },
          }),
        }),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_contract');
    assert.equal(result.groupStates, undefined);
  });

  it('identifies the probe to Cloudflare so a keyless call is not challenged', async () => {
    // Cloudflare 403s Node fetch's default `node` User-Agent on both probed
    // routes, which is why the staging leg had never survived a real run (#5643).
    const seen = [];
    await probeChinaDecisionParity('https://staging.example', {
      fetchImpl: async (url, init) => {
        seen.push({ url: String(url), userAgent: init?.headers?.['User-Agent'] });
        return { ok: false, status: 503 };
      },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].userAgent, CHINA_DECISION_PARITY_USER_AGENT);
    assert.match(CHINA_DECISION_PARITY_USER_AGENT, /^worldmonitor-[\w-]+\/\d/);
  });
});

// Each row restores a real unwiring against the real source file and asserts
// two things: the substring check the audit used to rely on still passes, and
// the structural check does not. Without the first assertion these would be
// ordinary regression tests; with it they are the standing proof that presence
// of a token is not evidence of wiring (#5643).
const STRUCTURAL_MUTATIONS = [
  {
    checkId: 'gateway-cache-tier',
    name: 'the cache-tier entry is commented out',
    substringStillPresent: `'${ROUTE}': 'fast'`,
    mutate: (source) => source.replace(`\n  '${ROUTE}': 'fast',`, `\n  // '${ROUTE}': 'fast',`),
  },
  {
    checkId: 'gateway-cache-tier',
    name: 'the cache-tier entry moved out of RPC_CACHE_TIER into a dead object',
    substringStillPresent: `'${ROUTE}': 'fast'`,
    mutate: (source) => `${source.replace(`\n  '${ROUTE}': 'fast',`, '')}\nconst DEAD_TIER_NOTE = { '${ROUTE}': 'fast' };\n`,
  },
  {
    checkId: 'gateway-public-no-auth',
    name: 'the anonymous-access entry is commented out',
    substringStillPresent: `'${ROUTE}',`,
    mutate: (source) => source.replace(`\n  '${ROUTE}',`, `\n  // '${ROUTE}',`),
  },
  {
    checkId: 'gateway-public-no-auth',
    name: 'the anonymous-access entry moved out of the set into a dead array',
    substringStillPresent: `'${ROUTE}',`,
    mutate: (source) => `${source.replace(`\n  '${ROUTE}',`, '')}\nconst DEAD_PUBLIC_NOTE = [\n  '${ROUTE}',\n];\n`,
  },
  {
    checkId: 'access-tier-composition',
    name: 'the composed anonymous tier is commented out',
    substringStillPresent: 'bounded_public_summary',
    mutate: (source) => source.replace(
      "\n      anonymous: 'bounded_public_summary',",
      "\n      // anonymous: 'bounded_public_summary',",
    ),
  },
  {
    checkId: 'access-tier-validator',
    name: 'the validator stops rejecting a wrong anonymous tier',
    substringStillPresent: 'bounded_public_summary',
    mutate: (source) => source.replace("\n    || access?.anonymous !== 'bounded_public_summary'", ''),
  },
];

describe('China decision-signal structural wiring checks (#5643)', () => {
  const sources = new Map();
  const sourceFor = (file) => {
    if (!sources.has(file)) sources.set(file, readFileSync(resolve(REPO_ROOT, file), 'utf8'));
    return sources.get(file);
  };

  it('covers every structural check with at least one mutation', () => {
    const covered = new Set(STRUCTURAL_MUTATIONS.map(({ checkId }) => checkId));
    for (const check of CHINA_DECISION_STRUCTURAL_CHECKS) {
      assert.ok(covered.has(check.id), `structural check ${check.id} has no mutation row`);
    }
  });

  for (const check of CHINA_DECISION_STRUCTURAL_CHECKS) {
    it(`passes against the real ${check.file} for ${check.id}`, () => {
      assert.equal(check.verify(sourceFor(check.file)), null, check.intent);
    });

    it(`fails closed when ${check.file} loses its container for ${check.id}`, () => {
      const failure = check.verify('export const somethingElse = 1;\n');
      assert.ok(typeof failure === 'string' && failure.length > 0);
    });
  }

  for (const mutation of STRUCTURAL_MUTATIONS) {
    it(`catches an unwiring the old substring check missed: ${mutation.name}`, () => {
      const check = CHINA_DECISION_STRUCTURAL_CHECKS.find(({ id }) => id === mutation.checkId);
      assert.ok(check, `unknown structural check ${mutation.checkId}`);

      const original = sourceFor(check.file);
      const mutated = mutation.mutate(original);
      assert.notEqual(mutated, original, 'the mutation did not apply — this test would be vacuous');

      assert.ok(
        mutated.includes(mutation.substringStillPresent),
        'the mutation must leave the substring behind, otherwise it proves nothing about substring checks',
      );
      assert.equal(check.verify(original), null, 'the unmutated source must pass');
      assert.ok(
        typeof check.verify(mutated) === 'string',
        `${check.id} accepted a source where the wiring is gone`,
      );
    });
  }

  it('reads the returned snapshot access block, not an earlier lookalike local', () => {
    // The dangerous direction is a false PASS: a refactor that introduces an
    // earlier `access` local with correct-looking tiers would satisfy a check
    // anchored on the first `access:` token in the function, while the tiers
    // actually stamped onto the published snapshot are wrong.
    const check = CHINA_DECISION_STRUCTURAL_CHECKS.find(({ id }) => id === 'access-tier-composition');
    const original = sourceFor(check.file);

    // A type annotation is what makes this bite: `const access:` contains the
    // bare `access:` token an anchor-on-first-occurrence check keys on. Anchor
    // the insertion to composeChinaDecisionSignals itself — the return-type
    // signature alone also matches an earlier helper, and a decoy that lands
    // outside the composed body proves nothing.
    const composeSignature = 'export function composeChinaDecisionSignals(\n'
      + '  input: ComposeChinaDecisionSignalsInput,\n'
      + '): ChinaDecisionSignalSnapshot {\n';
    assert.ok(original.includes(composeSignature), 'compose signature moved — update this mutation');
    const decoy = `${composeSignature}  const access: ChinaDecisionSignalSnapshot['access'] = {\n`
      + "    anonymous: 'bounded_public_summary',\n"
      + "    pro: 'same_provenance_via_mcp',\n"
      + "    operator: 'source_health_only',\n"
      + '  };\n';
    const mutated = original
      .replace(composeSignature, decoy)
      .replace("\n      anonymous: 'bounded_public_summary',", "\n      anonymous: 'unrestricted',");

    assert.notEqual(mutated, original, 'the mutation did not apply — this test would be vacuous');
    assert.ok(mutated.includes("anonymous: 'unrestricted'"), 'the published tier must actually be broken');
    assert.ok(
      mutated.includes("    anonymous: 'bounded_public_summary',"),
      'the decoy must still supply a correct-looking earlier access block',
    );
    assert.ok(
      typeof check.verify(mutated) === 'string',
      'a correct-looking earlier access local must not mask a wrong published tier',
    );
  });

  it('proves the published-snapshot validator rejects every downgraded access tier', () => {
    assert.deepEqual(auditChinaDecisionAccessGating(), []);
  });

  it('reports a finding when the validator has not learned a bumped schema version', () => {
    // Both sides of that truth table used to hardcode 1: the fixture and
    // validateChinaDecisionSignalSnapshot's own `schemaVersion === 1`. Bumping
    // CHINA_DECISION_SIGNAL_SCHEMA_VERSION without teaching the validator would
    // then leave it rejecting every real published snapshot while this audit,
    // testing a fixture pinned to the old version, still reported a clean
    // table — a silent production break.
    //
    // Today's contract version and the validator's literal are both 1, so
    // reading the default proves nothing; building the fixture one version
    // ahead reproduces the post-bump world. This row goes red if the fixture is
    // ever re-hardcoded, because the stale validator would then accept it.
    const { schemaVersion } = readChinaDecisionSignalWireContract();
    assert.ok(Number.isInteger(schemaVersion) && schemaVersion >= 1);
    assert.equal(canonicalAccessSnapshot().schemaVersion, schemaVersion);

    assert.deepEqual(auditChinaDecisionAccessGating(schemaVersion), []);
    assert.deepEqual(
      auditChinaDecisionAccessGating(schemaVersion + 1),
      ['the published-snapshot validator rejects the canonical access block'],
      'a contract version the validator does not accept must read as a finding',
    );
  });
});

describe('China decision-signal audit CLI (#5643)', () => {
  it('parses a live probe request', () => {
    assert.deepEqual(parseChinaParityAuditArgs(['--url', 'https://staging.example']), {
      url: 'https://staging.example',
      requireLive: false,
      error: null,
    });
    assert.deepEqual(parseChinaParityAuditArgs(['--require-live', '--url', 'https://staging.example']), {
      url: 'https://staging.example',
      requireLive: true,
      error: null,
    });
    assert.deepEqual(parseChinaParityAuditArgs([]), { url: null, requireLive: false, error: null });
  });

  it('refuses probe targets that are not public https endpoints', () => {
    for (const url of [
      'http://www.worldmonitor.app',
      'https://localhost/api',
      'https://127.0.0.1',
      'https://[::1]',
      'https://169.254.169.254',
      'https://10.0.0.5',
      'https://172.16.4.2',
      'https://192.168.1.1',
      'https://metadata.google.internal',
      'not-a-url',
    ]) {
      const parsed = parseChinaParityAuditArgs(['--url', url]);
      assert.ok(parsed.error, `expected ${url} to be rejected`);
      assert.equal(parsed.url, null);
    }
  });

  it('accepts ordinary public probe targets', () => {
    for (const url of ['https://www.worldmonitor.app', 'https://api-staging.example', 'https://staging.example:8443/base']) {
      const parsed = parseChinaParityAuditArgs(['--url', url]);
      assert.equal(parsed.error, null, `expected ${url} to be accepted`);
      assert.equal(parsed.url, url);
    }
  });

  it('refuses argument shapes that would silently skip the live probe', () => {
    // Each of these would have run the static half only and exited 0 before
    // --require-live existed, reporting a staging audit that never happened.
    for (const args of [['--url'], ['--url', '--require-live'], ['--require-live'], ['--require_live', '--url', 'https://x']]) {
      const parsed = parseChinaParityAuditArgs(args);
      assert.ok(parsed.error, `expected an error for ${JSON.stringify(args)}`);
      assert.equal(parsed.url, null);
      assert.equal(parsed.requireLive, false);
    }
  });

  it('still runs when the checkout is reached through a symlink', () => {
    // Node sets import.meta.url to the real path but leaves argv[1] as typed,
    // so the usual `import.meta.url === pathToFileURL(argv[1]).href` guard
    // no-ops through a symlink: exit 0, zero output, indistinguishable from a
    // clean audit. `/tmp` -> `/private/tmp` on macOS makes that a normal way to
    // invoke a script, not a corner case.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'parity-mainguard-')));
    const realDir = join(base, 'real');
    mkdirSync(realDir);
    const realScript = join(realDir, 'audit.mjs');
    writeFileSync(realScript, '// fixture\n');
    symlinkSync(realDir, join(base, 'link'), 'dir');
    const symlinkedScript = join(base, 'link', 'audit.mjs');

    const moduleUrl = pathToFileURL(realScript).href;
    assert.notEqual(
      moduleUrl,
      pathToFileURL(symlinkedScript).href,
      'the symlinked path must differ, otherwise this test proves nothing',
    );
    assert.equal(isMainModule(moduleUrl, symlinkedScript), true);
    assert.equal(isMainModule(moduleUrl, realScript), true);
    assert.equal(isMainModule(moduleUrl, join(realDir, 'other.mjs')), false);
    assert.equal(isMainModule(moduleUrl, undefined), false);
    assert.equal(isMainModule(moduleUrl, ''), false);
  });

  it('degrades to a plain path comparison instead of skipping main on error', () => {
    // realpathSync throws on a path that does not resolve. Answering `false`
    // there would put the audit right back where it started: exit 0, no
    // output, indistinguishable from a clean run.
    const unresolvable = join(realpathSync(tmpdir()), 'wm-parity-does-not-exist', 'audit.mjs');
    const moduleUrl = pathToFileURL(unresolvable).href;
    assert.equal(isMainModule(moduleUrl, unresolvable), true, 'identical unresolvable paths must still run main');
    assert.equal(isMainModule(moduleUrl, join(realpathSync(tmpdir()), 'wm-parity-does-not-exist', 'other.mjs')), false);
  });

  it('resolves exit codes so a missing live probe fails the gate', () => {
    const table = [
      [{ staticOk: true }, 0],
      [{ staticOk: false }, 1],
      [{ staticOk: true, live: { ok: true } }, 0],
      [{ staticOk: true, live: { ok: false } }, 1],
      [{ staticOk: false, live: { ok: true } }, 1],
      [{ staticOk: true, live: null, requireLive: true }, 1],
      [{ staticOk: true, live: { ok: true }, requireLive: true }, 0],
      [{ staticOk: true, live: { ok: false }, requireLive: true }, 1],
    ];
    for (const [outcome, expected] of table) {
      assert.equal(
        resolveChinaParityExitCode(outcome),
        expected,
        `expected exit ${expected} for ${JSON.stringify(outcome)}`,
      );
    }
  });
});
