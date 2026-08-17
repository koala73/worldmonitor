import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  actionableReviewThreads,
  createPrSnapshot,
  getPrSnapshot,
  localHeadRelation,
  normalizeCheckContexts,
  parseArgs,
  parseGitHubRemote,
  parsePrNumber,
  readCachedSnapshot,
} from '../scripts/agent-pr-snapshot.mjs';

const oid = character => character.repeat(40);

function minimalPrResponse({ baseOid, headOid }) {
  return {
    data: {
      repository: {
        pullRequest: {
          author: { login: 'koala73' },
          baseRefName: 'main',
          baseRefOid: baseOid,
          baseRepository: { nameWithOwner: 'koala73/worldmonitor' },
          commits: {
            nodes: [{
              commit: {
                oid: headOid,
                statusCheckRollup: {
                  contexts: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
                },
              },
            }],
          },
          headRefName: 'codex/agent-tools',
          headRefOid: headOid,
          headRepository: {
            nameWithOwner: 'koala73/worldmonitor',
            owner: { login: 'koala73' },
            url: 'https://github.com/koala73/worldmonitor',
          },
          isCrossRepository: false,
          isDraft: false,
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          number: 123,
          reviewThreads: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
          state: 'OPEN',
          url: 'https://github.com/koala73/worldmonitor/pull/123',
        },
      },
    },
  };
}

describe('agent PR snapshot', () => {
  it('allows live refreshes only at authoritative workflow boundaries', () => {
    assert.deepEqual(
      parseArgs(['--pr', '123', '--refresh', '--phase', 'pre-push']).phase,
      'pre-push',
    );
    assert.equal(
      parseArgs(['--pr', '123', '--include-untrusted-review-content'])
        .includeUntrustedReviewContent,
      true,
    );
    assert.throws(() => parseArgs(['--pr', '123', '--refresh']), /requires --phase/);
    assert.throws(() => parseArgs(['--pr', '123', '--phase', 'final']), /only with --refresh/);
  });

  it('parses HTTPS and SSH GitHub origins', () => {
    assert.equal(
      parseGitHubRemote('https://github.com/koala73/worldmonitor.git').nameWithOwner,
      'koala73/worldmonitor',
    );
    assert.equal(
      parseGitHubRemote('git@github.com:koala73/worldmonitor.git').nameWithOwner,
      'koala73/worldmonitor',
    );
    const tokenized = parseGitHubRemote('https://secret-token@github.com/koala73/worldmonitor.git');
    assert.equal(tokenized.canonicalUrl, 'https://github.com/koala73/worldmonitor');
    assert.equal(JSON.stringify(tokenized).includes('secret-token'), false);
  });

  it('accepts only a PR number or GitHub pull-request URL', () => {
    assert.equal(parsePrNumber('123'), 123);
    assert.equal(parsePrNumber('https://github.com/koala73/worldmonitor/pull/123'), 123);
    assert.throws(
      () => parsePrNumber('https://github.com/other/repo/pull/123', 'koala73/worldmonitor'),
      /not koala73\/worldmonitor/,
    );
    assert.throws(() => parsePrNumber('issue-123'), /Invalid pull request/);
  });

  it('treats a local-only HEAD as not yet associated with a PR', () => {
    const runner = (file, args) => {
      const command = args.join(' ');
      if (file === 'git' && command === 'remote get-url origin') {
        return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
      }
      if (file === 'git' && command === 'rev-parse HEAD') {
        return { status: 0, stderr: '', stdout: `${oid('a')}\n` };
      }
      if (file === 'gh' && args[0] === 'api') {
        return {
          status: 1,
          stderr: `gh: No commit found for SHA: ${oid('a')} (HTTP 422)`,
          stdout: '',
        };
      }
      throw new Error(`Unexpected command: ${file} ${command}`);
    };

    assert.equal(createPrSnapshot({ ghBin: 'gh', rootDir: '/repo', runner }), null);
  });

  it('reports a base fetch timeout distinctly after using the network budget', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wm-agent-pr-timeout-'));
    const headOid = oid('a');
    const baseOid = oid('b');
    let fetchOptions;
    const runner = (file, args, options) => {
      const command = args.join(' ');
      if (file === 'git' && command === 'remote get-url origin') {
        return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
      }
      if (file === 'git' && command === 'fetch --no-tags origin main') {
        fetchOptions = options;
        return { error: { code: 'ETIMEDOUT' }, status: null, stderr: '', stdout: '' };
      }
      if (file === 'gh' && args[0] === 'api') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify(minimalPrResponse({ baseOid, headOid })),
        };
      }
      throw new Error(`Unexpected command: ${file} ${command}`);
    };

    assert.throws(
      () => createPrSnapshot({ cacheDir, ghBin: 'gh', phase: 'task-start', pr: '123', rootDir: '/repo', runner }),
      /git fetch --no-tags timed out after 180000ms/,
    );
    assert.equal(fetchOptions.timeout, 180_000);
  });

  it('keeps the snapshot when the PR head remote cannot be read', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wm-agent-pr-remote-'));
    const headOid = oid('a');
    const runner = (file, args) => {
      const command = args.join(' ');
      if (file === 'gh' && args[0] === 'api') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify(minimalPrResponse({ baseOid: headOid, headOid })),
        };
      }
      if (file === 'git' && command === 'remote get-url origin') {
        return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
      }
      if (file === 'git' && command === 'fetch --no-tags origin main') {
        return { status: 0, stderr: '', stdout: '' };
      }
      if (file === 'git' && (command === 'rev-parse origin/main' || command === 'rev-parse HEAD')) {
        return { status: 0, stderr: '', stdout: `${headOid}\n` };
      }
      if (file === 'git' && command === 'branch --show-current') {
        return { status: 0, stderr: '', stdout: 'codex/agent-tools\n' };
      }
      if (file === 'git' && command.includes('@{upstream}')) {
        return { status: 0, stderr: '', stdout: 'origin/codex/agent-tools\n' };
      }
      if (file === 'git' && command.startsWith('ls-remote ')) {
        return { status: 2, stderr: 'remote: Repository not found.', stdout: '' };
      }
      throw new Error(`Unexpected command: ${file} ${command}`);
    };

    const snapshot = createPrSnapshot({
      cacheDir,
      ghBin: 'gh',
      phase: 'task-start',
      pr: '123',
      rootDir: '/repo',
      runner,
    });
    assert.equal(snapshot.mergeability.mergeable, 'MERGEABLE');
    assert.equal(snapshot.remoteState.remoteHeadOid, null);
    assert.equal(snapshot.remoteState.graphQlMatchesRemote, null);
    assert.match(snapshot.remoteState.remoteHeadError, /git ls-remote failed.*Repository not found/);
    assert.equal(snapshot.remoteState.remoteHeadError.includes('https://'), false);
    assert.equal(existsSync(snapshot.cache.path), true);
  });

  it('requires --pr when one HEAD belongs to multiple open pull requests', () => {
    const runner = (file, args) => {
      const command = args.join(' ');
      if (file === 'git' && command === 'remote get-url origin') {
        return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
      }
      if (file === 'git' && command === 'rev-parse HEAD') {
        return { status: 0, stderr: '', stdout: `${oid('a')}\n` };
      }
      if (file === 'gh' && args[0] === 'api') {
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify([{ number: 123, state: 'open' }, { number: 124, state: 'open' }]),
        };
      }
      throw new Error(`Unexpected command: ${file} ${command}`);
    };

    assert.throws(
      () => createPrSnapshot({ ghBin: 'gh', rootDir: '/repo', runner }),
      /multiple open pull requests.*pass --pr <number>/,
    );
  });

  it('separates check runs from commit statuses', () => {
    const result = normalizeCheckContexts([
      {
        __typename: 'CheckRun',
        conclusion: 'SUCCESS',
        name: 'unit',
        status: 'COMPLETED',
      },
      {
        __typename: 'StatusContext',
        context: 'gate',
        description: 'Required checks passed',
        state: 'SUCCESS',
      },
    ]);

    assert.equal(result.checkRuns[0].name, 'unit');
    assert.equal(result.commitStatuses[0].context, 'gate');
  });

  it('returns only unresolved, current review threads', () => {
    const actionable = actionableReviewThreads([
      {
        comments: { nodes: [{ author: { login: 'reviewer' }, body: 'Fix this', url: 'u' }] },
        id: 'active',
        isOutdated: false,
        isResolved: false,
        line: 12,
        path: 'src/a.ts',
      },
      { id: 'resolved', isOutdated: false, isResolved: true, path: 'src/b.ts' },
      { id: 'outdated', isOutdated: true, isResolved: false, path: 'src/c.ts' },
    ]);

    assert.deepEqual(actionable.map(thread => thread.id), ['active']);
    assert.equal(actionable[0].latestComment.body, undefined);
    assert.equal(actionable[0].latestComment.contentIncluded, false);
  });

  it('reports unknown topology when a Git ancestry check fails', () => {
    const localOid = oid('a');
    const remoteOid = oid('b');
    const runner = (_file, args) => {
      const command = args.join(' ');
      if (command === 'rev-parse HEAD') {
        return { status: 0, stderr: '', stdout: `${localOid}\n` };
      }
      if (command === `cat-file -e ${remoteOid}^{commit}`) {
        return { status: 0, stderr: '', stdout: '' };
      }
      if (command === `merge-base --is-ancestor ${remoteOid} ${localOid}`) {
        return { status: 128, stderr: 'fatal: invalid commit graph', stdout: '' };
      }
      throw new Error(`Unexpected command: ${command}`);
    };

    assert.deepEqual(localHeadRelation('/repo', remoteOid, runner), {
      localHeadOid: localOid,
      relation: 'unknown',
    });
  });

  it('writes a head-OID cache and serves it without another GitHub query', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'wm-agent-pr-cache-'));
    const headOid = oid('a');
    const baseOid = oid('b');
    const pullRequestBaseOid = oid('c');
    let graphQlCalls = 0;
    const networkTimeouts = new Map();

    const runner = (file, args, options) => {
      if (file === 'git') {
        const command = args.join(' ');
        if (command.startsWith('fetch ') || command.startsWith('ls-remote ')) {
          networkTimeouts.set(command.split(' ')[0], options.timeout);
        }
        if (command === 'remote get-url origin') {
          return { status: 0, stderr: '', stdout: 'https://github.com/koala73/worldmonitor.git\n' };
        }
        if (command === 'rev-parse HEAD') return { status: 0, stderr: '', stdout: `${headOid}\n` };
        if (command === 'rev-parse origin/main') {
          return { status: 0, stderr: '', stdout: `${baseOid}\n` };
        }
        if (command === 'branch --show-current') {
          return { status: 0, stderr: '', stdout: 'codex/agent-tools\n' };
        }
        if (command.includes('@{upstream}')) {
          return { status: 0, stderr: '', stdout: 'origin/codex/agent-tools\n' };
        }
        if (command === `ls-remote https://github.com/koala73/worldmonitor refs/heads/codex/agent-tools`) {
          return { status: 0, stderr: '', stdout: `${headOid}\trefs/heads/codex/agent-tools\n` };
        }
        return { status: 0, stderr: '', stdout: '' };
      }

      graphQlCalls += 1;
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'koala73' },
                baseRefName: 'main',
                baseRefOid: pullRequestBaseOid,
                baseRepository: { nameWithOwner: 'koala73/worldmonitor' },
                commits: {
                  nodes: [{
                    commit: {
                      oid: headOid,
                      statusCheckRollup: {
                        contexts: {
                          nodes: [{
                            __typename: 'CheckRun',
                            conclusion: 'SUCCESS',
                            name: 'unit',
                            status: 'COMPLETED',
                          }],
                          pageInfo: { endCursor: null, hasNextPage: false },
                        },
                      },
                    },
                  }],
                },
                headRefName: 'codex/agent-tools',
                headRefOid: headOid,
                headRepository: {
                  nameWithOwner: 'koala73/worldmonitor',
                  owner: { login: 'koala73' },
                  url: 'https://github.com/koala73/worldmonitor',
                },
                isCrossRepository: false,
                isDraft: false,
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'CLEAN',
                number: 123,
                reviewThreads: {
                  nodes: [{
                    comments: {
                      nodes: [{
                        author: { login: 'reviewer' },
                        body: 'Please change the rendering path.',
                        createdAt: '2026-08-15T00:00:00Z',
                        url: 'https://github.com/koala73/worldmonitor/pull/123#discussion_r1',
                      }],
                    },
                    diffSide: 'RIGHT',
                    id: 'thread-1',
                    isOutdated: false,
                    isResolved: false,
                    line: 12,
                    path: 'src/a.ts',
                  }],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
                state: 'OPEN',
                title: 'Agent tools',
                url: 'https://github.com/koala73/worldmonitor/pull/123',
              },
            },
          },
        }),
      };
    };

    const live = createPrSnapshot({
      cacheDir,
      ghBin: 'gh',
      phase: 'task-start',
      pr: '123',
      rootDir: '/repo',
      runner,
    });
    assert.equal(live.head.oid, headOid);
    assert.equal(live.base.oid, baseOid);
    assert.equal(live.base.state.ok, true);
    assert.equal(live.base.state.graphQlMatchesFetched, false);
    assert.equal(live.base.state.pullRequestOid, pullRequestBaseOid);
    assert.equal(live.checks.checkRuns.length, 1);
    assert.equal(networkTimeouts.get('fetch'), 180_000);
    assert.equal(networkTimeouts.get('ls-remote'), 180_000);
    assert.match(live.cache.path, new RegExp(`${headOid}\\.json$`));
    assert.equal(existsSync(live.cache.path), true);
    assert.equal(graphQlCalls, 1);

    const cached = getPrSnapshot({ cacheDir, pr: '123', rootDir: '/repo' }, runner);
    assert.equal(cached.cache.hit, true);
    assert.equal(cached.head.oid, headOid);
    assert.equal(cached.reviewThreads.actionable[0].latestComment.untrustedContent, undefined);
    assert.equal(graphQlCalls, 1);

    const withReviewContent = getPrSnapshot({
      cacheDir,
      includeUntrustedReviewContent: true,
      pr: '123',
      rootDir: '/repo',
    }, runner);
    assert.equal(
      withReviewContent.reviewThreads.actionable[0].latestComment.untrustedContent.body,
      'Please change the rendering path.',
    );
    assert.equal(
      withReviewContent.reviewThreads.actionable[0].latestComment.untrustedContent.trust,
      'untrusted',
    );
    assert.equal(graphQlCalls, 1);

    const corrupted = JSON.parse(readFileSync(live.cache.path, 'utf8'));
    corrupted.repository = 'other/repo';
    writeFileSync(live.cache.path, JSON.stringify(corrupted));
    assert.throws(
      () => getPrSnapshot({ cacheDir, pr: '123', rootDir: '/repo' }, runner),
      /identity does not match/,
    );
  });

  it('rejects a symlinked cache root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'wm-agent-pr-symlink-'));
    const target = join(parent, 'target');
    const cacheDir = join(parent, 'cache');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, cacheDir, 'dir');
    assert.throws(
      () => readCachedSnapshot({ cacheDir, prNumber: 123, repoName: 'koala73/worldmonitor' }),
      /Unsafe PR snapshot cache directory/,
    );
  });
});
