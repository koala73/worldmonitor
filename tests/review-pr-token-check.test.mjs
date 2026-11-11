import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

import { EXPIRY_ALARM_DAYS, assessReviewToken } from '../scripts/check-review-pr-token.mjs';

const now = Date.parse('2026-11-07T12:00:00Z');
const day = 86_400_000;
const header = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

describe('REVIEW_PR_TOKEN check', () => {
  it('fails when the secret is missing, rejected, or cannot read the repository', () => {
    assert.equal(assessReviewToken({ token: '', status: 0, now }).ok, false);
    assert.match(assessReviewToken({ token: 't', status: 401, now }).message, /expired or been revoked/);
    assert.match(assessReviewToken({ token: 't', status: 404, now }).message, /HTTP 404/);
  });

  it('alarms inside the rotation window and passes outside it', () => {
    const soon = assessReviewToken({ token: 't', status: 200, expiration: header(now + (EXPIRY_ALARM_DAYS - 1) * day), now });
    assert.equal(soon.ok, false);
    assert.match(soon.message, /expires on 2026-11-27/);
    const later = assessReviewToken({ token: 't', status: 200, expiration: header(now + (EXPIRY_ALARM_DAYS + 1) * day), now });
    assert.equal(later.ok, true);
    assert.equal(assessReviewToken({ token: 't', status: 200, expiration: '2027-11-07 11:13:00 -0800', now }).ok, true);
  });

  it('passes a token with no expiry and fails an unreadable expiry header', () => {
    assert.equal(assessReviewToken({ token: 't', status: 200, expiration: null, now }).ok, true);
    assert.equal(assessReviewToken({ token: 't', status: 200, expiration: 'soon', now }).ok, false);
  });
});

describe('bot-PR workflows', () => {
  const read = (file) => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');
  const openers = ['crawlable-pulse-refresh.yml', 'github-stars-refresh.yml', 'resilience-snapshot-refresh.yml', 'seo-gsc-weekly.yml'];

  for (const file of openers) {
    it(`${file} opens and auto-merges its PR with REVIEW_PR_TOKEN only`, () => {
      const text = read(file);
      // The Actions token opens PRs that get no CI. It may appear only in a
      // step that runs a shell command with no PR-capable call: an issue from
      // github-actions[bot] notifies the owner, one from the owner's PAT does not.
      const ACTIONS_TOKEN = /github\.token|secrets\.GITHUB_TOKEN/;
      // Reading PRs (`gh pr list`, `view`, ...) cannot open one; every other
      // `gh pr` subcommand, `gh api` and the REST or GraphQL PR calls can.
      const PR_WRITE = /\bgh pr (?!(list|view|status|checks|diff)\b)\S+/;
      const PR_CAPABLE = new RegExp(`${PR_WRITE.source}|\\bgh api\\b|pulls|createPullRequest`);
      const workflow = YAML.parse(text);
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        const { steps = [], ...jobWithoutSteps } = job;
        assert.doesNotMatch(JSON.stringify(jobWithoutSteps), ACTIONS_TOKEN, `job ${jobName} hands the Actions token to every step`);
        for (const step of steps) {
          if (!ACTIONS_TOKEN.test(JSON.stringify(step))) continue;
          const label = step.name ?? step.id ?? step.uses;
          assert.equal(step.uses, undefined, `${label} passes the Actions token to an action`);
          assert.doesNotMatch(step.run ?? '', PR_CAPABLE, `${label} can open a PR with the Actions token`);
        }
        for (const step of steps.filter((entry) => PR_WRITE.test(entry.run ?? ''))) {
          assert.equal(step.env?.GH_TOKEN ?? job.env?.GH_TOKEN ?? workflow.env?.GH_TOKEN, '${{ secrets.REVIEW_PR_TOKEN }}', `${step.name ?? step.id} runs gh pr without REVIEW_PR_TOKEN`);
        }
      }
      const { jobs: _jobs, ...workflowWithoutJobs } = workflow;
      assert.doesNotMatch(JSON.stringify(workflowWithoutJobs), ACTIONS_TOKEN, 'a workflow-wide Actions token reaches every step');
      assert.match(text, /GH_TOKEN: \$\{\{ secrets\.REVIEW_PR_TOKEN \}\}/);
      assert.doesNotMatch(text, /gh pr merge[^\n]*BRANCH_NAME/, 'a branch name can also match a fork PR');
      assert.match(text, /gh pr merge --auto --squash "\$(pr_url|\(tail -n 1 "\$RUNNER_TEMP\/snapshot-pr\.out"\))"/, 'merge the PR this run created');
      assert.match(
        text,
        /select\([^)]*\.isCrossRepository \| not|pulls\?[^"\n]*head=\$\{GITHUB_REPOSITORY_OWNER\}:/,
        'a fork PR on the same branch name is never this workflow\'s PR',
      );
      if (file === 'seo-gsc-weekly.yml') {
        // A fork PR filtered out of a fixed-size page can still push this
        // week's PR off that page, so this file asks GitHub for owner heads only.
        assert.doesNotMatch(text, /gh pr list[^\n]*--head/, 'a bare --head lookup also returns fork PRs');
      }
      assert.match(
        text,
        /--jq '\.state == "OPEN" and \(\.isDraft \| not\) and \(\.isCrossRepository \| not\)'\)" = "true" \]; then\n\s+gh pr merge --auto --squash "\$existing_pr"/,
        'a rerun re-arms auto-merge only on an open, non-draft PR from this repository',
      );
    });
  }

  it('opens a recovered crawlable pulse branch as an unarmed draft', () => {
    const { jobs } = YAML.parse(read('crawlable-pulse-refresh.yml'));
    const reconcile = jobs.refresh.steps.find((step) => step.id === 'reconcile').run;
    const recovery = reconcile.slice(reconcile.indexOf('git ls-remote'));
    assert.match(recovery, /--draft/);
    assert.doesNotMatch(recovery, /gh pr merge/, 'its verification outcome is unknown');
  });

  it('checks the token weekly and on demand', () => {
    const workflow = YAML.parse(read('review-pr-token-check.yml'));
    assert.ok(workflow.on.schedule?.length === 1 && 'workflow_dispatch' in workflow.on);
    const steps = workflow.jobs.check.steps;
    const run = steps.find((step) => step.run?.includes('scripts/check-review-pr-token.mjs'));
    assert.equal(run.env.REVIEW_PR_TOKEN, '${{ secrets.REVIEW_PR_TOKEN }}');
  });
});
