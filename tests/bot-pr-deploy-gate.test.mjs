// A PR a workflow opens with github.token fires no workflow_run event for its
// CI, so Deploy Gate's event path never evaluates it and the PR waited for the
// 30-minute sweep (#10090). The opener now dispatches the gate once the PR's
// CI finishes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, '.github/scripts/dispatch-bot-pr-gate.sh');
const SHA = 'a0fcb9a78c4c6881840cc685bb46460b99746659';
const BOT = { is_bot: true, login: 'app/github-actions' };

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_GH_DIR"
jq_expr=""
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[$i]}" = "--jq" ]; then jq_expr="\${args[$((i + 1))]}"; fi
done
case "$1 $2" in
  "pr list") jq -c "$jq_expr" "$dir/pr.json" ;;
  "workflow run") printf '%s\\n' "$*" >> "$dir/dispatch.log" ;;
  *)
    if [ "$1" = "api" ]; then
      printf '%s\\n' "$2" >> "$dir/api.log"
      if [[ "$2" =~ /actions/runs/([0-9]+)$ ]]; then
        id="\${BASH_REMATCH[1]}"
        pick=$(cat "$dir/listing-pick")
        record=$(jq -c --argjson id "$id" '.workflow_runs[] | select(.id == $id) | .status = (.fresh // .status)' "$dir/runs-$pick.json")
        if [ "$(jq -r '.status' <<<"$record")" = "error" ]; then exit 1; fi
        jq -cr "$jq_expr" <<<"$record"
        exit 0
      fi
      n=$(cat "$dir/api-count" 2>/dev/null || echo 0)
      total=$(ls "$dir"/runs-*.json | wc -l | tr -d ' ')
      pick=$(( n < total ? n : total - 1 ))
      echo "$pick" > "$dir/listing-pick"
      echo $((n + 1)) > "$dir/api-count"
      jq -c "$jq_expr" "$dir/runs-$pick.json"
    else
      echo "unexpected gh call: $*" >&2; exit 2
    fi ;;
esac
`;

function run({ prs, runs = [[]], env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-bot-pr-gate-'));
  try {
    const gh = join(dir, 'gh');
    writeFileSync(gh, FAKE_GH);
    chmodSync(gh, 0o755);
    writeFileSync(join(dir, 'pr.json'), JSON.stringify(prs));
    runs.forEach((statuses, i) => writeFileSync(
      join(dir, `runs-${i}.json`),
      JSON.stringify({ workflow_runs: statuses.map((value, id) => ({ id: id + 100, head_sha: SHA, event: 'pull_request', ...(typeof value === 'string' ? { status: value } : value) })) }),
    ));
    const result = spawnSync('bash', [script], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_GH_DIR: dir,
        REPO: 'koala73/worldmonitor',
        BRANCH: 'automation/seo-gsc-2026-W45',
        POLL_SECONDS: '0',
        MAX_WAIT_SECONDS: '0',
        ...env,
      },
    });
    const lines = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim().split('\n') : []);
    return { ...result, dispatches: lines('dispatch.log'), apiCalls: lines('api.log') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const botPr = [{ number: 10090, headRefOid: SHA, author: BOT }];
const dispatchFor = (sha) => `workflow run deploy-gate.yml --repo koala73/worldmonitor --ref main -f sha=${sha}`;

describe('dispatch-bot-pr-gate.sh', () => {
  it('dispatches Deploy Gate for the head once its CI completed', () => {
    const result = run({ prs: botPr, runs: [['completed', 'completed']] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /All 2 pull_request runs/);
    assert.doesNotMatch(result.stdout, /::warning::/);
    assert.deepEqual(result.dispatches, [dispatchFor(SHA)]);
  });

  it('waits until no pull_request run is still open', () => {
    const result = run({
      prs: botPr,
      runs: [[], ['queued', 'in_progress'], ['completed', 'in_progress'], ['completed', 'completed']],
      env: { MAX_WAIT_SECONDS: '100' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.apiCalls.filter((path) => path.includes('?')).length, 4);
    assert.deepEqual(result.dispatches, [dispatchFor(SHA)]);
  });

  it('waits when the listing says completed but the run record is still active', () => {
    const result = run({
      prs: botPr,
      runs: [[{ status: 'completed', fresh: 'in_progress' }], [{ status: 'completed', fresh: 'completed' }]],
      env: { MAX_WAIT_SECONDS: '100' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.apiCalls.filter((path) => path.includes('?')).length, 2);
    assert.deepEqual(result.dispatches, [dispatchFor(SHA)]);
  });

  it('does not treat an unreadable run record as completed', () => {
    const result = run({ prs: botPr, runs: [[{ status: 'completed', fresh: 'error' }]] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::PR #10090 still has 1 of 1 pull_request runs open/);
    assert.deepEqual(result.dispatches, [dispatchFor(SHA)]);
  });

  it('does not accept completed runs belonging to a different head', () => {
    const result = run({ prs: botPr, runs: [[{ status: 'completed', head_sha: 'b'.repeat(40) }]] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::/);
    assert.doesNotMatch(result.stdout, /All 1 pull_request runs/);
  });

  it('dispatches anyway when CI outlasts the wait, so the gate posts pending for the sweep', () => {
    const result = run({ prs: botPr, runs: [['in_progress']], env: { POLL_SECONDS: '1', MAX_WAIT_SECONDS: '2' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.apiCalls.filter((path) => path.includes('?')).length, 3);
    assert.match(result.stdout, /::warning::PR #10090 still has 1 of 1 pull_request runs open after 2s/);
    assert.deepEqual(result.dispatches, [dispatchFor(SHA)]);
  });

  it('leaves a PR opened with a user or app token to the event path', () => {
    const result = run({ prs: [{ number: 1, headRefOid: SHA, author: { is_bot: false, login: 'koala73' } }] });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.apiCalls, []);
    assert.deepEqual(result.dispatches, []);
  });

  it('does nothing when the run opened no PR', () => {
    const result = run({ prs: [] });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No open PR for automation\/seo-gsc-2026-W45/);
    assert.deepEqual(result.dispatches, []);
  });

  it('refuses a malformed head SHA instead of dispatching it', () => {
    const result = run({ prs: [{ number: 2, headRefOid: 'main', author: BOT }] });
    assert.equal(result.status, 1);
    assert.deepEqual(result.dispatches, []);
  });
});

describe('review-PR workflows dispatch Deploy Gate', () => {
  const openers = {
    'crawlable-pulse-refresh.yml': 'refresh',
    'seo-gsc-weekly.yml': 'collect',
    'resilience-snapshot-refresh.yml': 'refresh',
    'github-stars-refresh.yml': 'refresh',
  };
  const workflowsDir = resolve(root, '.github/workflows');

  it('covers every workflow that opens a PR', () => {
    const opening = readdirSync(workflowsDir)
      .filter((name) => /\.ya?ml$/.test(name) && readFileSync(resolve(workflowsDir, name), 'utf8').includes('gh pr create'))
      .sort();
    assert.deepEqual(opening, Object.keys(openers).sort());
  });

  for (const [file, job] of Object.entries(openers)) {
    it(`${file} hands its PR branch to the gate dispatch`, () => {
      const { jobs } = YAML.parse(readFileSync(resolve(workflowsDir, file), 'utf8'));
      assert.equal(jobs[job].outputs?.branch, '${{ steps.reconcile.outputs.branch }}');
      assert.ok(jobs[job].steps.some((step) => step.id === 'reconcile'), `${file}#${job} must keep its reconcile step`);
      const gate = jobs['deploy-gate'];
      assert.equal(gate.uses, './.github/workflows/bot-pr-deploy-gate.yml');
      assert.equal(gate.needs, job);
      assert.equal(gate.with.branch, `\${{ needs.${job}.outputs.branch }}`);
      assert.equal(gate.permissions.actions, 'write', 'dispatching Deploy Gate needs actions: write');
    });
  }

  it('the reusable workflow runs the dispatch script with the caller\'s branch', () => {
    const workflow = YAML.parse(readFileSync(resolve(workflowsDir, 'bot-pr-deploy-gate.yml'), 'utf8'));
    assert.equal(workflow.on.workflow_call.inputs.branch.required, true);
    const job = workflow.jobs.dispatch;
    assert.equal(job.permissions.actions, 'write');
    const step = job.steps.find((s) => s.run);
    assert.equal(step.run, 'bash .github/scripts/dispatch-bot-pr-gate.sh');
    assert.equal(step.env.BRANCH, '${{ inputs.branch }}');
  });
});
