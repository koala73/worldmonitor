// Desktop release-freshness monitor (#5902 §4). It measures the oldest commit
// on main that touches a shipped path and is missing from the latest release,
// and keeps one issue open while that commit is older than the budget.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ISSUE_TITLE,
  MAX_UNRELEASED_DAYS,
  SHIPPED_PATHS,
  evaluateReleaseFreshness,
  parseCommits,
  publishReleaseFreshness,
  readReleaseBacklog,
} from '../scripts/check-desktop-release-freshness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-26T12:00:00Z');
const release = { tag: 'v2.11.8', publishedAt: '2026-11-04T19:23:59Z' };
const commit = (daysAgo, n = 1) => ({
  sha: String(n).padStart(40, 'a'),
  committedAt: new Date(NOW - daysAgo * DAY).toISOString(),
  ms: NOW - daysAgo * DAY,
});

describe('evaluateReleaseFreshness', () => {
  it('alerts once the oldest unreleased shipped commit passes the budget', () => {
    const verdict = evaluateReleaseFreshness({ release, commits: [commit(31, 1), commit(2, 2)] }, { now: NOW });
    assert.equal(verdict.alert, true);
    assert.equal(verdict.unreleasedCount, 2);
    assert.equal(verdict.oldest.sha, commit(31, 1).sha);
  });
  it('stays quiet at the budget and below it', () => {
    assert.equal(evaluateReleaseFreshness({ release, commits: [commit(MAX_UNRELEASED_DAYS)] }, { now: NOW }).alert, false);
    assert.equal(evaluateReleaseFreshness({ release, commits: [commit(22)] }, { now: NOW }).alert, false);
  });
  it('treats an empty backlog as fresh however old the release is', () => {
    const verdict = evaluateReleaseFreshness({ release, commits: [] }, { now: NOW });
    assert.equal(verdict.alert, false);
    assert.equal(verdict.oldest, null);
  });
  it('uses the oldest commit by date, not by list position', () => {
    const verdict = evaluateReleaseFreshness({ release, commits: [commit(5, 1), commit(40, 2)] }, { now: NOW });
    assert.equal(verdict.oldest.sha, commit(40, 2).sha);
    assert.equal(verdict.alert, true);
  });
  it('refuses to judge without a release', () => {
    assert.throws(() => evaluateReleaseFreshness({ release: null, commits: [] }), /published release/);
  });
});

describe('parseCommits', () => {
  it('parses git log lines', () => {
    const [c] = parseCommits(`${'b'.repeat(40)}\t2026-10-01T10:00:00+02:00\n`);
    assert.equal(c.ms, Date.parse('2026-10-01T08:00:00Z'));
  });
  it('rejects a malformed line instead of dropping it', () => {
    assert.throws(() => parseCommits('not-a-sha\tyesterday'), /Unparseable/);
  });
});

describe('publishReleaseFreshness', () => {
  const botIssue = { number: 7, title: ISSUE_TITLE, user: { login: 'github-actions[bot]' } };
  const breach = evaluateReleaseFreshness({ release, commits: [commit(45)] }, { now: NOW });
  const fresh = evaluateReleaseFreshness({ release, commits: [] }, { now: NOW });

  it('opens an issue on a breach', () => {
    const writes = [];
    const result = publishReleaseFreshness(breach, {
      repository: 'o/r', gh: () => [[]], ghPost: (args, body) => writes.push({ args, body }),
    });
    assert.equal(result.action, 'created');
    assert.deepEqual(writes[0].args.slice(0, 4), ['api', '--method', 'POST', 'repos/o/r/issues']);
    assert.equal(writes[0].body.title, ISSUE_TITLE);
    assert.match(writes[0].body.body, /v2\.11\.8/);
    assert.match(writes[0].body.body, /45 days ago \(budget 30\)/);
  });
  it('updates the open bot issue instead of opening another', () => {
    const writes = [];
    const result = publishReleaseFreshness(breach, {
      repository: 'o/r', gh: () => [[botIssue]], ghPost: (args) => writes.push(args),
    });
    assert.equal(result.action, 'updated');
    assert.deepEqual(writes[0].slice(0, 4), ['api', '--method', 'PATCH', 'repos/o/r/issues/7']);
  });
  it('ignores a same-titled issue a person opened', () => {
    const writes = [];
    publishReleaseFreshness(breach, {
      repository: 'o/r', gh: () => [[{ ...botIssue, user: { login: 'someone' } }]], ghPost: (args) => writes.push(args),
    });
    assert.equal(writes[0][2], 'POST');
  });
  it('comments, then closes, on recovery', () => {
    const writes = [];
    const result = publishReleaseFreshness(fresh, {
      repository: 'o/r', gh: () => [[botIssue]], ghPost: (args, body) => writes.push({ args, body }),
    });
    assert.equal(result.action, 'closed');
    assert.equal(writes.length, 2);
    assert.match(writes[0].args[1], /issues\/7\/comments$/);
    assert.match(writes[0].body.body, /within the 30-day freshness budget/);
    assert.deepEqual(writes[1].body, { state: 'closed', state_reason: 'completed' });
  });
  it('writes nothing when fresh and no issue is open', () => {
    const result = publishReleaseFreshness(fresh, {
      repository: 'o/r', gh: () => [[]], ghPost: () => { throw new Error('must not write'); },
    });
    assert.deepEqual(result, { alert: false });
  });
});

describe('readReleaseBacklog against a real git history', () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const repo = mkdtempSync(join(tmpdir(), 'wm-release-freshness-'));
  const env = (date) => ({ ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const commitFile = (file, date) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), date);
    git(repo, 'add', file);
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file], { cwd: repo, env: env(date) });
    if (r.status !== 0) throw new Error(r.stderr.toString());
  };
  git(repo, 'init', '-q');
  commitFile('src/a.ts', '2026-09-01T00:00:00Z');
  git(repo, 'tag', 'v1.0.0');
  commitFile('docs/notes.md', '2026-09-20T00:00:00Z');
  commitFile('server/handler.ts', '2026-10-05T00:00:00Z');
  commitFile('tests/x.test.mjs', '2026-10-06T00:00:00Z');
  commitFile('src-tauri/tauri.conf.json', '2026-11-20T00:00:00Z');
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };

  it('counts only shipped paths after the tag', () => {
    const backlog = readReleaseBacklog({
      repository: 'o/r',
      gh: () => ({ tag_name: 'v1.0.0', published_at: '2026-09-01T01:00:00Z' }),
      git: run,
    });
    assert.equal(backlog.commits.length, 2, 'docs and tests changes are not shipped');
    assert.equal(backlog.commits[0].committedAt.slice(0, 10), '2026-10-05');
    const verdict = evaluateReleaseFreshness(backlog, { now: NOW });
    assert.equal(verdict.alert, true, 'the server/ change is 52 days old');
  });
  it('fails when the release tag is not in HEAD history', () => {
    git(repo, 'checkout', '-q', '--orphan', 'other');
    git(repo, 'rm', '-rqf', '.');
    commitFile('src/b.ts', '2026-11-01T00:00:00Z');
    assert.throws(() => readReleaseBacklog({
      repository: 'o/r', gh: () => ({ tag_name: 'v1.0.0' }), git: run,
    }));
  });
});

describe('SHIPPED_PATHS covers what the binary bundles', () => {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const covered = (path) => SHIPPED_PATHS.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p));
  it('includes every bundle resource outside src-tauri', () => {
    for (const resource of conf.bundle.resources) {
      const repoPath = resource.startsWith('../') ? resource.slice(3) : `src-tauri/${resource}`;
      assert.ok(covered(repoPath) || covered(`${repoPath}/`), `bundle resource ${resource} is outside SHIPPED_PATHS`);
    }
  });
  it('includes the sidecar handler sources and the frontend build inputs', () => {
    for (const path of ['server/worldmonitor/economic/v1/handler.ts', 'src/main.ts', 'index.html', 'vite.config.ts', 'src-tauri/src/main.rs']) {
      assert.ok(covered(path), `${path} is outside SHIPPED_PATHS`);
    }
  });
});

describe('desktop-release-train.yml runs the monitor', () => {
  const workflow = readFileSync(join(root, '.github/workflows/desktop-release-train.yml'), 'utf8');
  it('has a freshness job with issue write access and full history', () => {
    const job = workflow.slice(workflow.indexOf('\n  freshness:'));
    assert.ok(job.length > 1 && workflow.includes('\n  freshness:'), 'no freshness job');
    assert.match(job, /issues: write/);
    assert.match(job, /fetch-depth: 0/);
    assert.match(job, /node scripts\/check-desktop-release-freshness\.mjs/);
  });
});
