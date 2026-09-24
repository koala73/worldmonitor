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
  // A base whose only PRs were closed without merging leads nowhere either.
  const closedPrs = pulls.filter((pull) => pull?.state === 'closed');
  if (closedPrs.length > 0) {
    return { ok: false, reason: 'base-pr-closed', closedPrs };
  }
  return { ok: true, reason: 'base-pr-absent' };
}

// Mirrors what GitHub does when a merged PR's head branch is deleted: open
// children based on that branch move to the merged PR's own base. Without the
// deletion (delete_branch_on_merge=false) GitHub never retargets, and the
// children merge into the orphaned branch (#8518 → #8519/#8520).
function stackedBaseRef({ closedPull, repository, defaultBranch }) {
  const headRef = closedPull?.head?.ref;
  if (!headRef || headRef === defaultBranch) return null;
  // A fork head can never be an upstream base, and an unknown head repo is not
  // proof that it is this one.
  if (closedPull.head.repo?.full_name !== repository) return null;
  const target = closedPull.base?.ref;
  if (isMergedPull(closedPull) && (!target || target === headRef)) return null;
  return headRef;
}

export function planStackRetargets({ closedPull, openChildren, repository, defaultBranch }) {
  const headRef = stackedBaseRef({ closedPull, repository, defaultBranch });
  if (!headRef) return [];
  const merged = isMergedPull(closedPull);
  const target = closedPull.base.ref;
  const children = Array.isArray(openChildren) ? openChildren : [];
  return children
    .filter((child) => child?.state === 'open'
      && child.base?.ref === headRef
      && (!child.base.repo?.full_name || child.base.repo.full_name === repository))
    .map((child) => ({
      number: child.number,
      headSha: child.head?.sha,
      action: merged ? 'retarget' : 'strand',
      from: headRef,
      ...(merged && { to: target }),
    }));
}

export function evaluatePostMergeAncestry({ merged, mergeSha, isAncestor, integratedParent, pendingParent }) {
  if (!merged) {
    return { ok: true, reason: 'not-merged' };
  }
  if (typeof mergeSha !== 'string' || mergeSha.length === 0) {
    return { ok: false, reason: 'missing-merge-sha' };
  }
  if (isAncestor) {
    return { ok: true, reason: 'merge-on-default' };
  }
  if (integratedParent) {
    return { ok: true, reason: 'content-on-default', integratedParent };
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

export function formatOrphanIssue({ pull, mergeSha, defaultBranch, parents = [], reason, integratedParent }) {
  const number = pull?.number ?? '?';
  const title = `${ISSUE_TITLE_PREFIX} #${number} on ${defaultBranch}`;
  if (reason === 'merge-on-default') {
    return {
      title,
      body: `Integration of PR ${pullLabel(pull)} is confirmed. Merge commit \`${mergeSha}\` is an ancestor of \`${defaultBranch}\`.`,
    };
  }
  if (reason === 'content-on-default') {
    return {
      title,
      body: `Integration of PR ${pullLabel(pull)} content into \`${defaultBranch}\` is confirmed through parent ${pullLabel(integratedParent)}.\n\n`
        + `Child merge \`${mergeSha}\` is an ancestor of parent head \`${integratedParent.head.sha}\`. `
        + `All paths changed by the child match between that parent head and parent merge \`${integratedParent.merge_commit_sha}\`, `
        + `which is an ancestor of \`${defaultBranch}\`. This proves historical integration, not current behavior or deployment.`,
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

function preMergeAnnotation(verdict, baseRef, pullNumber, defaultBranch) {
  const merged = verdict.reason === 'base-pr-merged';
  const parentPulls = (merged ? verdict.mergedPrs : verdict.closedPrs) || [];
  const parents = parentPulls.map((pull) => `#${pull.number}`).join(', ');
  const target = merged ? parentPulls.find((pull) => pull.base?.ref)?.base.ref || defaultBranch : defaultBranch;
  const state = merged ? 'already merged in' : 'closed without merging in';
  return `::error::Stacked PR base \`${baseRef}\` ${state} ${parents}. Merging would land on an orphaned branch, not \`${defaultBranch}\`. `
    + `Retarget this PR: gh pr edit ${pullNumber} --base ${target}, then merge \`${target}\` into it. See #7006.`;
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

function parentPreservesChildPaths({ gh, git, repository, pull, mergeSha, parent }) {
  // A rebase merge SHA identifies only the last commit. Require the complete PR
  // file list, including rename sources, before comparing the landed content.
  const detail = JSON.parse(gh(['api', `repos/${repository}/pulls/${pull.number}`]));
  if (detail.merge_commit_sha !== mergeSha || !Number.isInteger(detail.changed_files)
    || detail.changed_files <= 0) return false;
  const files = flattenGhPages(gh([
    'api', '--paginate', '--slurp', `repos/${repository}/pulls/${pull.number}/files?per_page=100`,
  ]));
  if (files.length !== detail.changed_files) return false;
  const paths = new Set();
  for (const file of files) {
    if (typeof file.filename !== 'string' || !file.filename) return false;
    paths.add(file.filename);
    if (file.status === 'renamed' && !file.previous_filename) return false;
    if (file.previous_filename) paths.add(file.previous_filename);
  }
  // Also cover merge-resolution paths absent from the original PR diff.
  for (const path of git(['diff', '--name-only', '--no-renames', '-z', `${mergeSha}^1`, mergeSha, '--']).split('\0')) {
    if (path) paths.add(path);
  }
  try {
    git([
      '--literal-pathspecs', 'diff', '--quiet', '--no-ext-diff', '--no-textconv',
      parent.head.sha, parent.merge_commit_sha, '--', ...paths,
    ]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

function findParentIntegration({ gh, git, repository, defaultBranch, pull, mergeSha }) {
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
        if (parent.head?.sha && parent.merge_commit_sha) {
          git(['fetch', '--quiet', 'origin', parent.head.sha, parent.merge_commit_sha]);
          if (isCommitAncestor({ git, commit: mergeSha, ref: parent.head.sha })
            && isCommitAncestor({ git, commit: parent.merge_commit_sha, ref: `origin/${defaultBranch}` })
            && parentPreservesChildPaths({ gh, git, repository, pull, mergeSha, parent })) {
            return { parents, integratedParent: parent };
          }
        }
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
  runAttempt = 1,
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

  let baseRef = pull.base?.ref;
  const owner = pull.base?.repo?.owner?.login || repository.split('/')[0];

  if (mode === 'pre-merge') {
    let baseHeadPulls = [];
    // A rerun replays the original payload, so its base can be stale in either
    // direction: the retarget job moves a child off a merged parent, and a PR can
    // be moved from the default branch onto a parent after its first run.
    const staleBasePossible = runAttempt > 1 || (baseRef && baseRef !== defaultBranch);
    if (staleBasePossible && typeof gh !== 'function') {
      throw new Error('gh is required to look up the stacked base PR');
    }
    if (staleBasePossible && pull.number != null) {
      baseRef = JSON.parse(gh(['api', `repos/${repository}/pulls/${pull.number}`])).base?.ref;
    }
    if (baseRef && baseRef !== defaultBranch) {
      baseHeadPulls = listPullsByHead({ gh, repository, owner, headRef: baseRef });
    }
    const verdict = evaluatePreMergeGuard({ defaultBranch, baseRef, baseHeadPulls });
    if (verdict.ok) {
      return { ...verdict, exitCode: 0 };
    }
    return {
      ...verdict,
      exitCode: 1,
      annotation: preMergeAnnotation(verdict, baseRef, pull.number, defaultBranch),
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
  const { parents = [], pendingParent, integratedParent } = !isAncestor && mergeSha && typeof gh === 'function'
    ? findParentIntegration({ gh, git, repository, defaultBranch, pull, mergeSha })
    : {};
  const verdict = evaluatePostMergeAncestry({ merged, mergeSha, isAncestor, pendingParent, integratedParent });

  const alarm = formatOrphanIssue({
    pull,
    mergeSha,
    defaultBranch,
    parents,
    reason: verdict.reason,
    integratedParent,
  });
  const issueClient = issues || (typeof gh === 'function' ? defaultIssues(gh, repository) : null);
  let existingIssue;
  if (issueClient) {
    const legacyTitle = `${LEGACY_ISSUE_TITLE_PREFIX} #${pull.number} never reached ${defaultBranch}`;
    const found = [...issueClient.search(alarm.title), ...issueClient.search(legacyTitle)];
    if (found.length > 0) {
      existingIssue = found[0].number;
      for (const issue of new Map(found.map((item) => [item.number, item])).values()) {
        if (isAncestor || integratedParent) {
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

function retargetComment({ closedPull, item }) {
  if (item.action === 'retarget') {
    return [
      `Parent ${pullLabel(closedPull)} merged into \`${item.to}\`, but its branch \`${item.from}\` was not deleted, so GitHub did not retarget this PR.`,
      `This PR is now based on \`${item.to}\`, which is what GitHub does when the parent branch is deleted.`,
      '',
      `Merge \`${item.to}\` into this branch before merging: the parent's own commits may still show in the diff, and CI last ran against the old base. See #7006.`,
    ].join('\n');
  }
  return [
    `Parent ${pullLabel(closedPull)} was closed without merging. This PR is still based on its branch \`${item.from}\`, so merging it would not reach the default branch.`,
    '',
    `Retarget it (\`gh pr edit ${item.number} --base main\`) or close it. See #7006.`,
  ].join('\n');
}

function rerunLatestGuard({ gh, repository, headSha }) {
  const raw = gh([
    'api',
    `repos/${repository}/actions/workflows/stacked-merge-guard.yml/runs?head_sha=${headSha}&event=pull_request&per_page=1`,
  ]);
  const run = JSON.parse(raw)?.workflow_runs?.[0];
  if (!run?.id) throw new Error(`no stacked-merge-guard run found for ${headSha}`);
  gh(['api', '--method', 'POST', `repos/${repository}/actions/runs/${run.id}/rerun`]);
  return run.id;
}

export function retargetStackedChildren({ event, gh } = {}) {
  const closedPull = event?.pull_request;
  if (!closedPull) throw new Error('a pull_request payload is required');
  const repository = repositoryFromEvent(event);
  const defaultBranch = defaultBranchFromEvent(event);
  const headRef = stackedBaseRef({ closedPull, repository, defaultBranch });
  if (!headRef) {
    return { ok: true, reason: 'no-stacked-base', exitCode: 0, plan: [], failures: [], warnings: [] };
  }
  const openChildren = flattenGhPages(gh([
    'api', '--paginate', '--slurp',
    `repos/${repository}/pulls?state=open&base=${encodeURIComponent(headRef)}&per_page=100`,
  ]));
  const plan = planStackRetargets({ closedPull, openChildren, repository, defaultBranch });
  const failures = [];
  const warnings = [];
  for (const item of plan) {
    let applied = item.action === 'strand';
    if (item.action === 'retarget') {
      try {
        gh(
          ['api', '--method', 'PATCH', `repos/${repository}/pulls/${item.number}`, '--input', '-'],
          { input: JSON.stringify({ base: item.to }) },
        );
        applied = true;
      } catch (error) {
        failures.push(`#${item.number}: retarget to ${item.to} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (applied) {
      try {
        gh(
          ['api', `repos/${repository}/issues/${item.number}/comments`, '--input', '-'],
          { input: JSON.stringify({ body: retargetComment({ closedPull, item }) }) },
        );
      } catch (error) {
        warnings.push(`#${item.number}: comment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // A retarget by GITHUB_TOKEN fires no workflow, so the child keeps a guard
    // verdict computed against the old base. Re-run it: the guard reads the
    // live base, so a retargeted child passes and a stranded one fails.
    if (item.headSha) {
      try {
        rerunLatestGuard({ gh, repository, headSha: item.headSha });
      } catch (error) {
        const message = `#${item.number}: guard rerun failed: ${error instanceof Error ? error.message : String(error)}`;
        // A retargeted child is already based on the default branch. A stranded
        // child keeps the green verdict from while its parent was open, so a
        // missing rerun leaves nothing flagging it.
        (item.action === 'strand' ? failures : warnings).push(message);
      }
    }
  }
  return {
    ok: failures.length === 0,
    reason: 'stacked-children-reconciled',
    exitCode: failures.length > 0 ? 1 : 0,
    plan,
    failures,
    warnings,
    ...(failures.length > 0 && {
      annotation: failures.map((failure) => `::error::${failure}. Retarget it by hand. See #7006.`).join('\n'),
    }),
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
  const check = {
    'post-merge': checkClosedPull,
    retarget: retargetStackedChildren,
  }[mode] || checkStackedMerge;
  const result = check({
    mode,
    event,
    gh: runGh,
    git: runGit,
    sleep: sleepSync,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT) || 1,
  });
  for (const warning of result.warnings || []) console.log(`::warning::${warning}`);
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
