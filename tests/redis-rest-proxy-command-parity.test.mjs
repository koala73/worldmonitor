// #6937: EXECUTE the proxy's command gate, do not describe it.
//
// The first cut of this file regex-scraped ALLOWED_COMMANDS out of the proxy
// and diffed it against strings scraped from one digest file. That shape is
// the exact anti-pattern tests/digest-lastgood-script.test.mjs names: two
// source scrapes agreeing proves nothing about the decision the proxy makes.
// Concretely it was wrong three ways — it modelled ALLOWED_COMMANDS as the
// whole acceptance rule (missing the deliberate pinned-script path, so it
// reported EVAL as a parity violation and invited the reader to "fix" that by
// allowlisting arbitrary Lua), it read 1 of 79 proxy-facing files, and with no
// positive control it passed vacuously whenever either regex stopped matching.
//
// This version extracts the proxy's real assertCommandAllowed — the single
// authorization decision both /pipeline and /multi-exec now route through —
// and runs commands through it, the same extract-and-eval harness
// tests/redis-rest-proxy-url-masking.test.mjs uses for maskRedisUrl. The proxy
// connects to Redis and listens at import time, so it cannot be imported.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPEND_HISTORY_LUA,
  PUBLISH_PHYSICAL_PREMIUM_LUA,
  PUBLISH_DIVERGENCE_LUA,
} from '../scripts/seed-physical-premiums.mjs';
import {
  RESERVE_LUA,
  SETTLE_LUA,
  ACK_RECEIPTS_LUA,
  STATUS_LUA,
} from '../scripts/lib/x-post-budget.cjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const proxyPath = resolve(repoRoot, 'docker/redis-rest-proxy.mjs');
const proxySrc = readFileSync(proxyPath, 'utf8');

// Pull the real gate plus everything it closes over. Each piece is asserted
// present below, so a rename or a move reds this file loudly instead of
// silently degrading into "nothing is allowed" or "nothing is emitted".
function extract(pattern, label) {
  const hit = proxySrc.match(pattern)?.[0];
  assert.ok(hit, `${label} not found in docker/redis-rest-proxy.mjs`);
  return hit;
}

const allowedCommandsSrc = extract(/const ALLOWED_COMMANDS = new Set\(\[[\s\S]*?\]\);/, 'ALLOWED_COMMANDS');
const scriptConstsSrc = [...proxySrc.matchAll(/const [A-Z_]+_SCRIPT = \[[\s\S]*?\]\.join\('\\n'\);/g)].map((m) => m[0]);
const allowedEvalSrc = extract(/const ALLOWED_EVAL_SCRIPTS = new Set\(\[[\s\S]*?\]\);/, 'ALLOWED_EVAL_SCRIPTS');
const legacyReplacementsSrc = extract(/const LEGACY_EVAL_REPLACEMENTS = new Map\(\[[\s\S]*?\]\);/, 'LEGACY_EVAL_REPLACEMENTS');
const isAllowedEvalSrc = extract(/function isAllowedEval\([\s\S]*?\n\}/, 'isAllowedEval');
const assertAllowedSrc = extract(/function assertCommandAllowed\([\s\S]*?\n\}/, 'assertCommandAllowed');
const commandForExecutionSrc = extract(/function commandForExecution\([\s\S]*?\n\}/, 'commandForExecution');

function buildGate() {
  // eslint-disable-next-line no-new-func
  return new Function(`
    const console = { error() {}, warn() {}, log() {} };
    ${allowedCommandsSrc}
    ${scriptConstsSrc.join('\n')}
    ${allowedEvalSrc}
    ${legacyReplacementsSrc}
    ${isAllowedEvalSrc}
    ${assertAllowedSrc}
    ${commandForExecutionSrc}
    return {
      assertCommandAllowed,
      commandForExecution,
      ALLOWED_COMMANDS,
      ALLOWED_EVAL_SCRIPTS,
      X_POST_BUDGET_RESERVE_SCRIPT,
      X_POST_BUDGET_STATUS_SCRIPT,
      LEGACY_X_POST_BUDGET_RESERVE_SCRIPT,
      LEGACY_X_POST_BUDGET_STATUS_SCRIPT,
    };
  `)();
}

const accepts = (gate, args) => {
  try {
    gate.assertCommandAllowed(args);
    return true;
  } catch {
    return false;
  }
};

// A Redis command array is [CMD, <key expression>, ...]. A label/enum/country
// tuple is [ 'AAA', 'BBB', ... ] — every element a quoted literal. Requiring
// the second element to be something other than a quoted string separates the
// two: across the 79 proxy-facing files that discriminator drops 55 false
// positives (BTC, NATO, CROSS_SOURCE_SIGNAL_TYPE_*) while dropping zero real
// commands. Verify that claim before relaxing it.
const COMMAND_ARRAY = /\[\s*'([A-Z][A-Z0-9]{1,20})'\s*,\s*([^'"\s])/g;

// Tokens the discriminator cannot distinguish from a command. Keep this tiny
// and justified — the test below proves nothing here is a real command, so an
// entry can never quietly mask a genuine parity gap.
const NOT_COMMANDS = new Set([
  'INFORM', // scripts/validate-resilience-correlation.mjs: ['INFORM', informResult] label tuple
]);

// Every file that reaches the proxy, not just the news digest. Tests are
// excluded: they assert against stubs and legitimately name blocked commands.
function proxyFacingFiles() {
  const out = execFileSync(
    'grep',
    ['-rl', '-e', 'runRedisPipeline', '-e', 'runRedisTransaction', '-e', '/pipeline', '-e', '/multi-exec',
      'server', 'scripts', 'shared', 'api'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return out.trim().split('\n').filter(Boolean).filter((f) => !/__tests__|\.test\.|(^|\/)tests\//.test(f));
}

function emittedCommands() {
  const byCommand = new Map();
  for (const file of proxyFacingFiles()) {
    let src;
    try {
      src = readFileSync(resolve(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const [, command] of src.matchAll(COMMAND_ARRAY)) {
      if (NOT_COMMANDS.has(command)) continue;
      if (!byCommand.has(command)) byCommand.set(command, new Set());
      byCommand.get(command).add(file);
    }
  }
  return byCommand;
}

describe('redis-rest-proxy command gate', () => {
  it('exposes one shared gate that both request paths route through', () => {
    // The divergence this replaced: /multi-exec had its own bare
    // ALLOWED_COMMANDS.has() check, so a command added to the Set ran there
    // without the pinned-script branch runCommand enforces.
    assert.match(proxySrc, /client\.sendCommand\(commandForExecution\(args\)\)/,
      'runCommand must delegate to the shared command gate');
    assert.match(proxySrc, /multi\.sendCommand\(commandForExecution\(cmd\)\)/,
      'the /multi-exec handler must delegate to the shared command gate');
    assert.doesNotMatch(proxySrc, /if \(!ALLOWED_COMMANDS\.has\(cmdName\)\)/,
      '/multi-exec must not re-implement the allowlist check');
  });

  it('accepts every Redis command the platform actually sends', () => {
    const gate = buildGate();
    const emitted = emittedCommands();

    // Positive controls. Without these the assertion below is vacuously true
    // the moment either extraction stops matching.
    assert.ok(gate.ALLOWED_COMMANDS.size > 40,
      `expected a populated allowlist, got ${gate.ALLOWED_COMMANDS.size}`);
    assert.ok(emitted.size >= 30,
      `expected to find the platform's Redis commands, got ${emitted.size}`);
    for (const anchor of ['HSET', 'HSETNX', 'HINCRBY', 'ZADD', 'ZREMRANGEBYSCORE', 'EVAL']) {
      assert.ok(emitted.has(anchor), `scan lost a known-emitted command: ${anchor}`);
    }

    const rejected = [...emitted]
      // EVAL is authorized by script text, not by name; the dedicated case below
      // covers it. Rejecting it here is what pushed the previous version toward
      // allowlisting arbitrary Lua.
      .filter(([command]) => command !== 'EVAL')
      .filter(([command]) => !accepts(gate, [command, 'k']))
      .map(([command, files]) => `${command} (${[...files].sort().join(', ')})`)
      .sort();

    assert.deepEqual(rejected, [],
      'these commands are sent to the proxy but rejected by it; add them to ALLOWED_COMMANDS only after reviewing blast radius');
  });

  it('still blocks the dangerous commands the allowlist exists for', () => {
    // Negative control. An absence-only parity check stays green when the
    // allowlist is widened to anything at all, including these.
    const gate = buildGate();
    for (const dangerous of [
      'FLUSHALL', 'FLUSHDB', 'CONFIG', 'DEBUG', 'SLAVEOF', 'REPLICAOF',
      'SHUTDOWN', 'SCRIPT', 'EVALSHA', 'ACL', 'MODULE', 'MIGRATE', 'RESET', 'CLIENT',
    ]) {
      assert.equal(accepts(gate, [dangerous, 'k']), false, `${dangerous} must stay blocked`);
    }
  });

  it('admits a pinned script but never an arbitrary one', () => {
    const gate = buildGate();
    const pinned = [...gate.ALLOWED_EVAL_SCRIPTS];
    assert.ok(pinned.length >= 1, 'the proxy must pin at least one script');
    assert.equal(accepts(gate, ['EVAL', pinned[0], '1', 'k']), true,
      'a pinned script must be accepted');
    assert.equal(accepts(gate, ['EVAL', "redis.call('FLUSHALL')", '0']), false,
      'an unpinned script must be rejected');
    assert.equal(accepts(gate, ['EVAL']), false, 'EVAL with no script must be rejected');
  });

  it('pins the physical-premium history append by exact bytes', () => {
    const gate = buildGate();
    assert.equal(gate.ALLOWED_EVAL_SCRIPTS.has(APPEND_HISTORY_LUA), true);
    assert.equal(accepts(gate, ['EVAL', APPEND_HISTORY_LUA, '1', 'history']), true);
    assert.equal(
      accepts(gate, ['EVAL', `${APPEND_HISTORY_LUA} `, '1', 'history']),
      false,
      'a one-character script variant must stay blocked',
    );
  });

  it('pins the atomic physical-premium publication by exact bytes', () => {
    const gate = buildGate();
    assert.equal(gate.ALLOWED_EVAL_SCRIPTS.has(PUBLISH_PHYSICAL_PREMIUM_LUA), true);
    assert.equal(
      accepts(gate, ['EVAL', PUBLISH_PHYSICAL_PREMIUM_LUA, '2', 'snapshot', 'activation']),
      true,
    );
    assert.equal(
      accepts(gate, ['EVAL', `${PUBLISH_PHYSICAL_PREMIUM_LUA} `, '2', 'snapshot', 'activation']),
      false,
    );
  });

  it('pins the physical-divergence publication by exact bytes', () => {
    const gate = buildGate();
    assert.equal(gate.ALLOWED_EVAL_SCRIPTS.has(PUBLISH_DIVERGENCE_LUA), true);
    assert.equal(
      accepts(gate, ['EVAL', PUBLISH_DIVERGENCE_LUA, '2', 'snapshot', 'meta']),
      true,
    );
    assert.equal(
      accepts(gate, ['EVAL', `${PUBLISH_DIVERGENCE_LUA} `, '2', 'snapshot', 'meta']),
      false,
      'a one-character script variant must stay blocked',
    );
  });

  it('pins every X Post budget script by exact bytes', () => {
    const gate = buildGate();
    for (const script of [RESERVE_LUA, SETTLE_LUA, ACK_RECEIPTS_LUA, STATUS_LUA]) {
      assert.equal(gate.ALLOWED_EVAL_SCRIPTS.has(script), true);
      assert.equal(accepts(gate, ['EVAL', script, '1', 'budget-key']), true);
      assert.equal(
        accepts(gate, ['EVAL', `${script} `, '1', 'budget-key']),
        false,
        'a one-character script variant must stay blocked',
      );
    }
  });

  it('accepts current and immediately prior X budget callers during rollout', () => {
    const gate = buildGate();
    const legacyScripts = [
      [
        gate.LEGACY_X_POST_BUDGET_RESERVE_SCRIPT,
        gate.X_POST_BUDGET_RESERVE_SCRIPT,
        '16673cafd28e2c29b645f1fd6c5a98465f9d4d6e4aa2af4b8e1d9ffb67de03ce',
      ],
      [
        gate.LEGACY_X_POST_BUDGET_STATUS_SCRIPT,
        gate.X_POST_BUDGET_STATUS_SCRIPT,
        'dd44c93034f8fdfb89b1460e651e158e213c92a37f532d58954e537367fcd99e',
      ],
    ];
    for (const [script, currentScript, expectedHash] of legacyScripts) {
      assert.equal(createHash('sha256').update(script).digest('hex'), expectedHash);
      assert.equal(gate.ALLOWED_EVAL_SCRIPTS.has(script), true);
      assert.equal(accepts(gate, ['EVAL', script, '1', 'budget-key']), true);
      assert.equal(gate.commandForExecution(['EVAL', script, '1', 'budget-key'])[1], currentScript);
      assert.equal(accepts(gate, ['EVAL', `${script} `, '1', 'budget-key']), false);
    }
    assert.notEqual(gate.LEGACY_X_POST_BUDGET_RESERVE_SCRIPT, RESERVE_LUA);
    assert.notEqual(gate.LEGACY_X_POST_BUDGET_STATUS_SCRIPT, STATUS_LUA);
  });
});
