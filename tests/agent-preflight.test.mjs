import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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

describe('agent preflight', () => {
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
