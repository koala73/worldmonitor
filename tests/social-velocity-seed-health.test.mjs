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

function sourceBetween(start, end) {
  const startIndex = socialVelocityRegion.indexOf(start);
  const endIndex = socialVelocityRegion.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return socialVelocityRegion.slice(startIndex, endIndex);
}

test('social velocity writes explicit error seed-meta on Reddit fetch failures', () => {
  assert.match(socialVelocityRegion, /const SOCIAL_VELOCITY_SEED_META_KEY = 'seed-meta:intelligence:social-reddit'/);
  assert.match(socialVelocityRegion, /async function writeSocialVelocityFailureMeta\(reason\)/);
  assert.match(socialVelocityRegion, /status: 'error'/);
  assert.match(socialVelocityRegion, /errorReason: socialVelocityMetaErrorReason\(reason\)/);
  assert.match(socialVelocityRegion, /empty_reddit_response: \$\{fetchFailures\.join\('; '\)\}/);
  assert.match(socialVelocityRegion, /await writeSocialVelocityFailureMeta\(`seed_error: \$\{e\?\.message \|\| e\}`\)/);
});

test('social velocity only advances healthy seed-meta after canonical write succeeds', () => {
  const seedSocialVelocityRegion = sourceBetween(
    'async function seedSocialVelocity()',
    'async function startSocialVelocitySeedLoop()',
  );
  const healthyMetaRegion = sourceBetween(
    'async function writeSocialVelocityHealthyMeta(recordCount)',
    'async function fetchRedditHot',
  );

  assert.match(
    seedSocialVelocityRegion,
    /if \(ok\) \{\s+await writeSocialVelocityHealthyMeta\(top\.length\);\s+\} else \{/,
  );
  assert.doesNotMatch(seedSocialVelocityRegion, /if \(ok\) \{\s+await upstashSet\(SOCIAL_VELOCITY_SEED_META_KEY,/);
  assert.match(seedSocialVelocityRegion, /writeSocialVelocityFailureMeta\('canonical_write_failed'\)/);
  assert.match(healthyMetaRegion, /try \{/);
  assert.match(healthyMetaRegion, /await upstashSet\(SOCIAL_VELOCITY_SEED_META_KEY,/);
  assert.match(healthyMetaRegion, /recordCount,/);
  assert.match(healthyMetaRegion, /status: 'ok'/);
  assert.match(healthyMetaRegion, /catch \(e\) \{/);
  assert.match(healthyMetaRegion, /return false/);
});
