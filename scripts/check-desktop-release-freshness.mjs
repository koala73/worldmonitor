#!/usr/bin/env node
// Release-freshness alarm for the desktop app (#5902 §4).
//
// The desktop binary bundles the SPA and the sidecar's API handlers, so every
// change to them on main stays out of desktop users' hands until the next
// release. v2.5.23 went unreleased for seven months while main moved on, and
// nothing reported it. This monitor measures the oldest commit on main that
// touches a shipped path and is not in the latest published release, and keeps
// one issue open while that commit is older than the budget.
//
// The issue is created on a breach, updated while it lasts, and closed with a
// comment once a release ships the backlog. A comment notifies subscribers; the
// daily body edit while it stays open does not.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import { isMainModule } from './lib/main-module.mjs';

export const ISSUE_TITLE = 'Desktop release freshness: shipped changes are unreleased past budget';
export const MAX_UNRELEASED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Everything that ends up inside the desktop binary: the frontend build
// (`npm run build:desktop` → dist/, including every root HTML entry page), the
// Tauri shell, the bundle resources in src-tauri/tauri.conf.json (api/,
// shared/, data/, src/config), the server/ handlers that
// scripts/build-sidecar-handlers.mjs compiles into api/, and the scripts/ and
// convex/ modules that code imports. Entries are git pathspecs.
// tests/desktop-release-freshness.test.mjs checks this list against the
// bundle resources, the Vite entry pages and the real imports, so a new
// shipped input cannot fall outside the clock.
export const SHIPPED_PATHS = [
  'src/',
  'src-tauri/',
  'public/',
  ':(glob)*.html',
  'vite.config.ts',
  'tsconfig.json',
  'package.json',
  'package-lock.json',
  'api/',
  'server/',
  'shared/',
  'data/',
  'convex/',
  'scripts/shared/',
  'scripts/lib/',
  'scripts/data/',
  ':(glob)scripts/_*.mjs',
  'scripts/source-origin.mjs',
  'scripts/seed-trade-flows.mjs',
  'scripts/build-sidecar-handlers.mjs',
  // Writes the gitignored src-tauri/notices/ bundle resource during build:desktop.
  'scripts/generate-third-party-notices.mjs',
  // prebuild:desktop → product:facts. This generator writes the gitignored
  // public/product-facts.json (copied into dist/) and the sidecar's
  // api/_inventory-facts.generated.js; the next three are its imports. The
  // other product:facts generators write committed files that CI's
  // generate:check keeps current, so their changes reach main as src/ or
  // public/ commits.
  'scripts/generate-inventory-facts.mjs',
  'scripts/docs-stats.mjs',
  'scripts/source-attribution.mjs',
  'scripts/source-catalog-identity.mjs',
  'scripts/download-node.sh',
];

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `${cmd} failed`);
  }
  return result.stdout;
}

const ghJson = (args) => JSON.parse(run('gh', args));

function ghWrite(args, payload) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
    input: JSON.stringify(payload),
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || 'GitHub API call failed');
  }
  return JSON.parse(result.stdout);
}

/**
 * Parse `git log --format=%H%x09%cI` output, oldest first, into commits.
 * Malformed lines are an error: a silently dropped commit could hide a breach.
 */
export function parseCommits(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [sha, committedAt] = line.split('\t');
    const ms = Date.parse(committedAt);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '') || Number.isNaN(ms)) {
      throw new Error(`Unparseable git log line: ${JSON.stringify(line)}`);
    }
    return { sha, committedAt, ms };
  });
}

/** Decide whether the unreleased shipped backlog has outlived the budget. */
export function evaluateReleaseFreshness({ release, commits }, { now = Date.now(), maxDays = MAX_UNRELEASED_DAYS } = {}) {
  if (!release?.tag) throw new Error('A published release is required');
  const oldest = commits.reduce((min, c) => (min === null || c.ms < min.ms ? c : min), null);
  const ageDays = oldest ? (now - oldest.ms) / DAY_MS : 0;
  return {
    alert: ageDays > maxDays,
    release,
    unreleasedCount: commits.length,
    oldest,
    ageDays,
    maxDays,
  };
}

function statusLines(verdict) {
  const { release, unreleasedCount, oldest, ageDays, maxDays } = verdict;
  const lines = [
    `- Latest published release: \`${release.tag}\`${release.publishedAt ? ` (${release.publishedAt.slice(0, 10)})` : ''}`,
    `- Commits on main touching shipped paths since then: ${unreleasedCount}`,
  ];
  if (oldest) {
    lines.push(`- Oldest unreleased one: ${oldest.sha.slice(0, 10)}, committed ${oldest.committedAt.slice(0, 10)}, ${Math.floor(ageDays)} days ago (budget ${maxDays})`);
  }
  return lines;
}

export function renderBody(verdict, { runUrl = '' } = {}) {
  return [
    `Desktop users are running a build that lacks changes merged to main more than ${verdict.maxDays} days ago.`,
    '',
    ...statusLines(verdict),
    runUrl ? `\nDetected by [this monitor run](${runUrl}).` : null,
    '',
    'To release, set the new version in `package.json`, run `npm run version:sync` to copy it to '
      + '`src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, and merge the bump. '
      + '`desktop-release-train.yml` tags it and dispatches the build.',
    '',
    'This issue is reused while the condition persists and closed by the monitor once a release ships the backlog.',
  ].filter((line) => line !== null).join('\n');
}

export function renderRecovery(verdict, { runUrl = '' } = {}) {
  return [
    `The desktop release is within the ${verdict.maxDays}-day freshness budget again.`,
    '',
    ...statusLines(verdict),
    runUrl ? `\nRecovery detected by [this monitor run](${runUrl}).` : null,
  ].filter((line) => line !== null).join('\n');
}

export function publishReleaseFreshness(verdict, {
  repository = process.env.GITHUB_REPOSITORY,
  runUrl = '',
  summaryPath,
  gh = ghJson,
  ghPost = ghWrite,
} = {}) {
  const body = renderBody(verdict, { runUrl });
  if (summaryPath) {
    appendFileSync(summaryPath, `${verdict.alert ? body : ['Desktop release is within the freshness budget.', '', ...statusLines(verdict)].join('\n')}\n`);
  }
  if (!repository) {
    if (!verdict.alert) return { alert: false };
    throw new Error('GITHUB_REPOSITORY is required to publish release freshness findings');
  }
  const pages = gh(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=open&per_page=100`]);
  const existing = pages.flat().find((issue) => !issue.pull_request
    && issue.title === ISSUE_TITLE && issue.user?.login === 'github-actions[bot]');
  if (!verdict.alert) {
    if (!existing) return { alert: false };
    ghPost(['api', `repos/${repository}/issues/${existing.number}/comments`, '--input', '-'], {
      body: renderRecovery(verdict, { runUrl }),
    });
    ghPost(['api', '--method', 'PATCH', `repos/${repository}/issues/${existing.number}`, '--input', '-'], {
      state: 'closed',
      state_reason: 'completed',
    });
    return { alert: false, action: 'closed' };
  }
  const endpoint = `repos/${repository}/issues${existing ? `/${existing.number}` : ''}`;
  ghPost(['api', '--method', existing ? 'PATCH' : 'POST', endpoint, '--input', '-'], {
    title: ISSUE_TITLE,
    body,
  });
  return { alert: true, action: existing ? 'updated' : 'created' };
}

/** Read the latest published release and the shipped commits on HEAD since its tag. */
export function readReleaseBacklog({ repository = process.env.GITHUB_REPOSITORY, gh = ghJson, git = (args) => run('git', args) } = {}) {
  const latest = gh(['api', `repos/${repository}/releases/latest`]);
  if (!latest?.tag_name) throw new Error('GitHub returned no latest release tag');
  const release = { tag: latest.tag_name, publishedAt: latest.published_at ?? '' };
  // The tag must be in HEAD's history; otherwise the range below would count
  // commits from an unrelated line and report a false age.
  git(['merge-base', '--is-ancestor', `refs/tags/${release.tag}`, 'HEAD']);
  // --first-parent: count what landed on main, dated when it landed. A merged
  // branch's own commits keep their earlier committer dates, which would both
  // inflate the count and start the clock before the change reached main.
  const log = git(['log', '--first-parent', '--reverse', '--format=%H%x09%cI', `refs/tags/${release.tag}..HEAD`, '--', ...SHIPPED_PATHS]);
  return { release, commits: parseCommits(log) };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const verdict = evaluateReleaseFreshness(readReleaseBacklog());
    const runUrl = process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : '';
    console.log(JSON.stringify(publishReleaseFreshness(verdict, {
      runUrl,
      summaryPath: process.env.GITHUB_STEP_SUMMARY,
    })));
  } catch (error) {
    console.error(`Desktop release freshness monitor could not report: ${error.message}`);
    process.exitCode = 1;
  }
}
