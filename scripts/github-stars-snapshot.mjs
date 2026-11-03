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

const SNAPSHOT_PATTERN = /^github-stars-(\d{4}-\d{2}-\d{2})\.json$/;
const REPOSITORY = 'koala73/worldmonitor';

// The committed snapshot is published as the homepage star count, and nothing
// re-runs the freeze automatically except
// .github/workflows/github-stars-refresh.yml — so bound the age here: a
// forgotten or failed refresh must red the build rather than silently publish
// a rotting figure under a live count (#7641). The lookup still falls back
// past corrupt files to older valid ones, but only inside this bound: a missed
// refresh degrades gracefully until the ceiling trips.
//
// Sized to clear the MONTHLY refresh cadence with slack: the cron freezes on
// the 1st, so this leaves ~2 weeks to merge a refresh PR before the build
// reds. The ceiling and the cron are one contract: relaxing either without the
// other reopens the gap, and a guard in tests/github-stars-snapshot.test.mjs
// asserts they still agree.
export const MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS = 45;

function readSnapshotError(name, reason) {
  return new Error(
    `star snapshot ${name} ${reason}; refresh with npm run freeze:github-stars`,
  );
}

function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

export function latestValidGithubStarsSnapshot(
  snapshotsDir = SNAPSHOTS_DIR,
  currentUtcDate = new Date().toISOString().slice(0, 10),
) {
  let files;
  try {
    files = readdirSync(snapshotsDir).filter((name) => SNAPSHOT_PATTERN.test(name)).sort();
  } catch (error) {
    throw new Error(
      `star snapshots unreadable at ${snapshotsDir} (${error.message}); refresh with npm run freeze:github-stars`,
    );
  }
  let lastError = null;
  let newestValid = null;
  for (const name of [...files].reverse()) {
    try {
      const snapshot = JSON.parse(readFileSync(join(snapshotsDir, name), 'utf8'));
      const filenameDate = SNAPSHOT_PATTERN.exec(name)?.[1];
      if (snapshot.repository !== REPOSITORY) {
        throw new Error(`repository must be ${REPOSITORY}`);
      }
      if (!Number.isInteger(snapshot.stargazers_count) || snapshot.stargazers_count < 0) {
        throw new Error('no integer stargazers_count');
      }
      if (!isRealCalendarDate(snapshot.capturedAt)) {
        throw new Error('capturedAt must be a real YYYY-MM-DD calendar date');
      }
      if (snapshot.capturedAt !== filenameDate) {
        throw new Error(`capturedAt ${snapshot.capturedAt} does not match filename date ${filenameDate}`);
      }
      if (snapshot.capturedAt > currentUtcDate) {
        throw new Error(`capturedAt ${snapshot.capturedAt} is in the future`);
      }
      newestValid = { ...snapshot, snapshotFile: name };
      break;
    } catch (error) {
      lastError = readSnapshotError(name, `unusable (${error.message})`);
    }
  }
  if (!newestValid) {
    throw lastError ?? new Error(
      `no docs/snapshots/github-stars-*.json snapshot; run npm run freeze:github-stars`,
    );
  }
  const ageDays = (Date.parse(`${currentUtcDate}T00:00:00Z`) - Date.parse(`${newestValid.capturedAt}T00:00:00Z`)) / 86_400_000;
  if (ageDays > MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS) {
    throw new Error(
      `star snapshot ${newestValid.snapshotFile} is ${Math.round(ageDays)} days old (max ${MAX_GITHUB_STARS_SNAPSHOT_AGE_DAYS}); run npm run freeze:github-stars`,
    );
  }
  return newestValid;
}

export function starsInteractionCounter(snapshot) {
  return {
    '@type': 'InteractionCounter',
    interactionType: 'https://schema.org/LikeAction',
    name: 'GitHub stars',
    userInteractionCount: snapshot.stargazers_count,
  };
}

const SOFTWARE_ID = 'https://www.worldmonitor.app/#software';

/**
 * Insert the star InteractionCounter into every #software JSON-LD node in the
 * HTML. Nodes that already carry one are left alone (never double-inject).
 * Returns the rewritten HTML plus whether any node was populated, so callers
 * can fail loudly when a page that must carry the counter has no node.
 */
export function injectStarsInteractionCounter(html, snapshot) {
  let injected = false;
  const next = String(html).replace(
    /<script type="application\/ld\+json"([^>]*)>([\s\S]*?)<\/script>/g,
    (tag, attrs, body) => {
      let node;
      try {
        node = JSON.parse(body);
      } catch {
        return tag;
      }
      const nodes = Array.isArray(node) ? node : [node];
      const app = nodes.find((entry) => entry && entry['@id'] === SOFTWARE_ID);
      if (!app || app.interactionStatistic !== undefined) return tag;
      app.interactionStatistic = starsInteractionCounter(snapshot);
      injected = true;
      return `<script type="application/ld+json"${attrs}>${JSON.stringify(node, null, 2).replace(/</g, '\\u003c')}</script>`;
    },
  );
  return { html: next, injected };
}
