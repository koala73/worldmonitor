#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';

export const ISSUE_TITLE_PREFIX = 'Stacked merge integration:';
const LEGACY_ISSUE_TITLE_PREFIX = 'Orphaned stacked merge:';

const GH_CALL_TIMEOUT_MS = 30_000;
const ANCESTRY_RETRY_ATTEMPTS = 3;
const ANCESTRY_RETRY_MS = 2_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function flattenGhPages(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`expected a JSON array of pull requests, got ${typeof parsed}`);
  }
  if (parsed.length > 0 && Array.isArray(parsed[0])) {
    return parsed.flat();
  }
  return parsed;
}

function isMergedPull(pull) {
  if (!pull || typeof pull !== 'object') return false;
  if (pull.merged === true) return true;
  return typeof pull.merged_at === 'string' && pull.merged_at.length > 0;
}

export function evaluatePreMergeGuard({ defaultBranch, baseRef, baseHeadPulls }) {
  if (!baseRef || baseRef === defaultBranch) {
    return { ok: true, reason: 'base-is-default' };
  }
  const pulls = Array.isArray(baseHeadPulls) ? baseHeadPulls : [];
  const mergedPrs = pulls.filter(isMergedPull);
  if (mergedPrs.length > 0) {
    return { ok: false, reason: 'base-pr-merged', mergedPrs };
  }
  if (pulls.some((pull) => pull?.state === 'open')) {
    return { ok: true, reason: 'base-pr-open' };
  }
  return { ok: true, reason: 'base-pr-absent' };
}

export function evaluatePostMergeAncestry({ merged, mergeSha, isAncestor, pendingParent }) {
  if (!merged) {
    return { ok: true, reason: 'not-merged' };
  }
  if (typeof mergeSha !== 'string' || mergeSha.length === 0) {
    return { ok: false, reason: 'missing-merge-sha' };
  }
  if (isAncestor) {
    return { ok: true, reason: 'merge-on-default' };
  }
  if (pendingParent) {
    return { ok: true, reason: 'pending-parent-integration', pendingParent };
  }
  return { ok: false, reason: 'integration-unproven' };
}

export function listPullsByHead({ gh, repository, owner, headRef }) {
  const head = encodeURIComponent(`${owner}:${headRef}`);
  const raw = gh([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repository}/pulls?state=all&head=${head}`,
  ]);
  return flattenGhPages(raw);
}

export function isCommitAncestor({ git, commit, ref }) {
  try {
    git(['merge-base', '--is-ancestor', commit, ref]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function pullLabel(pull) {
  const number = pull?.number != null ? `#${pull.number}` : 'an unknown PR';
  const url = typeof pull?.html_url === 'string' ? ` (${pull.html_url})` : '';
  const title = typeof pull?.title === 'string' && pull.title.length > 0 ? ` (${pull.title})` : '';
  return `${number}${title}${url}`;
}

function parentList(parents) {
  if (!Array.isArray(parents) || parents.length === 0) {
    return 'none found for the stacked base branch';
  }
  return parents.map((pull) => `- ${pullLabel(pull)}. State: ${isMergedPull(pull) ? 'merged' : pull.state || 'unknown'}.`).join('\n');
}

export function formatOrphanIssue({ pull, mergeSha, defaultBranch, parents = [], reason }) {
  const number = pull?.number ?? '?';
  const title = `${ISSUE_TITLE_PREFIX} #${number} on ${defaultBranch}`;
  if (reason === 'merge-on-default') {
    return {
      title,
      body: `Integration of PR ${pullLabel(pull)} is confirmed. Merge commit \`${mergeSha}\` is an ancestor of \`${defaultBranch}\`.`,
    };
  }
  const body = [
    reason === 'pending-parent-integration'
      ? `Merged PR ${pullLabel(pull)} is pending integration through an open parent that contains its merge commit.`
      : `Integration of merged PR ${pullLabel(pull)} into \`${defaultBranch}\` is unproven.`,
    '',
    `- Merge SHA: \`${mergeSha || 'missing'}\``,
    `- PR base: \`${pull?.base?.ref || 'unknown'}\``,
    `- Reason: \`${reason}\``,
    '',
    'Parent PR(s) for that base branch:',
    parentList(parents),
    '',
    `The merge commit has not been confirmed as an ancestor of \`${defaultBranch}\`. This does not establish branch deletion or lost changes. Squash and rebase merges can also change commit identity. Inspect the parent history and content before choosing a recovery action. See #7006.`,
  ].join('\n');
  return { title, body };
}

export function formatOrphanComment({ pull, mergeSha, defaultBranch, parents = [], reason }) {
  return [
    `Integration into \`${defaultBranch}\` is unproven for merge commit \`${mergeSha || 'missing'}\` (${reason}).`,
    '',
    `Stacked base: \`${pull?.base?.ref || 'unknown'}\`. Parent PR(s):`,
    parentList(parents),
    '',
    'Inspect parent history and content before choosing a recovery action. See #7006.',
  ].join('\n');
}

function preMergeAnnotation(verdict, baseRef) {
  const parents = (verdict.mergedPrs || []).map((pull) => `#${pull.number}`).join(', ');
  return `::error::Stacked PR base \`${baseRef}\` already merged in ${parents}. Merging would land on a tombstone, not the default branch. See #7006.`;
}

function postMergeAnnotation(verdict, mergeSha, defaultBranch) {
  if (verdict.reason === 'missing-merge-sha') {
    return `::error::Merged PR has no merge commit SHA, so it cannot be proven on \`${defaultBranch}\`. See #7006.`;
  }
  return `::error::Merge commit \`${mergeSha}\` is not an ancestor of \`${defaultBranch}\` and no containing open parent was confirmed. Integration remains unproven. See #7006.`;
}

function repositoryFromEvent(event) {
  return event?.repository?.full_name
    || event?.repository?.fullName
    || process.env.GITHUB_REPOSITORY
    || 'koala73/worldmonitor';
}

function defaultBranchFromEvent(event) {
  return event?.repository?.default_branch || 'main';
}

function confirmAncestry({ git, commit, ref, defaultBranch, shouldRetry, sleep }) {
  try {
    git(['cat-file', '-e', `${commit}^{commit}`]);
  } catch (error) {
    if (error?.status !== 1 && error?.status !== 128) throw error;
    git(['fetch', '--quiet', 'origin', commit]);
  }
  const attempts = shouldRetry ? ANCESTRY_RETRY_ATTEMPTS : 1;
  let last = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    git(['fetch', '--quiet', 'origin', defaultBranch]);
    last = isCommitAncestor({ git, commit, ref });
    if (last) return true;
    if (attempt < attempts - 1) sleep(ANCESTRY_RETRY_MS);
  }
  return last;
}

function findPendingParent({ gh, git, repository, defaultBranch, pull, mergeSha }) {
  const parents = [];
  const queue = [pull];
  const visited = new Set([pull.number]);
  for (const current of queue) {
    const baseRef = current.base?.ref;
    if (!baseRef || baseRef === defaultBranch) continue;
    const owner = current.base?.repo?.owner?.login || repository.split('/')[0];
    for (const parent of listPullsByHead({ gh, repository, owner, headRef: baseRef })) {
      if (parent.head?.repo?.full_name && parent.head.repo.full_name !== repository) continue;
      if (visited.has(parent.number)) continue;
      visited.add(parent.number);
      parents.push(parent);
      if (parent.state === 'open' && parent.head?.sha) {
        git(['fetch', '--quiet', 'origin', parent.head.sha]);
        if (isCommitAncestor({ git, commit: mergeSha, ref: parent.head.sha })) {
          return { parents, pendingParent: parent };
        }
      } else if (isMergedPull(parent)) {
        queue.push(parent);
      }
    }
  }
  return { parents };
}

function defaultIssues(gh, repository) {
  return {
    search(title) {
      const raw = gh([
        'issue',
        'list',
        '--repo',
        repository,
        '--state',
        'all',
        '--search',
        `${title} in:title`,
        '--json',
        'number,title,url,state,body',
      ]);
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.filter((issue) => issue?.title === title) : [];
    },
    create(issue) {
      const raw = gh(
        ['api', `repos/${repository}/issues`, '--input', '-'],
        { input: JSON.stringify({ title: issue.title, body: issue.body }) },
      );
      return JSON.parse(raw);
    },
    update(number, fields) {
      gh(
        ['api', `repos/${repository}/issues/${number}`, '--method', 'PATCH', '--input', '-'],
        { input: JSON.stringify(fields) },
      );
    },
    close(number, body) {
      this.update(number, { state: 'closed', body });
    },
    comment(prNumber, body) {
      gh(
        ['api', `repos/${repository}/issues/${prNumber}/comments`, '--input', '-'],
        { input: JSON.stringify({ body }) },
      );
    },
  };
}

export function checkStackedMerge({
  mode,
  event,
  gh,
  git,
  issues,
  sleep = () => {},
} = {}) {
  if (mode !== 'pre-merge' && mode !== 'post-merge') {
    throw new Error(`unknown mode ${mode}`);
  }

  const repository = repositoryFromEvent(event);
  const defaultBranch = defaultBranchFromEvent(event);
  const eventName = event?.eventName || event?.action && 'pull_request';

  if (mode === 'pre-merge' && eventName === 'push') {
    return { ok: true, reason: 'push-to-default', exitCode: 0 };
  }

  const pull = event?.pull_request;
  if (!pull) {
    throw new Error('a pull_request payload is required unless this is a push to the default branch');
  }

  const baseRef = pull.base?.ref;
  const owner = pull.base?.repo?.owner?.login || repository.split('/')[0];

  if (mode === 'pre-merge') {
    let baseHeadPulls = [];
    if (baseRef && baseRef !== defaultBranch) {
      if (typeof gh !== 'function') {
        throw new Error('gh is required to look up the stacked base PR');
      }
      baseHeadPulls = listPullsByHead({ gh, repository, owner, headRef: baseRef });
    }
    const verdict = evaluatePreMergeGuard({ defaultBranch, baseRef, baseHeadPulls });
    if (verdict.ok) {
      return { ...verdict, exitCode: 0 };
    }
    return {
      ...verdict,
      exitCode: 1,
      annotation: preMergeAnnotation(verdict, baseRef),
    };
  }

  const mergeSha = pull.merge_commit_sha;
  const merged = isMergedPull(pull);
  if (!merged) return { ok: true, reason: 'not-merged', exitCode: 0 };
  if (typeof git !== 'function') {
    throw new Error('git is required to prove the merge commit reached the default branch');
  }
  const ref = `origin/${defaultBranch}`;
  const isAncestor = merged && typeof mergeSha === 'string' && mergeSha.length > 0
    ? confirmAncestry({
      git,
      commit: mergeSha,
      ref,
      defaultBranch,
      shouldRetry: baseRef === defaultBranch,
      sleep,
    })
    : false;
  const { parents = [], pendingParent } = !isAncestor && mergeSha && typeof gh === 'function'
    ? findPendingParent({ gh, git, repository, defaultBranch, pull, mergeSha })
    : {};
  const verdict = evaluatePostMergeAncestry({ merged, mergeSha, isAncestor, pendingParent });

  const alarm = formatOrphanIssue({
    pull,
    mergeSha,
    defaultBranch,
    parents,
    reason: verdict.reason,
  });
  const issueClient = issues || (typeof gh === 'function' ? defaultIssues(gh, repository) : null);
  let existingIssue;
  if (issueClient) {
    const legacyTitle = `${LEGACY_ISSUE_TITLE_PREFIX} #${pull.number} never reached ${defaultBranch}`;
    const found = [...issueClient.search(alarm.title), ...issueClient.search(legacyTitle)];
    if (found.length > 0) {
      existingIssue = found[0].number;
      for (const issue of new Map(found.map((item) => [item.number, item])).values()) {
        if (isAncestor) {
          if (issue.state?.toLowerCase() !== 'closed') issueClient.close(issue.number, alarm.body);
        } else {
          const fields = { title: alarm.title, body: alarm.body };
          if (!verdict.ok) fields.state = 'open';
          if (issue.title !== fields.title || issue.body !== fields.body
            || fields.state && issue.state?.toLowerCase() !== fields.state) {
            issueClient.update(issue.number, fields);
          }
        }
      }
    } else if (!verdict.ok) {
      const created = issueClient.create(alarm);
      existingIssue = created?.number;
      if (pull.number != null) {
        issueClient.comment(pull.number, formatOrphanComment({
          pull, mergeSha, defaultBranch, parents, reason: verdict.reason,
        }));
      }
    }
  }

  return {
    ...verdict,
    parents,
    existingIssue,
    exitCode: verdict.ok ? 0 : 1,
    ...(!verdict.ok && { annotation: postMergeAnnotation(verdict, mergeSha, defaultBranch) }),
  };
}

export function checkClosedPull({ event, gh, git, issues, sleep } = {}) {
  if (!event?.pull_request) throw new Error('a pull_request payload is required');
  const repository = repositoryFromEvent(event);
  const queue = [event.pull_request];
  const visited = new Set();
  const results = [];
  for (const pull of queue) {
    if (visited.has(pull.number)) continue;
    visited.add(pull.number);
    const result = checkStackedMerge({
      mode: 'post-merge', event: { ...event, pull_request: pull }, gh, git, issues, sleep,
    });
    results.push({ pullNumber: pull.number, ...result });
    if (!pull.head?.ref || pull.head.repo?.full_name !== repository) continue;
    const children = flattenGhPages(gh([
      'api', '--paginate', '--slurp',
      `repos/${repository}/pulls?state=closed&base=${encodeURIComponent(pull.head.ref)}`,
    ]));
    queue.push(...children.filter((child) => isMergedPull(child)
      && (!child.base?.repo?.full_name || child.base.repo.full_name === repository)));
  }
  const failures = results.filter((result) => !result.ok);
  return {
    ok: failures.length === 0,
    reason: 'closed-pull-reconciled',
    exitCode: failures.length > 0 ? 1 : 0,
    results,
    ...(failures.length > 0 && { annotation: failures.map((result) => result.annotation).join('\n') }),
  };
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: GH_CALL_TIMEOUT_MS,
    input: options.input,
  });
  if (result.signal) {
    const error = new Error(`gh ${args.join(' ')} timed out`);
    error.timedOut = true;
    throw error;
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: GH_CALL_TIMEOUT_MS,
  });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`);
    error.status = result.status;
    throw error;
  }
  return result.stdout;
}

function loadEvent(env, eventPath) {
  const path = eventPath || env.GITHUB_EVENT_PATH;
  if (!path) {
    throw new Error('GITHUB_EVENT_PATH is required');
  }
  const payload = JSON.parse(readFileSync(path, 'utf8'));
  return { ...payload, eventName: env.GITHUB_EVENT_NAME };
}

function main(argv = process.argv, env = process.env) {
  const mode = readArg(argv, '--mode');
  const eventPath = readArg(argv, '--event-path');
  const event = loadEvent(env, eventPath);
  const check = mode === 'post-merge' ? checkClosedPull : checkStackedMerge;
  const result = check({
    mode,
    event,
    gh: runGh,
    git: runGit,
    sleep: sleepSync,
  });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`stacked-merge ${mode}: ok (${result.reason})`);
  } else {
    console.error(result.annotation || `stacked-merge ${mode}: fail (${result.reason})`);
  }
  process.exitCode = result.exitCode;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
