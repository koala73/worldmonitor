import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const relaySource = readFileSync(resolve(here, '../scripts/ais-relay.cjs'), 'utf8');

const socialVelocityRegion = relaySource.slice(
  relaySource.indexOf('// Social Velocity'),
  relaySource.indexOf('// WSB Ticker Scanner'),
);

test('social velocity writes explicit error seed-meta on Reddit fetch failures', () => {
  assert.match(socialVelocityRegion, /const SOCIAL_VELOCITY_SEED_META_KEY = 'seed-meta:intelligence:social-reddit'/);
  assert.match(socialVelocityRegion, /async function writeSocialVelocityFailureMeta\(reason\)/);
  assert.match(socialVelocityRegion, /status: 'error'/);
  assert.match(socialVelocityRegion, /errorReason: socialVelocityMetaErrorReason\(reason\)/);
  assert.match(socialVelocityRegion, /empty_reddit_response: \$\{fetchFailures\.join\('; '\)\}/);
  assert.match(socialVelocityRegion, /await writeSocialVelocityFailureMeta\(`seed_error: \$\{e\?\.message \|\| e\}`\)/);
});

test('social velocity only advances healthy seed-meta after canonical write succeeds', () => {
  assert.match(
    socialVelocityRegion,
    /if \(ok\) \{\s+await upstashSet\(SOCIAL_VELOCITY_SEED_META_KEY, \{ fetchedAt: Date\.now\(\), recordCount: top\.length, sourceVersion: 'social-reddit', status: 'ok' \}, 604800\);\s+\} else \{/,
  );
  assert.match(socialVelocityRegion, /writeSocialVelocityFailureMeta\('canonical_write_failed'\)/);
});
