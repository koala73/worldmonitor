#!/usr/bin/env node
/**
 * Freeze the World Monitor GitHub star count for build-populated structured
 * data. Writes docs/snapshots/github-stars-<YYYY-MM-DD>.json.
 *
 * The homepage InteractionCounter is populated from the committed snapshot at
 * pro-test prerender time — never hardcoded, never fetched at build time — so
 * offline and credential-less builds stay deterministic. Refresh the snapshot
 * when the published count visibly drifts; the prerender test pins built
 * output to the snapshot value.
 *
 * Usage:
 *   npm run freeze:github-stars
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'koala73/worldmonitor';
const USER_AGENT = 'WorldMonitor-build/1.0 (+https://www.worldmonitor.app)';

export function snapshotPathFor(outputDir, today) {
  return join(outputDir, `github-stars-${today}.json`);
}

export async function freezeGithubStars({
  fetchImpl = globalThis.fetch,
  outputDir = join(ROOT, 'docs/snapshots'),
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const response = await fetchImpl(`https://api.github.com/repos/${REPO}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${REPO}; snapshot not written`);
  }
  const payload = await response.json();
  const count = payload?.stargazers_count;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`GitHub API returned no stargazers_count for ${REPO}; snapshot not written`);
  }
  const snapshot = {
    repository: REPO,
    stargazers_count: count,
    capturedAt: today,
  };
  const path = snapshotPathFor(outputDir, today);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { path, snapshot };
}

const invoked = process.argv[1] === fileURLToPath(import.meta.url);
if (invoked) {
  const { path, snapshot } = await freezeGithubStars();
  console.log(`froze ${snapshot.stargazers_count} stars to ${path}`);
}
