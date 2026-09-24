// #7006 — a stacked PR can merge successfully into a deleted parent branch
// and never reach main. GitHub still paints the PR MERGED. The decision
// functions below are the gate: they must trip on the recorded #6996 → #6997
// and #6991 → #6993 sequences, and they must stay quiet for a PR based on
// main and for a live stack whose parent is still open.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ISSUE_TITLE_PREFIX,
  checkClosedPull,
  checkStackedMerge,
  evaluatePostMergeAncestry,
  evaluatePreMergeGuard,
  flattenGhPages,
  formatOrphanComment,
  formatOrphanIssue,
  isCommitAncestor,
  listPullsByHead,
  planStackRetargets,
  retargetStackedChildren,
} from '../scripts/check-stacked-merge.mjs';

const PARENT_6996 = Object.freeze({
  number: 6996,
  title: 'fix(aviation): bind budget to live access',
  html_url: 'https://github.com/koala73/worldmonitor/pull/6996',
  state: 'closed',
  merged_at: '2026-08-20T12:53:04Z',
  head: { ref: 'fix/aviation-budget-binds-v2' },
});

const CHILD_6997 = Object.freeze({
  number: 6997,
  title: 'fix(aviation): require live access for airport flights',
  html_url: 'https://github.com/koala73/worldmonitor/pull/6997',
  state: 'closed',
  merged: true,
  merged_at: '2026-08-20T12:53:16Z',
  merge_commit_sha: 'c'.repeat(40),
  base: { ref: 'fix/aviation-budget-binds-v2', repo: { owner: { login: 'koala73' } } },
  head: { ref: 'fix/aviation-live-access' },
});

const PARENT_6991 = Object.freeze({
  number: 6991,
  title: 'fix(aviation): cache ttl 900',
  html_url: 'https://github.com/koala73/worldmonitor/pull/6991',
  state: 'closed',
  merged_at: '2026-08-20T11:13:25Z',
  head: { ref: 'fix/aviation-cache-ttl-900' },
});

const CHILD_6993 = Object.freeze({
  number: 6993,
  title: 'fix(aviation): stacked follow-up',
  html_url: 'https://github.com/koala73/worldmonitor/pull/6993',
  state: 'closed',
  merged: true,
  merged_at: '2026-08-20T11:28:36Z',
  merge_commit_sha: 'd'.repeat(40),
  base: { ref: 'fix/aviation-cache-ttl-900', repo: { owner: { login: 'koala73' } } },
  head: { ref: 'fix/aviation-cache-followup' },
});

function pullEvent(pull, { eventName = 'pull_request', action = 'synchronize', defaultBranch = 'main' } = {}) {
  return {
    eventName,
    action,
    repository: { default_branch: defaultBranch, full_name: 'koala73/worldmonitor' },
    pull_request: pull,
  };
}

function pushEvent({ defaultBranch = 'main' } = {}) {
  return {
    eventName: 'push',
    repository: { default_branch: defaultBranch, full_name: 'koala73/worldmonitor' },
    ref: `refs/heads/${defaultBranch}`,
  };
}

describe('pre-merge stacked base guard', () => {
  it('passes a PR whose base is the default branch without looking up parent PRs', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: 'main',
      baseHeadPulls: [{ number: 1, merged_at: '2026-08-20T00:00:00Z' }],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'base-is-default');
  });

  it('passes a live stack whose parent PR is still open', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: 'fix/aviation-budget-binds-v2',
      baseHeadPulls: [{ ...PARENT_6996, state: 'open', merged_at: null }],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'base-pr-open');
  });

  it('passes a non-default base that has no pull request of its own', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: 'long-lived-integration',
      baseHeadPulls: [],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'base-pr-absent');
  });

  it('trips for the #6996 → #6997 tombstone sequence', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: CHILD_6997.base.ref,
      baseHeadPulls: [PARENT_6996],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'base-pr-merged');
    assert.deepEqual(verdict.mergedPrs.map((pr) => pr.number), [6996]);
  });

  it('trips for the #6991 → #6993 tombstone sequence', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: CHILD_6993.base.ref,
      baseHeadPulls: [PARENT_6991],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'base-pr-merged');
    assert.deepEqual(verdict.mergedPrs.map((pr) => pr.number), [6991]);
  });
});

describe('post-merge ancestry guard', () => {
  it('ignores a closed PR that was not merged', () => {
    const verdict = evaluatePostMergeAncestry({
      merged: false,
      mergeSha: null,
      isAncestor: false,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'not-merged');
  });

  it('passes when the merge commit is an ancestor of the default branch', () => {
    const verdict = evaluatePostMergeAncestry({
      merged: true,
      mergeSha: 'a'.repeat(40),
      isAncestor: true,
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'merge-on-default');
  });

  it('trips when #6997 merged and its merge commit never reached main', () => {
    const verdict = evaluatePostMergeAncestry({
      merged: true,
      mergeSha: CHILD_6997.merge_commit_sha,
      isAncestor: false,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'integration-unproven');
  });

  it('trips when the merge commit SHA is missing', () => {
    const verdict = evaluatePostMergeAncestry({
      merged: true,
      mergeSha: null,
      isAncestor: false,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'missing-merge-sha');
  });
});

describe('GitHub pull listing helpers', () => {
  it('flattens both a single page and slurped paginated pages', () => {
    assert.deepEqual(flattenGhPages(JSON.stringify([PARENT_6996])), [PARENT_6996]);
    assert.deepEqual(flattenGhPages(JSON.stringify([[PARENT_6996], [PARENT_6991]])), [PARENT_6996, PARENT_6991]);
  });

  it('asks GitHub for every PR whose head is the stacked base', () => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      return JSON.stringify([PARENT_6996]);
    };
    const pulls = listPullsByHead({
      gh,
      repository: 'koala73/worldmonitor',
      owner: 'koala73',
      headRef: 'fix/aviation-budget-binds-v2',
    });
    assert.deepEqual(pulls.map((pr) => pr.number), [6996]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'api');
    assert.ok(calls[0].includes('--paginate'));
    assert.ok(calls[0].includes('--slurp'));
    const path = calls[0].find((arg) => String(arg).startsWith('repos/'));
    assert.match(path, /repos\/koala73\/worldmonitor\/pulls\?/);
    assert.match(path, /state=all/);
    assert.match(path, /head=koala73%3Afix%2Faviation-budget-binds-v2/);
  });
});

describe('git ancestry', () => {
  it('treats merge-base exit 1 as not-ancestor and any other failure as fatal', () => {
    const git = (args) => {
      if (args[2] === 'yes') return '';
      const error = new Error(`git merge-base failed (1): ${args.join(' ')}`);
      error.status = 1;
      throw error;
    };
    assert.equal(isCommitAncestor({ git, commit: 'yes', ref: 'origin/main' }), true);
    assert.equal(isCommitAncestor({ git, commit: 'no', ref: 'origin/main' }), false);

    const fatal = (args) => {
      const error = new Error(`git ${args.join(' ')} failed (128)`);
      error.status = 128;
      throw error;
    };
    assert.throws(() => isCommitAncestor({ git: fatal, commit: 'abc', ref: 'origin/main' }), /failed \(128\)/);
  });
});

describe('orphan alarm copy', () => {
  it('names the PR and the parent so a human can re-land without diffing main by hand', () => {
    const issue = formatOrphanIssue({
      pull: CHILD_6997,
      mergeSha: CHILD_6997.merge_commit_sha,
      defaultBranch: 'main',
      parents: [PARENT_6996],
      reason: 'integration-unproven',
    });
    assert.equal(issue.title, `${ISSUE_TITLE_PREFIX} #6997 on main`);
    assert.match(issue.body, /#6997/);
    assert.match(issue.body, /#6996/);
    assert.match(issue.body, /fix\/aviation-budget-binds-v2/);
    assert.match(issue.body, /#7006/);
    assert.equal(issue.title.includes('Fixes'), false);

    const comment = formatOrphanComment({
      pull: CHILD_6997,
      mergeSha: CHILD_6997.merge_commit_sha,
      defaultBranch: 'main',
      parents: [PARENT_6996],
      reason: 'integration-unproven',
    });
    assert.match(comment, /Integration into `main` is unproven/);
    assert.match(comment, /#6996/);
  });
});

describe('checkStackedMerge orchestrator', () => {
  it('does not discover descendants when the head repository is unknown', () => {
    for (const repo of [undefined, null, {}]) {
      const result = checkClosedPull({
        event: pullEvent({ number: 50, merged: false, head: { ref: 'main', repo } }, { action: 'closed' }),
        gh: () => assert.fail('unknown head repository must not query upstream descendants'),
        git: () => assert.fail('an unmerged closure needs no ancestry check'),
      });
      assert.equal(result.ok, true);
      assert.equal(result.results.length, 1);
    }
  });

  it('does not discover upstream children from a same-named fork branch', () => {
    const result = checkClosedPull({
      event: pullEvent({ number: 50, merged: false, head: { ref: 'parent', repo: { full_name: 'contributor/worldmonitor' } } }, { action: 'closed' }),
      gh: () => assert.fail('a fork head is not an upstream base'),
    });
    assert.deepEqual(result.results.map(item => item.pullNumber), [50]);
    assert.equal(result.exitCode, 0);
  });

  it('does not treat an open parent without the child commit as pending', () => {
    const parent = { ...PARENT_6996, state: 'open', merged_at: null, head: { sha: 'a'.repeat(40) } };
    const result = checkStackedMerge({
      mode: 'post-merge', event: pullEvent(CHILD_6997),
      gh: () => JSON.stringify([parent]),
      git: (args) => {
        if (args[0] !== 'merge-base') return '';
        throw Object.assign(new Error('not contained'), { status: 1 });
      },
      issues: { search: () => [], create: () => ({ number: 7007 }), comment: () => {} },
    });
    assert.equal(result.reason, 'integration-unproven');
    assert.equal(result.exitCode, 1);
    assert.equal(result.parents[0].state, 'open');
  });

  it('propagates a parent fetch failure without issuing a false alarm', () => {
    assert.throws(() => checkStackedMerge({
      mode: 'post-merge', event: pullEvent(CHILD_6997),
      gh: () => JSON.stringify([{ number: 6996, state: 'open', head: { sha: 'a'.repeat(40) } }]),
      git: (args) => {
        if (args[0] === 'fetch' && args.at(-1) === 'a'.repeat(40)) throw new Error('parent fetch unavailable');
        if (args[0] !== 'merge-base') return '';
        throw Object.assign(new Error('not on main'), { status: 1 });
      },
      issues: { search: () => assert.fail('must not manufacture an alarm from a fetch error') },
    }), /parent fetch unavailable/);
  });

  it('rechecks nested descendants and keeps them pending through an open grandparent', () => {
    const grandparent = { number: 10, state: 'open', head: { ref: 'grandparent', sha: 'g'.repeat(40) }, base: { ref: 'main' } };
    const parent = { number: 20, state: 'closed', merged_at: '2026-09-11T15:00:00Z', merge_commit_sha: 'b'.repeat(40), head: { ref: 'parent', repo: { full_name: 'koala73/worldmonitor' } }, base: { ref: 'grandparent' } };
    const child = { number: 30, state: 'closed', merged_at: '2026-09-11T14:00:00Z', merge_commit_sha: 'c'.repeat(40), head: { ref: 'child', repo: { full_name: 'koala73/worldmonitor' } }, base: { ref: 'parent' } };
    const pulls = [grandparent, parent, child];
    const result = checkClosedPull({
      event: pullEvent(parent, { action: 'closed' }),
      gh: (args) => {
        const url = new URL(args.at(-1), 'https://api.github.test');
        const base = url.searchParams.get('base');
        const head = url.searchParams.get('head')?.split(':')[1];
        return JSON.stringify(pulls.filter(pull => base ? pull.base.ref === base : pull.head.ref === head));
      },
      git: (args) => {
        if (args[0] !== 'merge-base' || args.at(-1) === grandparent.head.sha) return '';
        throw Object.assign(new Error('not on main'), { status: 1 });
      },
      issues: { search: () => [], create: () => assert.fail('nested stack is still pending') },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.results.map(item => [item.pullNumber, item.reason]), [
      [20, 'pending-parent-integration'], [30, 'pending-parent-integration'],
    ]);
  });

  it('keeps #8035 pending while the open #8003 head contains its merge', () => {
    const mergeSha = 'dd30a8734b88ecea5f91533172b39cb4d20f5446';
    const result = checkStackedMerge({
      mode: 'post-merge',
      event: pullEvent({
        number: 8035,
        merged: true,
        merge_commit_sha: mergeSha,
        base: { ref: 'codex/7990-commodity-evidence' },
      }, { action: 'closed' }),
      gh: () => JSON.stringify([{
        number: 8003,
        state: 'open',
        merged_at: null,
        head: { ref: 'codex/7990-commodity-evidence', sha: mergeSha },
        base: { ref: 'main' },
      }]),
      git: (args) => {
        if (args[0] !== 'merge-base' || args.at(-1) === mergeSha) return '';
        throw Object.assign(new Error('not an ancestor of main'), { status: 1 });
      },
      issues: {
        search: () => [],
        create: () => assert.fail('a contained open stack must not create an orphan alarm'),
        comment: () => assert.fail('a contained open stack must not post an orphan comment'),
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'pending-parent-integration');
    assert.equal(result.exitCode, 0);
  });

  it('passes a push to the default branch without calling GitHub', () => {
    let ghCalls = 0;
    const result = checkStackedMerge({
      mode: 'pre-merge',
      event: pushEvent(),
      gh: () => {
        ghCalls += 1;
        throw new Error('gh should not run on a default-branch push');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'push-to-default');
    assert.equal(ghCalls, 0);
    assert.equal(result.exitCode, 0);
  });

  it('passes a main-based pull_request without listing parent PRs', () => {
    let ghCalls = 0;
    const result = checkStackedMerge({
      mode: 'pre-merge',
      event: pullEvent({
        number: 7003,
        base: { ref: 'main', repo: { owner: { login: 'koala73' } } },
        head: { ref: 'fix/re-land' },
        merged: false,
      }),
      gh: () => {
        ghCalls += 1;
        throw new Error('gh should not run when base is main');
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'base-is-default');
    assert.equal(ghCalls, 0);
  });

  it('blocks pre-merge when the stacked base PR is already merged', () => {
    const result = checkStackedMerge({
      mode: 'pre-merge',
      event: pullEvent({
        ...CHILD_6997,
        merged: false,
        state: 'open',
      }, { action: 'synchronize' }),
      gh: (args) => (args.at(-1) === 'repos/koala73/worldmonitor/pulls/6997'
        ? JSON.stringify(CHILD_6997)
        : JSON.stringify([[PARENT_6996]])),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'base-pr-merged');
    assert.equal(result.exitCode, 1);
    assert.match(result.annotation, /#6996/);
  });

  it('files an issue and comments when a merged PR is not on main', () => {
    const created = [];
    const comments = [];
    const searches = [];
    const gitLog = [];
    const result = checkStackedMerge({
      mode: 'post-merge',
      event: pullEvent(CHILD_6997, { action: 'closed' }),
      gh: () => JSON.stringify([PARENT_6996]),
      git: (args) => {
        gitLog.push(args);
        if (args[0] === 'fetch') return '';
        const error = new Error('git merge-base --is-ancestor failed (1)');
        error.status = 1;
        throw error;
      },
      issues: {
        search: (title) => {
          searches.push(title);
          return [];
        },
        create: (issue) => {
          created.push(issue);
          return { number: 7007, html_url: 'https://github.com/koala73/worldmonitor/issues/7007' };
        },
        comment: (prNumber, body) => {
          comments.push({ prNumber, body });
        },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'integration-unproven');
    assert.equal(result.exitCode, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, `${ISSUE_TITLE_PREFIX} #6997 on main`);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].prNumber, 6997);
    assert.equal(searches.length, 2);
    assert.ok(gitLog.some((args) => args[0] === 'fetch' && args.includes('main')));
  });

  it('does not open a second issue when one already exists for the PR', () => {
    let created = 0;
    const result = checkStackedMerge({
      mode: 'post-merge',
      event: pullEvent(CHILD_6997, { action: 'closed' }),
      gh: () => JSON.stringify([PARENT_6996]),
      git: (args) => {
        if (args[0] === 'fetch') return '';
        const error = new Error('git merge-base --is-ancestor failed (1)');
        error.status = 1;
        throw error;
      },
      issues: {
        search: () => [{ number: 7007, title: `${ISSUE_TITLE_PREFIX} #6997 on main` }],
        create: () => {
          created += 1;
          throw new Error('must not create a duplicate issue');
        },
        comment: () => assert.fail('must not duplicate the comment'),
        update: () => {},
      },
    });
    assert.equal(result.ok, false);
    assert.equal(created, 0);
    assert.equal(result.existingIssue, 7007);
  });

  it('does not file an issue when the merge commit landed on main', () => {
    let created = 0;
    const result = checkStackedMerge({
      mode: 'post-merge',
      event: pullEvent({
        number: 7003,
        merged: true,
        merge_commit_sha: 'e'.repeat(40),
        html_url: 'https://github.com/koala73/worldmonitor/pull/7003',
        title: 're-land',
        base: { ref: 'main', repo: { owner: { login: 'koala73' } } },
      }, { action: 'closed' }),
      git: (args) => {
        if (args[0] === 'fetch' || args[0] === 'cat-file') return '';
        if (args[0] === 'merge-base') return '';
        throw new Error(`unexpected git ${args.join(' ')}`);
      },
      issues: {
        search: () => [],
        create: () => {
          created += 1;
          throw new Error('must not alarm a main merge');
        },
        comment: () => {
          throw new Error('must not comment on a main merge');
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'merge-on-default');
    assert.equal(created, 0);
  });
});

describe('squashed parent integration with real git history', () => {
  const cases = [
    ['preserved child paths', true],
    ['missing child edit', false],
    ['missing child deletion', false],
    ['missing child rename', false],
    ['missing literal path', false],
    ['parent does not contain child', false],
    ['parent merge is not on main', false],
    ['missing parent merge SHA', false],
    ['rebased child preserved', true],
    ['rebased child loses earlier edit', false],
    ['incomplete file list', false],
    ['git diff fails', null],
  ];
  for (const [scenario, integrated] of cases) {
    it(scenario, () => {
      const dir = mkdtempSync(join(tmpdir(), 'stacked-squash-'));
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_')) delete env[key];
      }
      const git = (args) => execFileSync('git', args, {
        cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const commit = (message) => {
        git(['add', '--all']);
        git(['commit', '-m', message]);
        return git(['rev-parse', 'HEAD']).trim();
      };
      const write = (path, value) => writeFileSync(join(dir, path), value);
      try {
        git(['init', '-b', 'main']);
        git(['config', 'user.name', 'Detector test']);
        git(['config', 'user.email', 'detector@example.invalid']);
        git(['config', 'commit.gpgsign', 'false']);
        git(['config', 'core.hooksPath', '/dev/null']);
        git(['remote', 'add', 'origin', dir]);
        write('target', 'before\n');
        write('removed', 'old\n');
        write('old name', 'rename me\n');
        commit('main');
        git(['checkout', '-b', 'parent']);
        write('parent-only', 'parent\n');
        const beforeChild = commit('parent change');
        git(['checkout', '-b', 'child']);
        write('early-only', 'first child commit\n');
        commit('first child change');
        write('target', 'child\n');
        write(':(glob)*', 'literal path\n');
        git(['rm', 'removed']);
        git(['mv', 'old name', 'new\nname']);
        commit('child change');
        git(['checkout', 'parent']);
        git(['merge', scenario.startsWith('rebased child') ? '--ff-only' : '--no-ff', 'child', '-m', 'merge child']);
        const childMerge = git(['rev-parse', 'HEAD']).trim();
        write('target', 'child with parent follow-up\n');
        const parentHead = commit('parent follow-up');
        git(['checkout', 'main']);
        write('unrelated', 'concurrent main change\n');
        commit('main advances');
        if (scenario === 'parent merge is not on main') git(['checkout', '-b', 'unlanded']);
        git(['merge', '--squash', 'parent']);
        if (scenario === 'missing child edit') write('target', 'before\n');
        if (scenario === 'missing child deletion') write('removed', 'old\n');
        if (scenario === 'missing child rename') write('old name', 'rename me\n');
        if (scenario === 'missing literal path') rmSync(join(dir, ':(glob)*'));
        if (scenario === 'rebased child loses earlier edit') rmSync(join(dir, 'early-only'));
        const parentMerge = commit('squash parent');
        const parent = {
          number: 8455, state: 'closed', merged: true,
          merge_commit_sha: scenario === 'missing parent merge SHA' ? null : parentMerge,
          head: { ref: 'parent', sha: scenario === 'parent does not contain child' ? beforeChild : parentHead },
          base: { ref: 'main' },
        };
        const child = {
          number: 8465, state: 'closed', merged: true, merge_commit_sha: childMerge,
          base: { ref: 'parent' }, changed_files: 5,
        };
        const alarm = { number: 8471, state: 'open', title: `${ISSUE_TITLE_PREFIX} #8465 on main` };
        let closes = 0;
        let mutations = 0;
        const run = () => checkStackedMerge({
          mode: 'post-merge', event: pullEvent(child, { action: 'closed' }),
          gh: (args) => {
            const route = args.at(-1);
            if (route.endsWith('/pulls/8465')) return JSON.stringify(child);
            if (route.includes('/pulls/8465/files')) {
              const files = [
                { filename: 'early-only' }, { filename: 'target' }, { filename: 'removed' },
                { filename: 'new\nname', previous_filename: 'old name' }, { filename: ':(glob)*' },
              ];
              return JSON.stringify(scenario === 'incomplete file list' ? files.slice(1) : files);
            }
            return JSON.stringify([parent]);
          },
          git: (args) => {
            if (scenario === 'git diff fails' && args.includes('diff') && args.includes('--quiet')) {
              throw Object.assign(new Error('diff failed'), { status: 128 });
            }
            return git(args);
          },
          issues: {
            search: (title) => title === alarm.title ? [alarm] : [],
            create: () => assert.fail('must not duplicate the alarm'),
            comment: () => assert.fail('must not duplicate the comment'),
            update: (_number, fields) => { mutations++; Object.assign(alarm, fields); },
            close: (number, body) => {
              assert.equal(number, 8471);
              closes++;
              mutations++;
              Object.assign(alarm, { state: 'closed', body });
            },
          },
        });
        if (integrated === null) {
          assert.throws(run, /diff failed/);
          assert.equal(mutations, 0, 'Git errors must not mutate issue state');
          return;
        }
        const result = run();
        assert.equal(result.ok, integrated);
        assert.equal(result.reason, integrated ? 'content-on-default' : 'integration-unproven');
        assert.equal(alarm.state, integrated ? 'closed' : 'open');
        if (integrated) {
          assert.equal(result.integratedParent.number, 8455);
          assert.match(alarm.body, /content.*confirmed/);
          assert.ok(alarm.body.includes(parentHead));
          assert.ok(alarm.body.includes(parentMerge));
          assert.doesNotMatch(alarm.body, /Merge commit .* is an ancestor/);
          run();
          assert.equal(closes, 1, 'rechecking must not close or comment twice');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('CLI replay of the recorded tombstone', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const script = join(root, 'scripts/check-stacked-merge.mjs');

  it('exits 1 for the #6996 → #6997 base after the parent merged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stacked-merge-'));
    try {
      const eventPath = join(dir, 'event.json');
      const ghPath = join(dir, 'gh');
      writeFileSync(eventPath, JSON.stringify({
        action: 'synchronize',
        pull_request: {
          number: 6997,
          merged: false,
          title: CHILD_6997.title,
          html_url: CHILD_6997.html_url,
          base: CHILD_6997.base,
          head: CHILD_6997.head,
        },
        repository: { default_branch: 'main', full_name: 'koala73/worldmonitor' },
      }));
      writeFileSync(ghPath, `#!/bin/sh
case "$*" in
  *pulls/6997) echo '{"number":6997,"base":{"ref":"fix/aviation-budget-binds-v2"}}' ;;
  *) echo '[[{"number":6996,"merged_at":"2026-08-20T12:53:04Z","title":"parent","html_url":"https://github.com/koala73/worldmonitor/pull/6996","state":"closed","base":{"ref":"main"}}]]' ;;
esac
`);
      chmodSync(ghPath, 0o755);
      const result = spawnSync(process.execPath, [script, '--mode', 'pre-merge'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: 'pull_request',
        },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /#6996/);
      assert.match(result.stderr, /orphaned branch/);
      assert.match(result.stderr, /gh pr edit 6997 --base main/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('closed stack CLI with real git ancestry', () => {
  it('keeps a live stack pending, alerts on abandonment, and closes the alarm after integration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stacked-lifecycle-'));
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/check-stacked-merge.mjs');
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('GIT_')) delete env[key];
    }
    const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git('init', '-b', 'main');
      git('config', 'user.name', 'Detector test');
      git('config', 'user.email', 'detector@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'core.hooksPath', '/dev/null');
      git('commit', '--allow-empty', '-m', 'main');
      git('remote', 'add', 'origin', dir);
      git('checkout', '-b', 'parent');
      git('commit', '--allow-empty', '-m', 'child merged into parent');
      const childSha = git('rev-parse', 'HEAD');
      git('branch', 'child');
      const parent = { number: 8003, state: 'open', merged_at: null, head: { ref: 'parent', sha: childSha, repo: { full_name: 'koala73/worldmonitor' } }, base: { ref: 'main' } };
      const child = { number: 8035, state: 'closed', merged: true, merged_at: '2026-09-11T14:05:06Z', merge_commit_sha: childSha, head: { ref: 'child', sha: childSha, repo: { full_name: 'koala73/worldmonitor' } }, base: { ref: 'parent' } };
      const statePath = join(dir, 'api.json');
      const eventPath = join(dir, 'event.json');
      const state = { pulls: [parent, child], issues: [], comments: [] };
      writeFileSync(statePath, JSON.stringify(state));
      writeFileSync(join(dir, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.DETECTOR_API));
const args = process.argv.slice(2);
let answer;
if (args[0] === 'issue' && args[1] === 'list') {
  const title = args[args.indexOf('--search') + 1].replace(/ in:title$/, '');
  answer = state.issues.filter(issue => issue.title === title);
} else {
  const route = args.find(arg => arg.startsWith('repos/'));
  const url = new URL(route, 'https://api.github.test/');
  const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : {};
  if (url.pathname.endsWith('/pulls')) {
    answer = state.pulls.filter(pull => {
      const head = url.searchParams.get('head');
      const base = url.searchParams.get('base');
      return (!head || pull.head.ref === head.slice(head.indexOf(':') + 1))
        && (!base || pull.base.ref === base)
        && (url.searchParams.get('state') !== 'closed' || pull.state === 'closed');
    });
  } else if (url.pathname.endsWith('/comments')) {
    state.comments.push(input.body);
    answer = {};
  } else if (url.pathname.endsWith('/issues')) {
    answer = { number: 8041, state: 'open', ...input };
    state.issues.push(answer);
  } else {
    const issue = state.issues.find(item => item.number === Number(url.pathname.split('/').at(-1)));
    if (!issue) throw new Error('unexpected request ' + args.join(' '));
    Object.assign(issue, input);
    answer = issue;
  }
}
fs.writeFileSync(process.env.DETECTOR_API, JSON.stringify(state));
console.log(JSON.stringify(answer));
`, { mode: 0o755 });
      const run = (pull) => {
        writeFileSync(eventPath, JSON.stringify(pullEvent(pull, { action: 'closed' })));
        const result = spawnSync(process.execPath, [script, '--mode', 'post-merge', '--json'], {
          cwd: dir,
          env: { ...env, PATH: `${dir}:${env.PATH}`, DETECTOR_API: statePath, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'pull_request' },
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.ok(result.stdout, result.stderr);
        return { status: result.status, result: JSON.parse(result.stdout), state: JSON.parse(readFileSync(statePath, 'utf8')) };
      };
      const pending = run(child);
      assert.equal(pending.status, 0);
      assert.equal(pending.result.results.find(item => item.pullNumber === 8035).reason, 'pending-parent-integration');
      assert.equal(pending.state.issues.length, 0);

      state.issues.push({ number: 8041, state: 'open', title: 'Orphaned stacked merge: #8035 never reached main', body: 'old false alarm' });
      writeFileSync(statePath, JSON.stringify(state));
      const corrected = run(child);
      assert.equal(corrected.state.issues.length, 1);
      assert.equal(corrected.state.issues[0].title, 'Stacked merge integration: #8035 on main');
      assert.match(corrected.state.issues[0].body, /pending integration/);
      assert.equal(corrected.state.issues[0].state, 'open');
      assert.equal(corrected.state.comments.length, 0);

      parent.state = 'closed';
      state.issues = [];
      writeFileSync(statePath, JSON.stringify(state));
      const abandoned = run(parent);
      assert.equal(abandoned.status, 1);
      assert.equal(abandoned.result.results.find(item => item.pullNumber === 8035).reason, 'integration-unproven');
      assert.equal(abandoned.state.issues.length, 1);
      assert.doesNotMatch(abandoned.state.issues[0].body, /lands on a tombstone|Re-land the commits/);
      const repeated = run(parent);
      assert.equal(repeated.state.issues.length, 1);
      assert.equal(repeated.state.comments.length, abandoned.state.comments.length);

      git('checkout', 'main');
      git('merge', '--ff-only', 'parent');
      parent.merged = true;
      parent.merged_at = '2026-09-11T18:00:06Z';
      parent.merge_commit_sha = childSha;
      repeated.state.pulls = [parent, child];
      repeated.state.issues[0].title = 'Orphaned stacked merge: #8035 never reached main';
      writeFileSync(statePath, JSON.stringify(repeated.state));
      const integrated = run(parent);
      assert.equal(integrated.status, 0);
      assert.equal(integrated.result.results.find(item => item.pullNumber === 8035).reason, 'merge-on-default');
      assert.equal(integrated.state.issues[0].state, 'closed');
      assert.match(integrated.state.issues[0].body, /is confirmed/);
      assert.doesNotMatch(integrated.state.issues[0].body, /is unproven|has not been confirmed/);
      assert.equal(run(parent).state.comments.length, integrated.state.comments.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// #8518 → #8519/#8520 (2026-09-22): the parent squash-merged to main, its
// branch was not deleted, so GitHub never retargeted the children. Both then
// merged into the orphaned branch on a stacked-merge-guard success recorded
// 40 minutes before the parent merged. No pull_request event fires on a child
// when its parent merges, so nothing re-evaluated them.
const PARENT_8518 = Object.freeze({
  number: 8518,
  title: 'fix(live-news): play Live News through the verified live video session (3/5)',
  html_url: 'https://github.com/koala73/worldmonitor/pull/8518',
  state: 'closed',
  merged: true,
  merged_at: '2026-09-22T20:45:49Z',
  base: { ref: 'main', repo: { full_name: 'koala73/worldmonitor' } },
  head: { ref: 'feat/live-news-session-v2', sha: '4e9b2b9edacf0b485cf09824dd003b14f8420610', repo: { full_name: 'koala73/worldmonitor' } },
});

const CHILD_8519 = Object.freeze({
  number: 8519,
  title: 'feat(live-video): file a daily issue listing live video slots that need a replacement (4/5)',
  state: 'open',
  merged: false,
  merged_at: null,
  base: { ref: 'feat/live-news-session-v2', repo: { full_name: 'koala73/worldmonitor', owner: { login: 'koala73' } } },
  head: { ref: 'feat/live-video-audit-v2', sha: 'a490f44bb9b2e982f3b7f076ed28df45c499e3d6', repo: { full_name: 'koala73/worldmonitor' } },
});

const CHILD_8520 = Object.freeze({
  ...CHILD_8519,
  number: 8520,
  title: 'chore(live-video): retire the YouTube live scraper (5/5)',
  head: { ref: 'chore/retire-youtube-live-scraper-v2', sha: 'd1e4988d6c51ad82ba570e249e739629b738c93d', repo: { full_name: 'koala73/worldmonitor' } },
});

describe('#8518 → #8519 orphaned-base guard', () => {
  it('fails #8519 once its base branch is the head of merged #8518', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: CHILD_8519.base.ref,
      baseHeadPulls: [PARENT_8518],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'base-pr-merged');
  });

  it('passes #8519 while #8518 is still open, as before the incident', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: CHILD_8519.base.ref,
      baseHeadPulls: [{ ...PARENT_8518, state: 'open', merged: false, merged_at: null }],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'base-pr-open');
  });

  it('passes #8519 once it is based on main', () => {
    const verdict = evaluatePreMergeGuard({ defaultBranch: 'main', baseRef: 'main', baseHeadPulls: [PARENT_8518] });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'base-is-default');
  });

  it('fails a child whose base PR was closed without merging', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: CHILD_8519.base.ref,
      baseHeadPulls: [{ ...PARENT_8518, merged: false, merged_at: null }],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'base-pr-closed');
    assert.deepEqual(verdict.closedPrs.map(pr => pr.number), [8518]);
  });

  it('prefers a reopened open PR over an older closed one on the same head', () => {
    const verdict = evaluatePreMergeGuard({
      defaultBranch: 'main',
      baseRef: CHILD_8519.base.ref,
      baseHeadPulls: [
        { ...PARENT_8518, number: 8166, merged: false, merged_at: null },
        { ...PARENT_8518, state: 'open', merged: false, merged_at: null },
      ],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.reason, 'base-pr-open');
  });

  it('tells the author to retarget to the merged parent base', () => {
    const result = checkStackedMerge({
      mode: 'pre-merge',
      event: pullEvent(CHILD_8519),
      gh: (args) => {
        if (args.at(-1) === 'repos/koala73/worldmonitor/pulls/8519') return JSON.stringify(CHILD_8519);
        return JSON.stringify([[PARENT_8518]]);
      },
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.annotation, /#8518/);
    assert.match(result.annotation, /gh pr edit 8519 --base main/);
  });

  it('re-evaluates the live base, not the stale event payload, on a rerun', () => {
    const calls = [];
    const result = checkStackedMerge({
      mode: 'pre-merge',
      // A rerun replays the original payload, whose base still names the parent branch.
      event: pullEvent(CHILD_8519),
      gh: (args) => {
        calls.push(args.at(-1));
        if (args.at(-1) === 'repos/koala73/worldmonitor/pulls/8519') {
          return JSON.stringify({ ...CHILD_8519, base: { ...CHILD_8519.base, ref: 'main' } });
        }
        return JSON.stringify([[PARENT_8518]]);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'base-is-default');
    assert.deepEqual(calls, ['repos/koala73/worldmonitor/pulls/8519']);
  });

  it('reads the live base on a rerun even when the stale payload names the default branch', () => {
    const calls = [];
    const result = checkStackedMerge({
      mode: 'pre-merge',
      // The original run saw `main`; the PR has since been moved onto the merged parent's branch.
      event: pullEvent({ ...CHILD_8519, base: { ...CHILD_8519.base, ref: 'main' } }),
      runAttempt: 2,
      gh: (args) => {
        calls.push(args.at(-1));
        if (args.at(-1) === 'repos/koala73/worldmonitor/pulls/8519') return JSON.stringify(CHILD_8519);
        return JSON.stringify([[PARENT_8518]]);
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'base-pr-merged');
    assert.equal(calls[0], 'repos/koala73/worldmonitor/pulls/8519');
  });

  it('makes no API call on a first run whose payload names the default branch', () => {
    const result = checkStackedMerge({
      mode: 'pre-merge',
      event: pullEvent({ ...CHILD_8519, base: { ...CHILD_8519.base, ref: 'main' } }),
      runAttempt: 1,
      gh: () => { throw new Error('gh must not be called'); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'base-is-default');
  });
});

describe('stacked child retarget plan', () => {
  const repository = 'koala73/worldmonitor';

  it('retargets #8519 and #8520 to main when #8518 merges', () => {
    const plan = planStackRetargets({
      closedPull: PARENT_8518,
      openChildren: [CHILD_8519, CHILD_8520],
      repository,
      defaultBranch: 'main',
    });
    assert.deepEqual(plan, [
      { number: 8519, headSha: CHILD_8519.head.sha, action: 'retarget', from: 'feat/live-news-session-v2', to: 'main' },
      { number: 8520, headSha: CHILD_8520.head.sha, action: 'retarget', from: 'feat/live-news-session-v2', to: 'main' },
    ]);
  });

  it('retargets a grandchild to its merged parent base, as GitHub does on branch deletion', () => {
    const middle = { ...PARENT_8518, base: { ref: 'feat/grandparent', repo: { full_name: repository } } };
    const plan = planStackRetargets({ closedPull: middle, openChildren: [CHILD_8519], repository, defaultBranch: 'main' });
    assert.equal(plan[0].action, 'retarget');
    assert.equal(plan[0].to, 'feat/grandparent');
  });

  it('flags but does not retarget children of a parent closed without merging', () => {
    const plan = planStackRetargets({
      closedPull: { ...PARENT_8518, merged: false, merged_at: null },
      openChildren: [CHILD_8519],
      repository,
      defaultBranch: 'main',
    });
    assert.deepEqual(plan.map(item => [item.number, item.action]), [[8519, 'strand']]);
  });

  it('ignores a fork head, a default-branch head, an unknown head repo, closed children and other bases', () => {
    const fork = { ...PARENT_8518, head: { ...PARENT_8518.head, repo: { full_name: 'contributor/worldmonitor' } } };
    assert.deepEqual(planStackRetargets({ closedPull: fork, openChildren: [CHILD_8519], repository, defaultBranch: 'main' }), []);
    const mainHead = { ...PARENT_8518, head: { ...PARENT_8518.head, ref: 'main' } };
    assert.deepEqual(planStackRetargets({ closedPull: mainHead, openChildren: [CHILD_8519], repository, defaultBranch: 'main' }), []);
    const unknownHead = { ...PARENT_8518, head: { ref: 'feat/live-news-session-v2' } };
    assert.deepEqual(planStackRetargets({ closedPull: unknownHead, openChildren: [CHILD_8519], repository, defaultBranch: 'main' }), []);
    const others = [
      { ...CHILD_8519, state: 'closed' },
      { ...CHILD_8519, base: { ...CHILD_8519.base, ref: 'feat/other' } },
      { ...CHILD_8519, base: { ...CHILD_8519.base, repo: { full_name: 'contributor/worldmonitor' } } },
    ];
    assert.deepEqual(planStackRetargets({ closedPull: PARENT_8518, openChildren: others, repository, defaultBranch: 'main' }), []);
  });
});

describe('retargetStackedChildren executor', () => {
  function fakeGh(children, { failPatch = new Set(), failRerun = false } = {}) {
    const log = [];
    const gh = (args, options = {}) => {
      const path = args.find(arg => arg.startsWith('repos/'));
      const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
      log.push({ method, path, input: options.input ? JSON.parse(options.input) : undefined });
      if (path.includes('/pulls?state=open&base=')) return JSON.stringify([children]);
      if (method === 'PATCH') {
        const number = Number(path.split('/').at(-1));
        if (failPatch.has(number)) throw new Error(`patch ${number} refused`);
        return '{}';
      }
      if (path.includes('/actions/workflows/stacked-merge-guard.yml/runs')) {
        const sha = new URL(path, 'https://api.github.test').searchParams.get('head_sha');
        return JSON.stringify({ workflow_runs: [{ id: sha.slice(0, 6), head_sha: sha }] });
      }
      if (path.endsWith('/rerun')) {
        if (failRerun) throw new Error('rerun refused');
        return '';
      }
      if (path.endsWith('/comments')) return '{}';
      throw new Error(`unexpected gh ${method} ${path}`);
    };
    return { gh, log };
  }

  it('retargets, comments on, and re-runs the guard for each orphaned child', () => {
    const { gh, log } = fakeGh([CHILD_8519, CHILD_8520]);
    const result = retargetStackedChildren({ event: pullEvent(PARENT_8518, { action: 'closed' }), gh });
    assert.equal(result.exitCode, 0);
    assert.equal(log[0].path, 'repos/koala73/worldmonitor/pulls?state=open&base=feat%2Flive-news-session-v2&per_page=100');
    const patches = log.filter(entry => entry.method === 'PATCH');
    assert.deepEqual(patches.map(entry => [entry.path, entry.input]), [
      ['repos/koala73/worldmonitor/pulls/8519', { base: 'main' }],
      ['repos/koala73/worldmonitor/pulls/8520', { base: 'main' }],
    ]);
    assert.deepEqual(log.filter(entry => entry.path.endsWith('/rerun')).map(entry => entry.path), [
      'repos/koala73/worldmonitor/actions/runs/a490f4/rerun',
      'repos/koala73/worldmonitor/actions/runs/d1e498/rerun',
    ]);
    const comments = log.filter(entry => entry.path.endsWith('/comments'));
    assert.deepEqual(comments.map(entry => entry.path), [
      'repos/koala73/worldmonitor/issues/8519/comments',
      'repos/koala73/worldmonitor/issues/8520/comments',
    ]);
    assert.match(comments[0].input.body, /#8518/);
    assert.match(comments[0].input.body, /`main`/);
  });

  it('keeps going after one retarget fails and reports it as a failure', () => {
    const { gh, log } = fakeGh([CHILD_8519, CHILD_8520], { failPatch: new Set([8519]) });
    const result = retargetStackedChildren({ event: pullEvent(PARENT_8518, { action: 'closed' }), gh });
    assert.equal(result.exitCode, 1);
    assert.match(result.annotation, /#8519/);
    assert.ok(log.some(entry => entry.method === 'PATCH' && entry.path.endsWith('/8520')));
    // The un-retargeted child still gets a fresh guard run, which fails against the merged base.
    assert.ok(log.some(entry => entry.path.endsWith('a490f4/rerun')));
  });

  it('comments on and re-runs the guard for a child stranded by a parent closed unmerged', () => {
    const { gh, log } = fakeGh([CHILD_8519]);
    const closed = { ...PARENT_8518, merged: false, merged_at: null };
    const result = retargetStackedChildren({ event: pullEvent(closed, { action: 'closed' }), gh });
    assert.equal(result.exitCode, 0);
    assert.equal(log.filter(entry => entry.method === 'PATCH').length, 0);
    const comment = log.find(entry => entry.path.endsWith('/comments'));
    assert.match(comment.input.body, /closed without merging/);
    assert.ok(log.some(entry => entry.path.endsWith('/rerun')));
  });

  it('treats a refused guard rerun as a warning for a retargeted child', () => {
    const { gh } = fakeGh([CHILD_8519], { failRerun: true });
    const result = retargetStackedChildren({ event: pullEvent(PARENT_8518, { action: 'closed' }), gh });
    assert.equal(result.exitCode, 0);
    assert.equal(result.warnings.length, 1);
  });

  it('fails when the guard cannot be re-run for a child stranded by an unmerged parent', () => {
    // The stranded child keeps a guard verdict computed while the parent was open,
    // so without a fresh run nothing flags it; the monitor must not report success.
    const { gh } = fakeGh([CHILD_8519], { failRerun: true });
    const closed = { ...PARENT_8518, merged: false, merged_at: null };
    const result = retargetStackedChildren({ event: pullEvent(closed, { action: 'closed' }), gh });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.match(result.annotation, /#8519/);
  });

  it('only lists children for a PR with no stacked children', () => {
    const { gh, log } = fakeGh([]);
    const result = retargetStackedChildren({ event: pullEvent(PARENT_8518, { action: 'closed' }), gh });
    assert.equal(result.exitCode, 0);
    assert.equal(log.length, 1);
  });

  it('never queries or writes for a fork head', () => {
    const fork = { ...PARENT_8518, head: { ...PARENT_8518.head, repo: { full_name: 'contributor/worldmonitor' } } };
    const result = retargetStackedChildren({
      event: pullEvent(fork, { action: 'closed' }),
      gh: () => assert.fail('a fork head cannot be an upstream base'),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, 'no-stacked-base');
  });
});
