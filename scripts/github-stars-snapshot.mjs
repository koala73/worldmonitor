#!/usr/bin/env node
/**
 * GitHub star snapshot lookup and InteractionCounter injection for the
 * pro-test prerender. Snapshots are frozen by scripts/freeze-github-stars.mjs
 * into docs/snapshots/github-stars-<YYYY-MM-DD>.json.
 *
 * Lookup prefers the newest snapshot but falls back to older valid ones: a
 * single corrupt file must not fail the deploy. Only the absence of any valid
 * snapshot is fatal. Every failure names the file and the remediation.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SNAPSHOTS_DIR = join(ROOT, 'docs/snapshots');

const SNAPSHOT_PATTERN = /^github-stars-\d{4}-\d{2}-\d{2}\.json$/;

function readSnapshotError(name, reason) {
  return new Error(
    `star snapshot ${name} ${reason}; refresh with npm run freeze:github-stars`,
  );
}

export function latestValidGithubStarsSnapshot(snapshotsDir = SNAPSHOTS_DIR) {
  let files;
  try {
    files = readdirSync(snapshotsDir).filter((name) => SNAPSHOT_PATTERN.test(name)).sort();
  } catch (error) {
    throw new Error(
      `star snapshots unreadable at ${snapshotsDir} (${error.message}); refresh with npm run freeze:github-stars`,
    );
  }
  let lastError = null;
  for (const name of [...files].reverse()) {
    try {
      const snapshot = JSON.parse(readFileSync(join(snapshotsDir, name), 'utf8'));
      if (!Number.isInteger(snapshot.stargazers_count) || snapshot.stargazers_count < 0) {
        throw new Error('no integer stargazers_count');
      }
      return { ...snapshot, snapshotFile: name };
    } catch (error) {
      lastError = readSnapshotError(name, `unusable (${error.message})`);
    }
  }
  throw lastError ?? new Error(
    `no docs/snapshots/github-stars-*.json snapshot; run npm run freeze:github-stars`,
  );
}

export function starsInteractionCounter(snapshot) {
  return {
    '@type': 'InteractionCounter',
    interactionType: 'https://schema.org/LikeAction',
    name: 'GitHub stars',
    userInteractionCount: snapshot.stargazers_count,
  };
}
