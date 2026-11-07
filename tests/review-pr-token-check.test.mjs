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
      assert.doesNotMatch(text, /github\.token/, 'the Actions token opens PRs that get no CI');
      assert.match(text, /GH_TOKEN: \$\{\{ secrets\.REVIEW_PR_TOKEN \}\}/);
      assert.doesNotMatch(text, /gh pr merge[^\n]*BRANCH_NAME/, 'a branch name can also match a fork PR');
      assert.match(text, /gh pr merge --auto --squash "\$(pr_url|\(tail -n 1 "\$RUNNER_TEMP\/snapshot-pr\.out"\))"/, 'merge the PR this run created');
      assert.match(text, /select\([^)]*\.isCrossRepository \| not/, 'a fork PR on the same branch name is never this workflow\'s PR');
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
