#!/usr/bin/env node
// A push to main re-tests a tree its pull request already tested in 13 of 100
// recent merges: the squash commit's tree equals the PR head's, and main's
// previous tip was already inside that head, so the PR's merge ref was that
// same tree. This script finds such a push and reports which expensive job
// groups a green pull_request Test run on that head already passed, so the
// `changes` job can skip them. It never turns a group on, and any doubt
// (an API error, a newer red run, a stale run, a dependency or workflow
// change, a group the PR run skipped) leaves every group to run.
import { appendFileSync } from 'node:fs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

// Shared caches are saved by main runs on a key miss, and these paths feed
// their keys (root and nested lockfiles, .npmrc, the vendored package, the
// install actions). Skipping such a push would leave the new entry unsaved and
// every later PR missing it. Workflow edits change what the jobs do.
export const REUSE_BLOCKER = /(^|\/)(package(-lock)?\.json|\.npmrc)$|^vendor\/|^\.github\//;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// The jobs each `changes` output gates. A group is reusable only when every
// job in it ran and succeeded in the PR run; a skipped job means the PR run
// never tested that surface. The aggregators prove the matrix ran in full.
export const GROUPS = {
  code: [/^unit-shard \(\d+\)$/, /^unit-built-output$/, /^unit$/, /^sidecar$/, /^convex-tests$/, /^dom-tests$/],
  browser: [/^variant-smoke \(\d+\)$/, /^variant-smoke-pro-webmcp \(.+\)$/, /^variant-smoke-full$/],
};

function groupPassed(jobs, patterns) {
  return patterns.every((pattern) => {
    const matched = jobs.filter((job) => pattern.test(job.name));
    return matched.length > 0 && matched.every((job) => job.conclusion === 'success');
  });
}

// api(path) resolves to parsed JSON or throws. Returns { reuse: {code?, browser?}, reason, run? }.
export async function decideReuse({ api, repo, sha, before, files, now = Date.now() }) {
  const none = (reason) => ({ reuse: {}, reason });
  if (!before || /^0+$/.test(before)) return none('no parent SHA');
  if (!Array.isArray(files) || files.length === 0) return none('no file list');
  const blocker = files.find((file) => REUSE_BLOCKER.test(file));
  if (blocker) return none(`${blocker} changed (cache key or workflow input)`);

  const pulls = await api(`repos/${repo}/commits/${sha}/pulls`);
  const pr = pulls.find((p) => p.merge_commit_sha === sha && p.merged_at && p.base?.ref === 'main');
  if (!pr) return none('not a pull request merge');
  const head = pr.head.sha;

  // Main only moves forward, so the base of every earlier run on this head is
  // an ancestor of `before`; with `before` inside the head, each of those
  // merge refs had the head's own tree.
  const compare = await api(`repos/${repo}/compare/${before}...${head}`);
  if (!['ahead', 'identical'].includes(compare.status)) return none(`main moved under PR #${pr.number} (${compare.status})`);
  const [pushed, tested] = await Promise.all([api(`repos/${repo}/git/commits/${sha}`), api(`repos/${repo}/git/commits/${head}`)]);
  if (!pushed.tree?.sha || pushed.tree.sha !== tested.tree?.sha) return none(`tree differs from PR #${pr.number} head`);

  const { workflow_runs: runs = [] } = await api(`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${head}&event=pull_request&per_page=20`);
  const latest = runs.filter((run) => run.status === 'completed').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!latest) return none(`no completed Test run on PR #${pr.number} head`);
  if (latest.conclusion !== 'success') return none(`latest Test run ${latest.id} on PR #${pr.number} head is ${latest.conclusion}`);
  if (!(now - Date.parse(latest.updated_at) <= MAX_AGE_MS)) return none(`Test run ${latest.id} is older than 24 h`);

  const { jobs = [], total_count: total } = await api(`repos/${repo}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`);
  if (total !== jobs.length) return none(`job list of run ${latest.id} is incomplete`);
  const reuse = {};
  for (const [group, patterns] of Object.entries(GROUPS)) if (groupPassed(jobs, patterns)) reuse[group] = true;
  if (!Object.keys(reuse).length) return none(`run ${latest.id} did not pass any reusable group`);
  return { reuse, reason: `PR #${pr.number} run ${latest.id} passed ${Object.keys(reuse).join(', ')} on tree ${pushed.tree.sha}`, run: latest.id };
}

// The `changes` outputs to override. Reusing `code` also clears `validation`:
// resilience-validation-smoke exists for PRs that skip unit, and unit already
// ran its focused suite on this tree.
export function outputsFor(reuse) {
  const out = {};
  if (reuse.code) Object.assign(out, { code: 'false', validation: 'false' });
  if (reuse.browser) out.browser = 'false';
  return out;
}

async function main() {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, BEFORE, FILES_JSON, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
  const api = async (path) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'worldmonitor-ci' },
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  let decision;
  try {
    decision = await decideReuse({ api, repo: GITHUB_REPOSITORY, sha: GITHUB_SHA, before: BEFORE, files: JSON.parse(FILES_JSON || '[]') });
  } catch (error) {
    decision = { reuse: {}, reason: `lookup failed, running every selected job: ${error.message}` };
  }
  const outputs = outputsFor(decision.reuse);
  console.log(`Reuse: ${decision.reason}`);
  if (GITHUB_OUTPUT) for (const [key, value] of Object.entries(outputs)) appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `### Pull request verdict reuse\n\n${decision.reason}\n`);
}

if (isMainModule(import.meta.url, process.argv[1])) await main();
