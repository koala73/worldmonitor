#!/usr/bin/env node
// A push to main re-runs suites its pull requests already ran. This script
// reports which expensive job groups the `changes` job can skip:
//
//   code     only when the squash commit's tree is the tree a green
//            pull_request Test run on the PR head tested (main's previous tip
//            was already inside that head). Unit tests are what catch a
//            clash between two PRs that were green alone, so they keep
//            running on every other merge (the 2026-11-25 api/mcp.ts bundle
//            budget overflow came from two such PRs).
//   browser  whenever every commit since the last successful main run merged
//            a PR whose newest green run into main settled the browser group:
//            it ran and passed, or the PR did not touch browser paths. In
//            9.7 days of main runs (400, to 2026-11-27) the browser smokes
//            failed 14 times, every one a flake that passed on a later run,
//            and caught no clash; they cost half of each main run and queue
//            PR shards behind it on the account's job cap.
//
// It never turns a group on, and any doubt (an API error, a newer red run, a
// stale run, a dependency or workflow change, a commit with no PR) leaves
// every group to run.
import { appendFileSync } from 'node:fs';
import { isMainModule } from '../../scripts/lib/main-module.mjs';

// Shared caches are saved by main runs on a key miss, and these paths feed
// their keys (root and nested lockfiles, .npmrc, the vendored packages, the
// install actions, the sidecar's shipped-Node download script, the e2e
// embeddings model fetcher: every
// hashFiles() input in test.yml and its actions). Skipping such a push would
// leave the new entry unsaved and every later PR missing it. Workflow edits
// change what the jobs do.
export const REUSE_BLOCKER = /(^|\/)(package(-lock)?\.json|\.npmrc)$|^vendor\/|^\.github\/|^scripts\/download-node\.sh$|^e2e\/fetch-embeddings-model\.ts$/;
// The subset of REUSE_BLOCKER that changes what a Test run does: the cache
// key inputs, test.yml itself, and the local actions and scripts it runs.
// Other workflows (codeql.yml, convex-deploy.yml, ...) do not.
export const TEST_INPUT = /(^|\/)(package(-lock)?\.json|\.npmrc)$|^vendor\/|^\.github\/(workflows\/test\.yml$|actions\/|scripts\/)|^scripts\/download-node\.sh$|^e2e\/fetch-embeddings-model\.ts$/;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// More untested main commits than this and browser runs on main instead of
// looking each one up (three requests a commit).
export const MAX_COMMITS = 20;

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

// Only a run of a PR against main merged the head onto main. A stacked
// PR tested against its parent branch before being retargeted (1 of the
// last 100 merges), or another PR from the same branch, merged another
// tree. GitHub keeps no reliable record of a run's base: it empties the
// run's pull_requests list once the PR merges, and can leave closed PRs out
// of commits/{sha}/pulls. So test.yml writes the PR number and base into
// every pull_request run's name, and only runs named for this PR into main
// count. Runs from before that name existed are never reused.
// Resolves to { pr, run, jobs } for the PR that `sha` merged into main, or { reason }.
async function greenPullRequestRun({ api, repo, sha, now }) {
  const pulls = await api(`repos/${repo}/commits/${sha}/pulls`);
  const pr = pulls.find((p) => p.merge_commit_sha === sha && p.merged_at && p.base?.ref === 'main');
  if (!pr) return { reason: `${sha.slice(0, 10)} is not a pull request merge` };
  const head = pr.head.sha;
  const runName = `PR #${pr.number} into main: `;
  const { workflow_runs: runs = [] } = await api(`repos/${repo}/actions/workflows/test.yml/runs?head_sha=${head}&event=pull_request&per_page=100`);
  const ours = runs.filter((run) => run.display_title?.startsWith(runName) && run.head_branch === pr.head.ref && run.head_repository?.full_name === pr.head.repo?.full_name);
  const latest = ours.filter((run) => run.status === 'completed').sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!latest) return { reason: `no completed Test run on PR #${pr.number} head` };
  if (latest.conclusion !== 'success') return { reason: `latest Test run ${latest.id} on PR #${pr.number} head is ${latest.conclusion}` };
  if (!(now - Date.parse(latest.updated_at) <= MAX_AGE_MS)) return { reason: `Test run ${latest.id} is older than 24 h` };
  const { jobs = [], total_count: total } = await api(`repos/${repo}/actions/runs/${latest.id}/jobs?filter=latest&per_page=100`);
  if (total !== jobs.length) return { reason: `job list of run ${latest.id} is incomplete` };
  return { pr, run: latest, jobs };
}

// Every browser job row except the aggregate. A matrix job skipped by its
// `if:` is listed once under its unexpanded name, e.g.
// "variant-smoke (${{ matrix.shard }})" and "variant-smoke-pro-webmcp"
// (PR #11450 run 45944994296), so the GROUPS patterns miss those rows.
const BROWSER_LEG = /^variant-smoke(?:-pro-webmcp)?(?: \(.*\))?$/;

// The browser group is settled when its aggregate passed and the legs agree:
// all ran and passed, or all were skipped because the PR touched no browser
// path (the aggregate fails any other mix). Main applies the same path filter
// to the same files, so a skip there means main would not have run them either.
export function browserSettled(jobs) {
  const aggregate = jobs.filter((job) => job.name === 'variant-smoke-full');
  if (aggregate.length !== 1 || aggregate[0].conclusion !== 'success') return false;
  const legs = jobs.filter((job) => BROWSER_LEG.test(job.name));
  if (legs.length > 0 && legs.every((job) => job.conclusion === 'skipped')) return true;
  return groupPassed(jobs, GROUPS.browser);
}

// api(path) resolves to parsed JSON or throws. Returns { reuse: {code?, browser?}, reason }.
// decidedBase: the newest main commit whose Test run succeeded (the diff
// step's push_base). When it is not `before`, the commits between them were
// never tested on main (their runs were cancelled or red), and this PR's run
// never checked them either: its base already contained them. So `code` is
// never reused then, and `browser` needs every one of those commits settled.
export async function decideReuse({ api, repo, sha, before, files, decidedBase, now = Date.now() }) {
  const none = (reason) => ({ reuse: {}, reason });
  if (!before || /^0+$/.test(before)) return none('no parent SHA');
  if (decidedBase === '') return none('no successful main Test run to diff from');
  if (!Array.isArray(files) || files.length === 0) return none('no file list');
  const blocker = files.find((file) => REUSE_BLOCKER.test(file));
  if (blocker) return none(`${blocker} changed (cache key or workflow input)`);
  const base = decidedBase ?? before;

  const [code, browser] = await Promise.all([
    base === before ? decideCode({ api, repo, sha, before, now }) : { reason: `code: main since ${base.slice(0, 10)} has no successful Test run` },
    decideBrowser({ api, repo, sha, base, now }),
  ]);
  const reuse = {};
  if (code.ok) reuse.code = true;
  if (browser.ok) reuse.browser = true;
  return { reuse, reason: [code.reason, browser.reason].join('; ') };
}

async function decideCode({ api, repo, sha, before, now }) {
  const found = await greenPullRequestRun({ api, repo, sha, now });
  if (!found.pr) return { reason: `code: ${found.reason}` };
  const { pr, run, jobs } = found;
  // Main only moves forward, so the base of every earlier run on this head is
  // an ancestor of `before`; with `before` inside the head, each of those
  // merge refs had the head's own tree.
  const compare = await api(`repos/${repo}/compare/${before}...${pr.head.sha}`);
  if (!['ahead', 'identical'].includes(compare.status)) return { reason: `code: main moved under PR #${pr.number} (${compare.status})` };
  const [pushed, tested] = await Promise.all([api(`repos/${repo}/git/commits/${sha}`), api(`repos/${repo}/git/commits/${pr.head.sha}`)]);
  if (!pushed.tree?.sha || pushed.tree.sha !== tested.tree?.sha) return { reason: `code: tree differs from PR #${pr.number} head` };
  if (!groupPassed(jobs, GROUPS.code)) return { reason: `code: run ${run.id} did not pass it` };
  return { ok: true, reason: `code: PR #${pr.number} run ${run.id} passed it on tree ${pushed.tree.sha}` };
}

async function decideBrowser({ api, repo, sha, base, now }) {
  const compare = await api(`repos/${repo}/compare/${base}...${sha}`);
  const commits = (compare.commits ?? []).map((commit) => commit.sha);
  if (compare.status !== 'ahead' || commits.length === 0 || commits.length !== compare.total_commits || commits.at(-1) !== sha) {
    return { reason: `browser: could not list the commits since ${base.slice(0, 10)}` };
  }
  if (commits.length > MAX_COMMITS) return { reason: `browser: ${commits.length} commits since the last successful main run` };
  const found = await Promise.all(commits.map((commit) => greenPullRequestRun({ api, repo, sha: commit, now })));
  const settled = [];
  for (const entry of found) {
    if (!entry.pr) return { reason: `browser: ${entry.reason}` };
    if (!browserSettled(entry.jobs)) return { reason: `browser: run ${entry.run.id} of PR #${entry.pr.number} did not settle it` };
    settled.push(entry);
  }
  // The files list above covers main after `base`. A PR that branched before
  // `base` may have been tested under an older test.yml, lockfile or cache
  // input that main changed before `base` (its own full run then made it the
  // base). Refuse when main changed any such path since the PR's merge base.
  // GitHub caps a comparison's files at 300, so a capped list refuses too.
  const drift = await Promise.all(settled.map((entry) => api(`repos/${repo}/compare/${entry.pr.head.sha}...${base}`)));
  for (const [i, comparison] of drift.entries()) {
    // Both sides of a rename: moving .npmrc away changes the install as much as editing it.
    const changed = (comparison.files ?? []).flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
    const pr = settled[i].pr.number;
    if ((comparison.files ?? []).length >= 300) return { reason: `browser: main changed too many files since PR #${pr} branched to check its inputs` };
    const input = changed.find((file) => TEST_INPUT.test(file));
    if (input) return { reason: `browser: main changed ${input} after PR #${pr} branched, so its run used other inputs` };
  }
  return { ok: true, reason: `browser: settled by the pull request runs of ${settled.map((entry) => `#${entry.pr.number}`).join(', ')}` };
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

function githubApi(token) {
  return async (path) => {
    const response = await fetch(`https://api.github.com/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'worldmonitor-ci' },
      // A hung request would hold the `changes` job, and every job behind it.
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
}

// The step entry point. Writes only the overrides; an error anywhere leaves none.
export async function main({ env = process.env, api = githubApi(env.GH_TOKEN), now = Date.now() } = {}) {
  const { GITHUB_REPOSITORY, GITHUB_SHA, BEFORE, FILES_JSON, PUSH_BASE = '', GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = env;
  let decision;
  try {
    decision = await decideReuse({ api, repo: GITHUB_REPOSITORY, sha: GITHUB_SHA, before: BEFORE, files: JSON.parse(FILES_JSON || '[]'), decidedBase: PUSH_BASE, now });
  } catch (error) {
    decision = { reuse: {}, reason: `lookup failed, running every selected job: ${error.message}` };
  }
  const outputs = outputsFor(decision.reuse);
  console.log(`Reuse: ${decision.reason}`);
  if (GITHUB_OUTPUT) for (const [key, value] of Object.entries(outputs)) appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `### Pull request verdict reuse\n\n${decision.reason}\n`);
}

if (isMainModule(import.meta.url, process.argv[1])) await main();
