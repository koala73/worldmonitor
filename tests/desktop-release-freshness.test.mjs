// Desktop release-freshness monitor (#5902 §4). It measures the oldest commit
// on main that touches a shipped path and is missing from the latest release,
// and keeps one issue open while that commit is older than the budget.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
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
  // An inherited GIT_DIR or GIT_WORK_TREE (set inside hooks, for example)
  // would point these commands at the caller's repository instead of the
  // fixture, so every spawn gets an environment without them.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const repo = mkdtempSync(join(tmpdir(), 'wm-release-freshness-'));
  const run = (args, date) => {
    const env = date ? { ...baseEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : baseEnv;
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
  };
  const commitFile = (file, date) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), date);
    run(['add', file]);
    run(['commit', '-qm', file], date);
  };
  run(['init', '-q', '-b', 'main']);
  commitFile('src/a.ts', '2026-09-01T00:00:00Z');
  run(['tag', 'v1.0.0']);
  commitFile('docs/notes.md', '2026-09-20T00:00:00Z');
  commitFile('settings.html', '2026-10-05T00:00:00Z');
  commitFile('tests/x.test.mjs', '2026-10-06T00:00:00Z');
  // A branch commit made long ago that only reaches main with a late merge.
  run(['checkout', '-q', '-b', 'feature']);
  commitFile('server/handler.ts', '2026-09-10T00:00:00Z');
  run(['checkout', '-q', 'main']);
  commitFile('docs/more.md', '2026-11-01T00:00:00Z');
  run(['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature'], '2026-11-20T00:00:00Z');
  const backlog = () => readReleaseBacklog({
    repository: 'o/r',
    gh: () => ({ tag_name: 'v1.0.0', published_at: '2026-09-01T01:00:00Z' }),
    git: (args) => run(args),
  });

  it('counts only shipped paths after the tag', () => {
    const { commits } = backlog();
    assert.deepEqual(commits.map((c) => c.committedAt.slice(0, 10)), ['2026-10-05', '2026-11-20'],
      'the root HTML page and the merge count; docs and tests do not');
    assert.equal(evaluateReleaseFreshness(backlog(), { now: NOW }).alert, true, 'the settings.html change is 52 days old');
  });
  it('dates a merged branch by when it reached main', () => {
    const { commits } = backlog();
    assert.ok(!commits.some((c) => c.committedAt.startsWith('2026-09-10')),
      'the branch commit dated 2026-09-10 must not start the clock');
  });
  it('fails when the release tag is not in HEAD history', () => {
    run(['checkout', '-q', '--orphan', 'other']);
    run(['rm', '-rqf', '.']);
    commitFile('src/b.ts', '2026-11-01T00:00:00Z');
    assert.throws(() => readReleaseBacklog({
      repository: 'o/r', gh: () => ({ tag_name: 'v1.0.0' }), git: (args) => run(args),
    }));
  });
});

describe('SHIPPED_PATHS covers what the binary bundles', () => {
  const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  // Mirrors git pathspec semantics for the entry shapes the list uses: a
  // trailing slash is a directory, `:(glob)` uses `*` that stops at `/`.
  const matchers = SHIPPED_PATHS.map((p) => {
    if (p.startsWith(':(glob)')) {
      const re = p.slice(7).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
      return (path) => new RegExp(`^${re}$`).test(path);
    }
    return p.endsWith('/') ? (path) => path.startsWith(p) : (path) => path === p;
  });
  const covered = (path) => matchers.some((m) => m(path));

  it('includes every bundle resource', () => {
    for (const resource of conf.bundle.resources) {
      const repoPath = resource.startsWith('../') ? resource.slice(3) : `src-tauri/${resource}`;
      assert.ok(covered(repoPath) || covered(`${repoPath}/`), `bundle resource ${resource} is outside SHIPPED_PATHS`);
    }
  });
  it('includes every HTML entry page the Vite build ships', () => {
    const vite = readFileSync(join(root, 'vite.config.ts'), 'utf8');
    const pages = [...vite.matchAll(/resolve\(__dirname, '([\w-]+\.html)'\)/g)].map((m) => m[1]);
    assert.ok(pages.includes('settings.html') && pages.length >= 5, `parsed too few entry pages: ${pages}`);
    for (const page of pages) assert.ok(covered(page), `${page} is outside SHIPPED_PATHS`);
    assert.ok(!covered('docs/page.html'), 'the root-page glob must not reach into subdirectories');
  });
  it('includes every scripts/ and convex/ module that shipped code imports', () => {
    const r = spawnSync('git', ['grep', '-h', '-o', '-E', String.raw`from ['"](\.\./)+(scripts|convex)/[^'"]+['"]`, '--', 'src', 'server', 'api', 'shared'], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const targets = new Set(r.stdout.split('\n').filter(Boolean)
      .map((line) => line.replace(/^from ['"](\.\.\/)+/, '').replace(/['"]$/, '')));
    assert.ok(targets.size > 10, `parsed too few imports: ${[...targets]}`);
    for (const target of targets) {
      const candidates = [target, `${target}.ts`, `${target}.mjs`, `${target}.js`, `${target}/`];
      assert.ok(candidates.some(covered), `${target} is imported by shipped code but outside SHIPPED_PATHS`);
    }
  });
  it('includes every script the Tauri build command runs, except pure checks', () => {
    // Gates that only fail the build and write nothing that ships.
    const CHECK_ONLY = new Set(['scripts/check-vite-env-secrets.mjs']);
    // Generators whose outputs are committed and kept current by CI's
    // `npm run generate:check`: what they put in the bundle reaches main as a
    // commit to src/ or public/, which the clock already counts.
    const COMMITTED_OUTPUT = new Set([
      'scripts/generate-product-config.mjs',
      'scripts/generate-public-product-facts.mjs',
      'scripts/build-ai-search.mjs',
    ]);
    const derived = readFileSync(join(root, 'scripts/generate-derived.mjs'), 'utf8');
    for (const file of COMMITTED_OUTPUT) assert.ok(derived.includes(`'${file}'`), `${file} is not checked by generate:check`);
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
    const files = new Set();
    const seen = new Set();
    const walk = (command) => {
      for (const m of command.matchAll(/npm run (?:--silent )?([\w:.-]+)/g)) {
        // npm runs `pre<name>` and `post<name>` hooks around `npm run <name>`.
        for (const name of [`pre${m[1]}`, m[1], `post${m[1]}`]) {
          if (!seen.has(name) && scripts[name]) { seen.add(name); walk(scripts[name]); }
        }
      }
      for (const m of command.matchAll(/(scripts\/[\w./-]+\.(?:mjs|cjs|js|sh|ts))/g)) files.add(m[1]);
    };
    walk(conf.build.beforeBuildCommand);
    for (const file of COMMITTED_OUTPUT) files.delete(file);
    // A build script's own imports under scripts/ shape its output too.
    const queue = [...files];
    while (queue.length) {
      const file = queue.pop();
      const source = readFileSync(join(root, file), 'utf8');
      for (const m of source.matchAll(/(?:from |import\()['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
        if (target.startsWith('scripts/') && !files.has(target)) { files.add(target); queue.push(target); }
      }
    }
    assert.ok(files.has('scripts/build-sidecar-handlers.mjs'), `build chain not followed: ${[...files]}`);
    assert.ok(files.has('scripts/generate-inventory-facts.mjs'), `prebuild:desktop hook not followed: ${[...files]}`);
    const missing = [...files].filter((file) => !CHECK_ONLY.has(file) && !covered(file)).sort();
    assert.deepEqual(missing, [], 'these run in the desktop build but are outside SHIPPED_PATHS');
  });
  it('includes the sidecar handler sources and the frontend build inputs', () => {
    for (const path of ['server/worldmonitor/economic/v1/handler.ts', 'src/main.ts', 'index.html', 'vite.config.ts', 'tsconfig.json', 'src-tauri/src/main.rs']) {
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
    assert.match(job, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/, 'a dispatch from another branch must still measure main');
    assert.match(job, /node scripts\/check-desktop-release-freshness\.mjs/);
  });
});
