#!/usr/bin/env node

// Detects a stacked PR whose base already merged (and usually auto-deleted),
// so a GitHub merge would land on a tombstone and never reach the default
// branch. #6993 and #6997 both showed MERGED while main never received the
// commits (#7006).
//
// Two modes:
//   pre-merge  — required PR check. Fails when base is not the default branch
//                and that base branch's own PR is already merged.
//   post-merge — safety net after a merge. Fails when the merge commit is not
//                an ancestor of the default branch, and files an issue plus a
//                PR comment because nobody re-reads checks on a purple PR.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';

export const ISSUE_TITLE_PREFIX = 'Orphaned stacked merge:';

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

export function evaluatePostMergeAncestry({ merged, mergeSha, isAncestor }) {
  if (!merged) {
    return { ok: true, reason: 'not-merged' };
  }
  if (typeof mergeSha !== 'string' || mergeSha.length === 0) {
    return { ok: false, reason: 'missing-merge-sha' };
  }
  if (isAncestor) {
    return { ok: true, reason: 'merge-on-default' };
  }
  return { ok: false, reason: 'orphaned-merge' };
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
  const title = typeof pull?.title === 'string' && pull.title.length > 0 ? ` — ${pull.title}` : '';
  return `${number}${title}${url}`;
}

function parentList(mergedParents) {
  if (!Array.isArray(mergedParents) || mergedParents.length === 0) {
    return 'none found for the stacked base branch';
  }
  return mergedParents.map((pull) => `- ${pullLabel(pull)}`).join('\n');
}

export function formatOrphanIssue({ pull, mergeSha, defaultBranch, mergedParents, reason }) {
  const number = pull?.number ?? '?';
  const title = `${ISSUE_TITLE_PREFIX} #${number} never reached ${defaultBranch}`;
  const body = [
    `Merged PR ${pullLabel(pull)} is not on \`${defaultBranch}\`.`,
    '',
    `- Merge SHA: \`${mergeSha || 'missing'}\``,
    `- PR base: \`${pull?.base?.ref || 'unknown'}\``,
    `- Reason: \`${reason}\``,
    '',
    'Parent PR(s) for that base branch:',
    parentList(mergedParents),
    '',
    `GitHub still reports this PR as MERGED when the base branch was deleted after its own PR merged, so the child lands on a tombstone. Re-land the commits onto \`${defaultBranch}\` (see #7006).`,
    '',
    'This issue is an alarm, not a close of #7006.',
  ].join('\n');
  return { title, body };
}

export function formatOrphanComment({ pull, mergeSha, defaultBranch, mergedParents, reason }) {
  const parents = Array.isArray(mergedParents) && mergedParents.length > 0
    ? mergedParents.map((parent) => `#${parent.number}`).join(', ')
    : 'none found';
  return [
    `This merge never reached \`${defaultBranch}\`. GitHub still shows MERGED, but \`${mergeSha || 'the merge commit'}\` is not an ancestor of \`${defaultBranch}\` (${reason}).`,
    '',
    `Stacked base: \`${pull?.base?.ref || 'unknown'}\`. Parent PR(s): ${parents}.`,
    '',
    'Re-land onto the default branch. Tracking: #7006.',
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
  return `::error::Merge commit \`${mergeSha}\` is not an ancestor of \`${defaultBranch}\`. The PR is MERGED but the commits never landed. See #7006.`;
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
        'number,title,url',
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
  const merged = pull.merged === true;
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
  const verdict = evaluatePostMergeAncestry({ merged, mergeSha, isAncestor });
  if (verdict.ok) {
    return { ...verdict, exitCode: 0 };
  }

  let mergedParents = [];
  if (typeof gh === 'function' && baseRef && baseRef !== defaultBranch) {
    mergedParents = listPullsByHead({ gh, repository, owner, headRef: baseRef }).filter(isMergedPull);
  }

  const alarm = formatOrphanIssue({
    pull,
    mergeSha,
    defaultBranch,
    mergedParents,
    reason: verdict.reason,
  });
  const comment = formatOrphanComment({
    pull,
    mergeSha,
    defaultBranch,
    mergedParents,
    reason: verdict.reason,
  });

  const issueClient = issues || (typeof gh === 'function' ? defaultIssues(gh, repository) : null);
  let existingIssue;
  if (issueClient) {
    const found = issueClient.search(alarm.title);
    if (Array.isArray(found) && found.length > 0) {
      existingIssue = found[0].number;
    } else {
      const created = issueClient.create(alarm);
      existingIssue = created?.number;
    }
    if (pull.number != null) {
      issueClient.comment(pull.number, comment);
    }
  }

  return {
    ...verdict,
    mergedPrs: mergedParents,
    existingIssue,
    exitCode: 1,
    annotation: postMergeAnnotation(verdict, mergeSha, defaultBranch),
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
  const result = checkStackedMerge({
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
