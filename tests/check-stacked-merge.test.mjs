// #7006 — a stacked PR can merge successfully into a deleted parent branch
// and never reach main. GitHub still paints the PR MERGED. The decision
// functions below are the gate: they must trip on the recorded #6996 → #6997
// and #6991 → #6993 sequences, and they must stay quiet for a PR based on
// main and for a live stack whose parent is still open.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ISSUE_TITLE_PREFIX,
  checkStackedMerge,
  evaluatePostMergeAncestry,
  evaluatePreMergeGuard,
  flattenGhPages,
  formatOrphanComment,
  formatOrphanIssue,
  isCommitAncestor,
  listPullsByHead,
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
    assert.equal(verdict.reason, 'orphaned-merge');
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
      mergedParents: [PARENT_6996],
      reason: 'orphaned-merge',
    });
    assert.equal(issue.title, `${ISSUE_TITLE_PREFIX} #6997 never reached main`);
    assert.match(issue.body, /#6997/);
    assert.match(issue.body, /#6996/);
    assert.match(issue.body, /fix\/aviation-budget-binds-v2/);
    assert.match(issue.body, /#7006/);
    assert.equal(issue.title.includes('Fixes'), false);

    const comment = formatOrphanComment({
      pull: CHILD_6997,
      mergeSha: CHILD_6997.merge_commit_sha,
      defaultBranch: 'main',
      mergedParents: [PARENT_6996],
      reason: 'orphaned-merge',
    });
    assert.match(comment, /never reached `main`/);
    assert.match(comment, /#6996/);
  });
});

describe('checkStackedMerge orchestrator', () => {
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
      gh: () => JSON.stringify([[PARENT_6996]]),
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
    assert.equal(result.reason, 'orphaned-merge');
    assert.equal(result.exitCode, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].title, `${ISSUE_TITLE_PREFIX} #6997 never reached main`);
    assert.equal(comments.length, 1);
    assert.equal(comments[0].prNumber, 6997);
    assert.equal(searches.length, 1);
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
        search: () => [{ number: 7007, title: `${ISSUE_TITLE_PREFIX} #6997 never reached main` }],
        create: () => {
          created += 1;
          throw new Error('must not create a duplicate issue');
        },
        comment: () => {},
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
        if (args[0] === 'fetch') return '';
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
echo '[[{"number":6996,"merged_at":"2026-08-20T12:53:04Z","title":"parent","html_url":"https://github.com/koala73/worldmonitor/pull/6996","state":"closed"}]]'
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
      assert.match(result.stderr, /tombstone/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
