import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  actionReadiness,
  bootstrapOnce,
  currentOriginMain,
  findWorktreeCollisions,
  inventoryGenerationSkipReason,
  parseArgs,
  prepareInventoryFacts,
  prAlignment,
  probeDependencies,
  runAgentPreflight,
  supportedNode,
} from '../scripts/agent-preflight.mjs';
import { createTempDir } from './helpers/temp-dir.mjs';

const makeRoot = () => createTempDir('wm-agent-preflight-');
const currentMajor = process.versions.node.split('.')[0];
const headOid = 'a'.repeat(40);

function readyChecks() {
  return {
    source: { ok: true, headOid, prHeadOid: headOid },
    execution: { trustedTarget: true },
    worktree: { ok: true, dirty: false, detached: false, unmerged: false },
    node: { ok: true },
    storage: { temp: { ok: true }, npmCache: { ok: true }, snapshotCache: { ok: true } },
    dependencies: { ok: true },
    inventoryFacts: { ok: true, attempted: true, required: true },
    credentials: { github: { available: true }, requiredEnv: {} },
    originMain: { fetched: true, headContainsOriginMain: true },
    prAlignment: { ok: true, stateOpen: true },
    duplicatePullRequests: { ok: true },
    worktrees: { ok: true, collisions: [] },
    bootstrap: { ok: true },
  };
}

function localRunner(root, { offline = true, status = '', detached = false, behind = false, origin = 'https://github.com/koala73/worldmonitor.git' } = {}) {
  const calls = [];
  const runner = (file, args) => {
    const command = args.join(' ');
    calls.push(`${file} ${command}`);
    const result = (stdout = '', exit = 0) => ({ status: exit, stderr: '', stdout });
    if (file === 'npm') {
      if (args[0] === 'ci') {
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
      }
      return result('{}');
    }
    if (file === process.execPath && args[0] === 'scripts/generate-inventory-facts.mjs') return result();
    if (file === 'git') {
      if (command.startsWith('status ')) return result(status);
      if (command === 'branch --show-current') return result(detached ? '' : 'codex/agent-tools\n');
      if (command === 'remote get-url origin') return result(origin ?? '', origin === null ? 1 : 0);
      if (command.startsWith('rev-parse --path-format')) return result(join(root, '.git'));
      if (command === 'rev-parse HEAD' || command === 'rev-parse --verify HEAD^{commit}') return result(headOid);
      if (command === 'rev-parse origin/main') return result(behind ? 'b'.repeat(40) : headOid);
      if (command.startsWith('fetch ')) return result('', offline ? 1 : 0);
      if (command.startsWith('rev-list ')) return result(behind ? '0\t1' : '0\t0');
      if (command.startsWith('merge-base ')) return result('', behind ? 1 : 0);
      if (command === 'worktree list --porcelain') return result(`worktree ${root}\nHEAD ${headOid}\n\nworktree /other/issue-123\nHEAD ${headOid}\nbranch refs/heads/codex/agent-tools\n`);
    }
    if (args[0] === 'auth') return result('', offline ? 1 : 0);
    if (args[0] === 'api' && args.includes(`repos/koala73/worldmonitor/commits/${headOid}/pulls`)) return result('[]');
    if (args[0] === 'pr' && args[1] === 'list') return result('[]', offline ? 1 : 0);
    throw new Error(`Unexpected command: ${file} ${command}`);
  };
  return { calls, runner };
}

function localFixture({ inventory = false } = {}) {
  const root = makeRoot();
  writeFileSync(join(root, '.nvmrc'), `${currentMajor}\n`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  if (inventory) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts/generate-inventory-facts.mjs'), 'throw new Error("target code executed");\n');
  }
  return { rootDir: root, cacheDir: join(root, 'cache'), npmCacheDir: join(root, 'npm-cache') };
}

describe('agent preflight', () => {
  it('accepts explicit action modes and preserves the default contract', () => {
    assert.equal(parseArgs([]).mode, null);
    for (const mode of ['review', 'tests', 'repair']) {
      assert.equal(parseArgs(['--mode', mode]).mode, mode);
      assert.equal(parseArgs([`--mode=${mode}`]).mode, mode);
    }
    assert.throws(() => parseArgs(['--mode=typo']), /--mode must be/);
    assert.throws(() => runAgentPreflight({ mode: 'typo' }), /--mode must be/);
  });

  it('reviews local commits without a supported origin and skips unavailable live checks', () => {
    for (const origin of [null, 'https://example.invalid/owner/repo.git']) {
      const options = localFixture({ inventory: true });
      const { calls, runner } = localRunner(options.rootDir, { origin, offline: false });
      const result = runAgentPreflight({ ...options, mode: 'review', pr: '123', issue: '123' }, runner);
      assert.equal(result.status, 'ready');
      assert.equal(result.schema, 'worldmonitor-agent-preflight/v2');
      assert.equal(result.repository, null);
      assert.equal(result.checks.source.headOid, headOid);
      assert.equal(result.checks.source.scope, 'local_commit');
      assert.equal(result.coverage.livePrState, false);
      assert.ok(result.coverage.gaps.some(gap => /origin/.test(gap)));
      assert.equal(result.checks.originMain.fetched, false);
      assert.equal(result.checks.duplicatePullRequests.checked, false);
      assert.equal(result.readiness.repair.ready, false);
      assert.equal(result.expensiveTestsAllowed, false);
      assert.equal(calls.some(call => /git fetch| api | pr list|npm ci|generate-inventory-facts\.mjs/.test(call)), false);
      for (const mode of [null, 'tests', 'repair']) {
        assert.throws(() => runAgentPreflight({ ...options, mode }, runner), /origin/);
      }
    }
  });

  it('preserves the selected schema and mode when the CLI encounters a runtime error', () => {
    const root = makeRoot();
    const script = fileURLToPath(new URL('../scripts/agent-preflight.mjs', import.meta.url));
    for (const mode of [null, 'review', 'tests', 'repair']) {
      const args = [script, '--root', root, ...(mode ? ['--mode', mode] : [])];
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      const output = JSON.parse(result.stdout);
      assert.equal(output.status, 'error');
      assert.match(output.error, /\.nvmrc/);
      assert.equal(output.schema, `worldmonitor-agent-preflight/${mode ? 'v2' : 'v1'}`);
      assert.equal(output.mode, mode ?? undefined);
    }
  });

  it('keeps source review and tests available when repair-only gates fail', () => {
    const checks = readyChecks();
    checks.worktree = { ok: false, detached: true, dirty: false };
    checks.originMain.headContainsOriginMain = false;
    checks.prAlignment = { ok: false, baseAligned: false, stateOpen: true };
    checks.worktrees = { ok: false, collisions: [{ path: '/other/branch' }] };
    const result = actionReadiness(checks);
    assert.equal(result.sourceReview.ready, true);
    assert.equal(result.tests.ready, true);
    assert.equal(result.repair.ready, false);
    assert.ok(result.repair.blockers.some(item => item.reason === 'base_behind'));
    assert.deepEqual(result.repair.blockers.find(item => item.check === 'worktrees'), {
      check: 'worktrees', reason: 'writer_activity_unknown', nextAction: 'inspect_existing_worktree',
    });
  });

  it('keeps unavailable evidence separate from the actions it cannot support', () => {
    const cases = [
      ['dependencies', { ok: false }, true, false],
      ['credentials', { github: { available: false }, requiredEnv: {} }, true, true],
      ['credentials', { github: { available: true }, requiredEnv: { TEST_KEY: false } }, true, false],
      ['source', { ok: false, headOid: null, prHeadOid: null }, false, false],
      ['source', { ok: true, headOid, prHeadOid: 'b'.repeat(40) }, false, false],
      ['prAlignment', { ok: false, stateOpen: false }, true, true],
      ['originMain', { fetched: false, error: 'offline' }, true, true],
      ['worktree', { ok: false, dirty: true }, true, false],
      ['worktree', { ok: true, dirty: true, intentionalDirty: true, unmerged: true }, true, false],
      ['execution', { trustedTarget: false }, true, false],
      ['inventoryFacts', { ok: true, required: true, attempted: false }, true, false],
    ];
    for (const [field, value, sourceReady, testsReady] of cases) {
      const checks = { ...readyChecks(), [field]: value };
      const result = actionReadiness(checks);
      assert.equal(result.sourceReview.ready, sourceReady, field);
      assert.equal(result.tests.ready, testsReady, field);
      assert.equal(result.repair.ready, false, field);
    }
    assert.equal(actionReadiness(readyChecks()).repair.ready, true);
  });

  it('permits verification and repair of local fix commits ahead of the confirmed PR head', () => {
    const checks = readyChecks();
    checks.source.headOid = 'b'.repeat(40);
    checks.prAlignment = { ok: true, headRelation: 'ahead', remoteAligned: true, stateOpen: true };
    const result = actionReadiness(checks);
    assert.equal(result.sourceReview.ready, false);
    assert.equal(result.tests.ready, true);
    assert.equal(result.repair.ready, true);
    checks.prAlignment.remoteAligned = false;
    checks.prAlignment.ok = false;
    assert.equal(actionReadiness(checks).tests.ready, false);
    assert.equal(actionReadiness(checks).repair.ready, false);
  });

  it('inspects a local commit offline without installing dependencies or running target scripts', () => {
    const options = localFixture({ inventory: true });
    const { calls, runner } = localRunner(options.rootDir, { status: ' M file.mjs\0', detached: true });
    const result = runAgentPreflight({ ...options, mode: 'review', pr: '123', issue: '123' }, runner);
    assert.equal(result.schema, 'worldmonitor-agent-preflight/v2');
    assert.equal(result.status, 'ready');
    assert.equal(result.expensiveTestsAllowed, false);
    assert.equal(result.readiness.repair.ready, false);
    assert.equal(result.checks.source.headOid, headOid);
    assert.equal(result.checks.source.scope, 'local_commit');
    assert.equal(result.coverage.livePrState, false);
    assert.ok(result.coverage.gaps.some(gap => gap.includes('uncommitted')));
    assert.equal(result.checks.worktrees.collisions[0].writerActivity, 'unknown');
    assert.equal(result.checks.worktrees.registeredCount, 2);
    assert.equal('activeCount' in result.checks.worktrees, false);
    assert.equal(result.checks.bootstrap.attempted, false);
    assert.equal(result.checks.inventoryFacts.attempted, false);
    assert.equal(existsSync(join(options.rootDir, 'node_modules')), false);
    assert.equal(calls.some(call => call.startsWith('npm ci') || call.includes('generate-inventory-facts.mjs')), false);
  });

  it('prepares tests in a trusted detached checkout despite offline GitHub and base checks', () => {
    const options = localFixture({ inventory: true });
    const { calls, runner } = localRunner(options.rootDir, { detached: true });
    const previous = process.cwd();
    try {
      process.chdir(options.rootDir);
      const result = runAgentPreflight({ ...options, mode: 'tests' }, runner);
      assert.equal(result.status, 'ready');
      assert.equal(result.expensiveTestsAllowed, true);
      assert.equal(result.readiness.repair.ready, false);
      assert.equal(result.checks.bootstrap.attempted, true);
      assert.equal(result.checks.inventoryFacts.attempted, true);
      assert.equal(calls.filter(call => call.startsWith('npm ci')).length, 1);
    } finally {
      process.chdir(previous);
    }
  });

  it('never prepares an alternate target in an explicit execution mode', () => {
    for (const mode of ['tests', 'repair']) {
      const options = localFixture({ inventory: true });
      const { calls, runner } = localRunner(options.rootDir, { offline: false });
      const result = runAgentPreflight({ ...options, mode, allowDirty: true, allowDetached: true }, runner);
      assert.equal(result.status, 'blocked');
      assert.equal(result.readiness.sourceReview.ready, true);
      assert.equal(result.expensiveTestsAllowed, false);
      assert.equal(result.checks.bootstrap.attempted, false);
      assert.equal(result.checks.inventoryFacts.attempted, false);
      assert.equal(calls.some(call => call.startsWith('npm ci') || call.includes('generate-inventory-facts.mjs')), false);
    }
  });

  it('does not let exception flags permit tests or preparation with unmerged paths', () => {
    const options = localFixture({ inventory: true });
    const previous = process.cwd();
    try {
      process.chdir(options.rootDir);
      for (const mode of ['tests', 'repair']) {
        const { calls, runner } = localRunner(options.rootDir, { status: 'UU file.mjs\0', offline: false });
        const result = runAgentPreflight({ ...options, mode, allowDirty: true }, runner);
        assert.equal(result.status, 'blocked');
        assert.equal(result.readiness.sourceReview.ready, true);
        assert.equal(result.expensiveTestsAllowed, false);
        assert.equal(calls.some(call => call.startsWith('npm ci') || call.includes('generate-inventory-facts.mjs')), false);
      }
    } finally {
      process.chdir(previous);
    }
  });

  it('does not mistake a renamed path for an unmerged status', () => {
    const options = localFixture();
    const { runner } = localRunner(options.rootDir, { status: 'R  renamed.mjs\0UU old.mjs\0' });
    const result = runAgentPreflight({ ...options, mode: 'review' }, runner);
    assert.equal(result.checks.worktree.unmerged, false);
    assert.deepEqual(result.checks.worktree.dirtyPaths, ['renamed.mjs', 'UU old.mjs']);
  });

  it('blocks only repair when an intentional stale base has complete local test prerequisites', () => {
    const options = localFixture({ inventory: true });
    const { runner } = localRunner(options.rootDir, { offline: false, behind: true });
    const previous = process.cwd();
    try {
      process.chdir(options.rootDir);
      const result = runAgentPreflight({ ...options, mode: 'repair', allowStaleMain: true }, runner);
      assert.equal(result.checks.originMain.ok, true);
      assert.equal(result.status, 'blocked');
      assert.equal(result.readiness.sourceReview.ready, true);
      assert.equal(result.expensiveTestsAllowed, true);
      assert.ok(result.readiness.repair.blockers.some(item => item.reason === 'base_behind'));
    } finally {
      process.chdir(previous);
    }
  });

  it('requires explicit opt-ins for dirty, detached, and stale-main states', () => {
    const options = parseArgs([
      '--allow-dirty',
      '--allow-detached',
      '--allow-stale-main',
      '--issue',
      '123',
      '--require-env',
      'UPSTASH_REDIS_REST_URL',
    ]);
    assert.equal(options.allowDirty, true);
    assert.equal(options.allowDetached, true);
    assert.equal(options.allowStaleMain, true);
    assert.deepEqual(options.requireEnv, ['UPSTASH_REDIS_REST_URL']);
  });

  it('reads the supported Node major from .nvmrc', () => {
    const root = makeRoot();
    writeFileSync(join(root, '.nvmrc'), `${currentMajor}\n`);
    assert.equal(supportedNode(root).ok, true);
    assert.equal(supportedNode(root, '1.2.3').ok, currentMajor === '1');
  });

  it('checks direct packages and their executable links', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      devDependencies: { tool: '1.0.0' },
    }));
    mkdirSync(join(root, 'node_modules', 'tool'), { recursive: true });
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    writeFileSync(join(root, 'node_modules', 'tool', 'package.json'), JSON.stringify({
      bin: { tool: 'cli.js' },
      name: 'tool',
    }));

    const broken = probeDependencies(root, () => ({ status: 0, stderr: '', stdout: '{}' }));
    assert.deepEqual(broken.brokenExecutables, ['tool']);
    assert.equal(broken.ok, false);

    writeFileSync(join(root, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    const complete = probeDependencies(root, () => ({ status: 0, stderr: '', stdout: '{}' }));
    assert.equal(complete.ok, true);
  });

  it('requires the nested blog dependency tree to be complete', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    mkdirSync(join(root, 'blog-site'), { recursive: true });
    writeFileSync(join(root, 'blog-site', 'package.json'), JSON.stringify({
      dependencies: { astro: '1.0.0' },
      name: 'blog-fixture',
    }));

    const result = probeDependencies(root, () => ({ status: 0, stderr: '', stdout: '{}' }));
    assert.equal(result.ok, false);
    assert.deepEqual(result.missingPackages, ['blog-site:astro']);
    assert.equal(result.trees.find(tree => tree.label === 'blog-site').ok, false);
  });

  it('finds issue and branch collisions without flagging the current worktree', () => {
    const collisions = findWorktreeCollisions([
      { branch: 'codex/current-123', path: '/repo/current' },
      { branch: 'feat/issue-123', path: '/repo/other' },
      { branch: 'codex/agent-tools', path: '/repo/agent-tools' },
      { branch: 'feat/unrelated', path: '/repo/unrelated' },
    ], {
      currentRoot: '/repo/current',
      issue: '123',
      watchedBranches: ['codex/agent-tools'],
    });

    assert.deepEqual(collisions.map(item => item.path), ['/repo/other', '/repo/agent-tools']);
  });

  it('bootstraps incomplete dependencies once after cheap gates pass', () => {
    const root = makeRoot();
    const cacheDir = join(root, 'agent-cache');
    const npmCacheDir = join(root, 'npm-cache');
    writeFileSync(join(root, '.nvmrc'), `${currentMajor}\n`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    let bootstrapCalls = 0;
    let bootstrapComplete = false;
    let statusCalls = 0;

    const runner = (file, args) => {
      if (file === 'npm' && args[0] === 'ci') {
        bootstrapCalls += 1;
        mkdirSync(join(root, 'node_modules'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
        bootstrapComplete = true;
        return { status: 0, stderr: '', stdout: '' };
      }
      if (file === 'npm') return { status: 0, stderr: '', stdout: '{}' };
      if (file === 'git') {
        const command = args.join(' ');
        if (command.startsWith('status ')) {
          statusCalls += 1;
          return { status: 0, stderr: '', stdout: '' };
        }
        if (command === 'branch --show-current') {
          return { status: 0, stderr: '', stdout: 'codex/agent-tools\n' };
        }
        if (command === 'remote get-url origin') {
          return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
        }
        if (command === 'rev-parse HEAD' || command === 'rev-parse origin/main') {
          return { status: 0, stderr: '', stdout: `${headOid}\n` };
        }
        if (command.startsWith('fetch ')) {
          assert.equal(bootstrapComplete, true);
          return { status: 0, stderr: '', stdout: '' };
        }
        if (command.startsWith('rev-list ')) return { status: 0, stderr: '', stdout: '0\t0\n' };
        if (command === 'worktree list --porcelain') {
          return {
            status: 0,
            stderr: '',
            stdout: `worktree ${root}\nHEAD ${headOid}\nbranch refs/heads/codex/agent-tools\n`,
          };
        }
        return { status: 0, stderr: '', stdout: '' };
      }
      if (args[0] === 'auth') return { status: 0, stderr: '', stdout: '' };
      if (args[0] === 'api' && args.includes(`repos/koala73/worldmonitor/commits/${headOid}/pulls`)) {
        return { status: 0, stderr: '', stdout: '[]' };
      }
      throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
    };

    const result = runAgentPreflight({
      cacheDir,
      npmCacheDir,
      requireEnv: [],
      rootDir: root,
    }, runner);

    assert.equal(result.ok, true);
    assert.equal(result.schema, 'worldmonitor-agent-preflight/v1');
    assert.equal('readiness' in result, false);
    assert.equal(result.expensiveTestsAllowed, true);
    assert.equal(result.checks.bootstrap.attempted, true);
    assert.equal(bootstrapCalls, 1);
    assert.equal(result.checks.inventoryFacts.ok, true);
    assert.equal(result.checks.inventoryFacts.attempted, false);
    assert.match(result.checks.inventoryFacts.reason, /generator not present/);
    assert.equal(statusCalls, 2);
  });

  it('allows an older checkout whose inventory generator is not present', () => {
    const root = makeRoot();
    const cacheDir = join(root, 'agent-cache');
    const npmCacheDir = join(root, 'npm-cache');
    writeFileSync(join(root, '.nvmrc'), `${currentMajor}\n`);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');

    const runner = (file, args) => {
      const command = args.join(' ');
      if (file === 'npm') return { status: 0, stderr: '', stdout: '{}' };
      if (file === 'git') {
        if (command.startsWith('status ')) return { status: 0, stderr: '', stdout: '' };
        if (command === 'branch --show-current') {
          return { status: 0, stderr: '', stdout: 'codex/agent-tools\n' };
        }
        if (command === 'remote get-url origin') {
          return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
        }
        if (command === 'rev-parse HEAD' || command === 'rev-parse origin/main') {
          return { status: 0, stderr: '', stdout: `${headOid}\n` };
        }
        if (command.startsWith('rev-list ')) return { status: 0, stderr: '', stdout: '0\t0\n' };
        if (command === 'worktree list --porcelain') {
          return {
            status: 0,
            stderr: '',
            stdout: `worktree ${root}\nHEAD ${headOid}\nbranch refs/heads/codex/agent-tools\n`,
          };
        }
        return { status: 0, stderr: '', stdout: '' };
      }
      if (args[0] === 'auth') return { status: 0, stderr: '', stdout: '' };
      if (args[0] === 'api' && args.includes(`repos/koala73/worldmonitor/commits/${headOid}/pulls`)) {
        return { status: 0, stderr: '', stdout: '[]' };
      }
      throw new Error(`Unexpected command: ${file} ${command}`);
    };

    const result = runAgentPreflight({
      cacheDir,
      npmCacheDir,
      requireEnv: [],
      rootDir: root,
    }, runner);

    assert.equal(result.ok, true);
    assert.equal(result.checks.bootstrap.attempted, false);
    assert.equal(result.checks.inventoryFacts.ok, true);
    assert.equal(result.checks.inventoryFacts.attempted, false);
    assert.equal(
      result.checks.inventoryFacts.reason,
      'generator not present in this checkout',
    );

    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts', 'generate-inventory-facts.mjs'),
      'throw new Error("alternate target code executed");\n',
    );
    const alternateTarget = runAgentPreflight({
      cacheDir,
      npmCacheDir,
      requireEnv: [],
      rootDir: root,
    }, runner);
    assert.equal(alternateTarget.ok, true);
    assert.equal(alternateTarget.checks.inventoryFacts.attempted, false);
    assert.equal(
      alternateTarget.checks.inventoryFacts.reason,
      'inventory generation disabled for an alternate --root target',
    );

    const skipped = runAgentPreflight({
      cacheDir,
      npmCacheDir,
      requireEnv: [],
      rootDir: root,
      skipBootstrap: true,
    }, runner);
    assert.equal(skipped.ok, true);
    assert.equal(skipped.checks.inventoryFacts.attempted, false);
    assert.equal(skipped.checks.inventoryFacts.ok, true);
    assert.equal(
      skipped.checks.inventoryFacts.reason,
      'inventory generation disabled by --skip-bootstrap',
    );
  });

  it('runs inventory generation only for the current checkout', () => {
    const current = makeRoot();
    const alternate = makeRoot();
    for (const root of [current, alternate]) {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'generate-inventory-facts.mjs'), '');
    }

    assert.equal(inventoryGenerationSkipReason(current, { currentDir: current }), null);
    assert.equal(
      inventoryGenerationSkipReason(alternate, { currentDir: current }),
      'inventory generation disabled for an alternate --root target',
    );
    assert.equal(
      inventoryGenerationSkipReason(current, { currentDir: current, skipBootstrap: true }),
      'inventory generation disabled by --skip-bootstrap',
    );
  });

  it('does not allow stale-main intent to hide unresolved Git state', () => {
    const runner = (file, args) => {
      assert.equal(file, 'git');
      const command = args.join(' ');
      if (command.startsWith('fetch ')) return { status: 0, stderr: '', stdout: '' };
      if (command === 'rev-parse HEAD') {
        return { status: 128, stderr: 'bad revision', stdout: '' };
      }
      if (command === 'rev-parse origin/main') {
        return { status: 0, stderr: '', stdout: `${headOid}\n` };
      }
      if (command.startsWith('rev-list ')) return { status: 0, stderr: '', stdout: '0\t0\n' };
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = currentOriginMain('/repo', runner, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /bad revision/);
  });

  it('gives origin/main fetches a network budget and reports timeouts distinctly', () => {
    let receivedOptions;
    const runner = (file, args, options) => {
      assert.equal(file, 'git');
      assert.equal(args.join(' '), 'fetch --no-tags origin main');
      receivedOptions = options;
      return { error: { code: 'ETIMEDOUT' }, status: null, stderr: '', stdout: '' };
    };

    const result = currentOriginMain('/repo', runner, false);
    assert.equal(receivedOptions.timeout, 180_000);
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 180000ms/);
  });

  it('requires the checked-out branch to own the PR head', () => {
    const snapshot = {
      base: { oid: headOid, ref: 'main' },
      head: { ref: 'codex/expected' },
      pullRequest: { state: 'OPEN' },
      remoteState: {
        graphQlMatchesRemote: true,
        localBranch: 'codex/unrelated',
        relation: 'exact',
      },
    };
    const runner = (_file, args) => {
      const command = args.join(' ');
      if (command.startsWith('fetch ')) return { status: 0, stderr: '', stdout: '' };
      if (command === 'rev-parse origin/main') {
        return { status: 0, stderr: '', stdout: `${headOid}\n` };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    const result = prAlignment(snapshot, '/repo', runner);
    assert.equal(result.branchAligned, false);
    assert.equal(result.ok, false);
  });

  it('accepts the fetched live base when the PR object base OID is stale', () => {
    const snapshot = {
      base: {
        oid: headOid,
        ref: 'main',
        state: {
          fetchedOid: headOid,
          graphQlMatchesFetched: false,
          localContainsBase: true,
          pullRequestOid: 'b'.repeat(40),
        },
      },
      head: { ref: 'codex/agent-tools' },
      pullRequest: { state: 'OPEN' },
      remoteState: {
        graphQlMatchesRemote: true,
        localBranch: 'codex/agent-tools',
        relation: 'ahead',
      },
    };

    const result = prAlignment(snapshot, '/repo', () => {
      throw new Error('runner should not be called');
    });
    assert.equal(result.baseAligned, true);
    assert.equal(result.ok, true);
  });

  it('bounds a safe bootstrap and disables lifecycle scripts', () => {
    let receivedOptions;
    const runner = (file, args, options) => {
      assert.equal(file, 'npm');
      assert.deepEqual(args, ['ci', '--cache', '/tmp/cache', '--ignore-scripts']);
      receivedOptions = options;
      return { error: { code: 'ETIMEDOUT' }, status: null, stderr: '', stdout: '' };
    };

    const result = bootstrapOnce('/repo', '/tmp/cache', runner, 1234);
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out after 1234ms/);
    assert.ok(receivedOptions.timeout > 0);
    assert.ok(receivedOptions.timeout <= 1234);
    assert.equal(receivedOptions.env.npm_config_ignore_scripts, 'true');
    assert.equal('UPSTASH_REDIS_REST_URL' in receivedOptions.env, false);
  });

  it('runs inventory generation directly with a minimal bounded environment', () => {
    let received;
    const runner = (file, args, options) => {
      received = { args, file, options };
      return { status: 0, stderr: '', stdout: '' };
    };

    const result = prepareInventoryFacts('/repo', runner, 4321);
    assert.equal(result.ok, true);
    assert.equal(received.file, process.execPath);
    assert.deepEqual(received.args, ['scripts/generate-inventory-facts.mjs']);
    assert.equal(received.options.cwd, '/repo');
    assert.equal(received.options.timeout, 4321);
    assert.equal('UPSTASH_REDIS_REST_URL' in received.options.env, false);
  });

  it('defaults the inventory generator runner to spawnSync', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'generate-inventory-facts.mjs'), 'process.exit(0);\n');

    assert.equal(prepareInventoryFacts(root).ok, true);
  });

  it('installs root and blog dependencies within one bootstrap attempt', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'blog-site'), { recursive: true });
    writeFileSync(join(root, 'blog-site', 'package.json'), JSON.stringify({ name: 'blog' }));
    const workingDirectories = [];
    const runner = (_file, _args, options) => {
      workingDirectories.push(options.cwd);
      return { status: 0, stderr: '', stdout: '' };
    };

    const result = bootstrapOnce(root, '/tmp/cache', runner, 10_000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.completedTargets, ['root', 'blog-site']);
    assert.deepEqual(workingDirectories, [root, join(root, 'blog-site')]);
  });
});
