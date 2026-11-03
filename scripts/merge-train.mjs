#!/usr/bin/env node
/**
 * Merge a queue of PRs without ever merging one whose base drifted under it.
 *
 * `main` is `required_status_checks.strict = false`, so GitHub computes
 * refs/pull/N/merge once per push and never recomputes it when the base moves.
 * A PR can therefore sit green on checks that never saw the commits it lands
 * on, and two such PRs touching the same file from different bases merge with
 * no conflict and red `main` — the #8269/#8376 collision.
 *
 * The Deploy Gate carries a stale-base predicate, but its verdict is only as
 * fresh as its last evaluation, and the sweep never revisits a SUCCESS whose
 * contract stamp is current. In a merge run that is exactly the wrong window:
 * every merge invalidates every other PR's verdict, and nothing re-reads it.
 *
 * So this re-establishes the verdict immediately before each merge.
 * `deploy-gate.yml` accepts a `workflow_dispatch` `sha` input, and that path
 * evaluates the exact head unconditionally — no sweep bounds, no 24-hour
 * expiry, no inherited green. A PR is merged only on a gate that ran after the
 * previous merge landed.
 *
 * Reports what it would do and changes nothing unless `--execute` is passed.
 *
 *   node scripts/merge-train.mjs 8401 8408 8414
 *   node scripts/merge-train.mjs --file prs.txt --execute
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { isMainModule } from './lib/main-module.mjs';

const execFileAsync = promisify(execFile);

const REPO = process.env.MERGE_TRAIN_REPO ?? 'koala73/worldmonitor';
const GATE_WORKFLOW = 'deploy-gate.yml';
/** A gate evaluation reads checks twice with a 60s pause, so allow for both. */
export const GATE_TIMEOUT_MS = 12 * 60 * 1000;
export const GATE_POLL_MS = 15 * 1000;
/** Each PR gets this many branch updates before the train gives up on it. */
export const MAX_UPDATES_PER_PR = 2;

/**
 * Read a Deploy Gate commit status into a decision.
 *
 * The description is the gate's own contract: `deploy-gate.sh` publishes the
 * stale-base verdict with a `Stale base` prefix, and nothing else uses it.
 */
export function classifyGate(status) {
  if (!status || !status.state) return 'pending';
  if (status.state === 'success') return 'green';
  if (status.state === 'pending') return 'pending';
  if (String(status.description ?? '').startsWith('Stale base')) return 'stale-base';
  return 'failed';
}

/** Reasons a PR is not a merge candidate at all, independent of its checks. */
export function skipReason(pr) {
  if (!pr) return 'not found';
  if (pr.state !== 'OPEN') return `state is ${pr.state}`;
  if (pr.isDraft) return 'draft';
  if (pr.mergeStateStatus === 'DIRTY') return 'conflicts with main';
  return null;
}

/**
 * Run the train over `queue`.
 *
 * `github` is injected so the decision loop is testable without the network;
 * `createGitHubClient()` is the real one. A PR that reports a stale base is
 * updated and sent to the BACK of the queue, which also gives its re-triggered
 * checks the time they need before it is looked at again.
 */
export async function runMergeTrain({
  queue,
  github,
  log = console.log,
  execute = false,
  maxUpdates = MAX_UPDATES_PER_PR,
}) {
  const pending = [...queue];
  const updates = new Map();
  const outcomes = [];
  const record = (number, outcome, detail) => {
    outcomes.push({ number, outcome, detail });
    log(`#${number}: ${outcome}${detail ? ` — ${detail}` : ''}`);
  };

  while (pending.length > 0) {
    const number = pending.shift();
    const pr = await github.getPullRequest(number);
    const skip = skipReason(pr);
    if (skip) {
      record(number, 'skipped', skip);
      continue;
    }

    log(`#${number}: re-evaluating the gate for ${pr.headRefOid.slice(0, 9)}…`);
    const status = await github.evaluateGate(pr.headRefOid);
    const verdict = classifyGate(status);

    if (verdict === 'stale-base' || verdict === 'pending') {
      const spent = updates.get(number) ?? 0;
      // A pending gate after a full dispatch means the checks themselves are
      // still moving; re-queueing costs nothing and the next pass re-reads it.
      if (verdict === 'pending') {
        if (spent >= maxUpdates) {
          record(number, 'blocked', 'gate never reached a verdict');
          continue;
        }
        updates.set(number, spent + 1);
        pending.push(number);
        record(number, 'requeued', 'gate still pending');
        continue;
      }
      if (spent >= maxUpdates) {
        record(number, 'blocked', `still stale after ${spent} branch update(s)`);
        continue;
      }
      if (!execute) {
        record(number, 'would update', status.description);
        continue;
      }
      updates.set(number, spent + 1);
      await github.updateBranch(number);
      pending.push(number);
      record(number, 'updated', 'branch refreshed onto main; requeued');
      continue;
    }

    if (verdict === 'failed') {
      record(number, 'failed', status.description);
      continue;
    }

    // Re-read the PR: the gate is green, but a merge also needs GitHub to
    // consider the branch mergeable right now.
    const fresh = await github.getPullRequest(number);
    if (fresh.headRefOid !== pr.headRefOid) {
      pending.push(number);
      record(number, 'requeued', 'head moved while the gate was evaluating');
      continue;
    }
    if (fresh.mergeStateStatus === 'DIRTY') {
      record(number, 'skipped', 'conflicts with main');
      continue;
    }
    if (!execute) {
      record(number, 'would merge', 'gate green on the current main');
      continue;
    }
    await github.merge(number);
    record(number, 'merged', 'gate green on the current main');
  }

  return outcomes;
}

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The real client.
 *
 * `evaluateGate` dispatches Deploy Gate for one exact SHA and waits for THAT
 * run, identified by its run-name (`Deploy Gate <sha>`), rather than polling
 * the commit status directly: when a re-evaluation reaches the same verdict the
 * gate writes nothing, so a status poll cannot tell "confirmed" from "not yet
 * started".
 */
export function createGitHubClient({ repo = REPO, log = console.log } = {}) {
  return {
    async getPullRequest(number) {
      try {
        const stdout = await gh([
          'pr', 'view', String(number), '--repo', repo,
          '--json', 'number,state,isDraft,headRefOid,mergeStateStatus,title',
        ]);
        return JSON.parse(stdout);
      } catch {
        return null;
      }
    },

    async evaluateGate(sha) {
      const dispatchedAt = Date.now();
      await gh(['workflow', 'run', GATE_WORKFLOW, '--repo', repo, '-f', `sha=${sha}`]);
      const deadline = dispatchedAt + GATE_TIMEOUT_MS;
      let seen = null;
      while (Date.now() < deadline) {
        await sleep(GATE_POLL_MS);
        const runs = JSON.parse(await gh([
          'run', 'list', '--repo', repo, '--workflow', GATE_WORKFLOW,
          '--event', 'workflow_dispatch', '--limit', '30',
          '--json', 'databaseId,createdAt,status,displayTitle',
        ]));
        const mine = runs.find((run) => run.displayTitle === `Deploy Gate ${sha}`
          // Tolerate a clock skew of a minute between this host and GitHub.
          && Date.parse(run.createdAt) >= dispatchedAt - 60_000);
        if (!mine) continue;
        seen = mine;
        if (mine.status !== 'completed') continue;
        const statuses = JSON.parse(await gh([
          'api', `repos/${repo}/commits/${sha}/status`, '--jq', '[.statuses[]]',
        ]));
        return statuses.filter((entry) => entry.context === 'gate').pop() ?? null;
      }
      log(`  gate dispatch for ${sha.slice(0, 9)} timed out (${seen ? seen.status : 'no run seen'})`);
      return null;
    },

    async updateBranch(number) {
      await gh(['api', '--method', 'PUT', `repos/${repo}/pulls/${number}/update-branch`]);
    },

    async merge(number) {
      await gh(['pr', 'merge', String(number), '--repo', repo, '--squash']);
    },
  };
}

export function parseArgs(argv) {
  const numbers = [];
  let execute = false;
  let file = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') { execute = true; continue; }
    if (arg === '--file') { file = argv[index + 1]; index += 1; continue; }
    if (/^\d+$/.test(arg)) { numbers.push(Number(arg)); continue; }
    throw new Error(`Unrecognised argument: ${arg}`);
  }
  if (file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = line.trim().match(/^#?(\d+)$/);
      if (match) numbers.push(Number(match[1]));
    }
  }
  if (numbers.length === 0) throw new Error('No PR numbers given');
  return { queue: [...new Set(numbers)], execute };
}

const USAGE = `usage: node scripts/merge-train.mjs <pr>... [--file <path>] [--execute]

Re-evaluates the Deploy Gate for each PR's exact head immediately before
merging it, so no PR merges on a verdict that predates the previous merge.
Without --execute it only reports what it would do.`;

if (isMainModule(import.meta.url, process.argv[1])) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`merge-train: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { queue, execute } = parsed;
  console.log(
    `merge-train: ${queue.length} PR(s), ${execute ? 'EXECUTING' : 'dry run (pass --execute to merge)'}`,
  );
  const outcomes = await runMergeTrain({ queue, github: createGitHubClient(), execute });
  const tally = outcomes.reduce((counts, { outcome }) => {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    return counts;
  }, {});
  console.log(`\n${Object.entries(tally).map(([key, value]) => `${key}: ${value}`).join(', ')}`);
  // A blocked or failed PR is a report, not a crash: the rest of the train ran.
  process.exitCode = 0;
}
