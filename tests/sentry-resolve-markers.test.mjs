import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { findSentryResolveReferences } from '../scripts/check-sentry-resolve-markers.mjs';

const script = fileURLToPath(new URL('../scripts/check-sentry-resolve-markers.mjs', import.meta.url));
const workflow = YAML.parse(readFileSync(
  new URL('../.github/workflows/sentry-resolve-markers.yml', import.meta.url),
  'utf8',
));
const prePush = readFileSync(new URL('../.husky/pre-push', import.meta.url), 'utf8');

// Real texts that pinned live issues in 2026-11. The commit body pinned the
// first issue at push; the PR body pinned the other two at merge.
const COMMIT_BODY_2026_11_21 = [
  'fix(sentry): mark the page as unloading before the bootstrap updaters reload',
  '',
  'PR #10257 drops fetch failures while the page unloads, but the flag was set',
  'only by beforeunload/pagehide. On WebKit the stale-bundle reload tore down requests',
  'before that flag was set: in two post-fix events of Sentry WORLDMONITOR-1AY a',
  '[stale-bundle] reload breadcrumb was followed within milliseconds by every',
].join('\n');
const PR_BODY_11053 = 'The browser proxy rejects those redirects too, so the three feeds stay blank. '
  + 'Fixes Sentry WORLDMONITOR-1FR and WORLDMONITOR-1FS (`newsRecallBenchmark` / `newsFeedHealth` EMPTY).';

// The pre-push grep the solution doc used to recommend.
const OLD_DOC_GREP = /(fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)[\s]+WORLDMONITOR-[A-Z0-9]+/gi;

const ids = (text) => findSentryResolveReferences(text).map((ref) => ref.shortId);

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

describe('findSentryResolveReferences', () => {
  it('flags the texts that pinned live issues, which the old documented grep missed', () => {
    assert.deepEqual(ids(COMMIT_BODY_2026_11_21), ['WORLDMONITOR-1AY']);
    assert.deepEqual(ids(PR_BODY_11053), ['WORLDMONITOR-1FR', 'WORLDMONITOR-1FS']);
    assert.equal(COMMIT_BODY_2026_11_21.match(OLD_DOC_GREP), null);
    assert.equal(PR_BODY_11053.match(OLD_DOC_GREP), null);
  });

  it('follows the run of words, commas and hyphens after a keyword across lines', () => {
    assert.deepEqual(ids('This closes the gap left by\nthe earlier WORLDMONITOR-9Z change'), ['WORLDMONITOR-9Z']);
    assert.deepEqual(ids('Resolves: WORLDMONITOR-1, WORLDMONITOR-2'), ['WORLDMONITOR-1', 'WORLDMONITOR-2']);
  });

  it('stops at punctuation outside the run and needs a word boundary before the keyword', () => {
    assert.deepEqual(ids('Linked to Sentry WORLDMONITOR-12A. This fixes the scorecard.'), []);
    assert.deepEqual(ids('fix(sentry): drop the WORLDMONITOR-12A noise'), []);
    assert.deepEqual(ids('a hotfix WORLDMONITOR-12A rollout'), []);
    assert.deepEqual(ids('Fixed. WORLDMONITOR-12A stays open'), []);
  });

  it('treats markdown links and inline code as transparent', () => {
    assert.deepEqual(ids('Fixes [WORLDMONITOR-7Q](https://elie-habib.sentry.io/issues/1/)'), ['WORLDMONITOR-7Q']);
    assert.deepEqual(ids('Fixes `WORLDMONITOR-7Q`'), ['WORLDMONITOR-7Q']);
  });

  it('flags the issue-URL form', () => {
    const refs = findSentryResolveReferences('Closes https://elie-habib.sentry.io/issues/7857755809/');
    assert.deepEqual(refs.map((ref) => ref.shortId), ['issue 7857755809']);
  });

  it('reports the line that fires the marker', () => {
    const [ref] = findSentryResolveReferences(COMMIT_BODY_2026_11_21);
    assert.match(ref.line, /post-fix events of Sentry WORLDMONITOR-1AY/);
  });
});

describe('check-sentry-resolve-markers CLI', () => {
  it('fails on a text file carrying a marker and passes a clean one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-sentry-markers-'));
    try {
      writeFileSync(join(dir, 'bad.md'), PR_BODY_11053);
      writeFileSync(join(dir, 'good.md'), 'Linked to Sentry WORLDMONITOR-1FR.\n');
      const bad = spawnSync(process.execPath, [script, '--text-file', join(dir, 'bad.md')], { encoding: 'utf8' });
      assert.equal(bad.status, 1, bad.stdout + bad.stderr);
      assert.match(bad.stderr, /WORLDMONITOR-1FR/);
      const good = spawnSync(process.execPath, [script, '--text-file', join(dir, 'good.md')], { encoding: 'utf8' });
      assert.equal(good.status, 0, good.stdout + good.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scans only the commits a push publishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-sentry-markers-git-'));
    const env = gitEnv();
    const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: dir, env, encoding: 'utf8',
    }).trim();
    try {
      git('init', '-q', '-b', 'main');
      git('commit', '-q', '--allow-empty', '-m', 'base\n\nThis fixes WORLDMONITOR-OLD from before');
      const base = git('rev-parse', 'HEAD');
      git('commit', '-q', '--allow-empty', '-m', 'clean change');
      const clean = git('rev-parse', 'HEAD');
      const push = (sha, remote) => spawnSync(process.execPath, [script, '--push-stdin'], {
        cwd: dir, env, encoding: 'utf8', input: `refs/heads/x ${sha} refs/heads/x ${remote}\n`,
      });
      assert.equal(push(clean, base).status, 0);

      git('commit', '-q', '--allow-empty', '-m', 'change\n\nin two post-fix events of Sentry WORLDMONITOR-NEW a');
      const marked = git('rev-parse', 'HEAD');
      const blocked = push(marked, base);
      assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, /WORLDMONITOR-NEW/);
      assert.doesNotMatch(blocked.stderr, /WORLDMONITOR-OLD/);

      const zero = '0'.repeat(40);
      const run = (input) => spawnSync(process.execPath, [script, '--push-stdin'], { cwd: dir, env, encoding: 'utf8', input });
      const deletion = run(`(delete) ${zero} refs/heads/x ${base}\n`);
      assert.equal(deletion.status, 0, `branch deletion: ${deletion.stderr}`);
      const tag = run(`refs/tags/v1 ${marked} refs/tags/v1 ${zero}\n`);
      assert.equal(tag.status, 0, `tag-only push: ${tag.stderr}`);
      const noNewCommits = run(`refs/heads/y ${base} refs/heads/y ${base}\n`);
      assert.equal(noNewCommits.status, 0, `push with no new commits: ${noNewCommits.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('wiring', () => {
  it('runs on pushes and on PR title and body edits', () => {
    assert.match(prePush, /check-sentry-resolve-markers\.mjs --push-stdin/);
    assert.deepEqual(workflow.on.pull_request.types, ['opened', 'edited', 'reopened', 'synchronize']);
    const steps = workflow.jobs.scan.steps;
    const scan = steps.find((step) => typeof step.run === 'string' && step.run.includes('check-sentry-resolve-markers.mjs'));
    assert.ok(scan, 'scan step');
    assert.doesNotMatch(scan.run, /\$\{\{/, 'PR text reaches the script through env, never interpolated into the shell');
    assert.match(scan.env.PR_BODY, /github\.event\.pull_request\.body/);
  });

  it('joins the PR body and title in the order Sentry scans them', () => {
    const scan = workflow.jobs.scan.steps.find((step) => typeof step.run === 'string' && step.run.includes('pr-text.md'));
    const dir = mkdtempSync(join(tmpdir(), 'wm-sentry-markers-pr-'));
    try {
      const result = spawnSync('bash', ['-c', scan.run], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: dir, PR_TITLE: 'WORLDMONITOR-1AY: handle stale bundles', PR_BODY: 'Verify events post-fix' },
      });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /WORLDMONITOR-1AY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
