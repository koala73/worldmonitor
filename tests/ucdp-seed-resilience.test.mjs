import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/ais-relay.cjs', 'utf8');

// Extract just the seedUcdpEvents function body for targeted assertions
const fnStart = src.indexOf('async function seedUcdpEvents()');
const fnEnd = src.indexOf('\nasync function startUcdpSeedLoop()');
const fnBody = src.slice(fnStart, fnEnd);

describe('UCDP seed resilience branches', () => {
  it('logs error details on page fetch failures instead of silently swallowing', () => {
    // The .catch must include console.warn with the page number and error
    assert.match(
      fnBody,
      /\.catch\(\(err\)\s*=>\s*\{[^}]*console\.warn\(`\[UCDP\] page/,
      'Page fetch .catch should log error with page number',
    );
  });

  it('does NOT use page 0 as fallback data (would overwrite good cache with stale)', () => {
    // There must be no code path that pushes page0.Result into allEvents
    assert.ok(
      !fnBody.includes('page0.Result'),
      'seedUcdpEvents must not push page0 data into allEvents (would overwrite last known good cache)',
    );
  });

  it('extends existing key TTL when all pages fail instead of overwriting', () => {
    assert.match(
      fnBody,
      /allEvents\.length\s*===\s*0\s*&&\s*failedPages\s*>\s*0/,
      'Should check for all-pages-failed condition',
    );
    assert.match(
      fnBody,
      /upstashExpire\(UCDP_REDIS_KEY/,
      'Should call upstashExpire to extend existing key TTL',
    );
  });

  it('does NOT write seed-meta when all pages fail (would make health lie)', () => {
    // Between the "allEvents.length === 0 && failedPages > 0" check and its return,
    // there must be no upstashSet('seed-meta:...) call
    const failBranch = fnBody.slice(
      fnBody.indexOf('allEvents.length === 0 && failedPages > 0'),
      fnBody.indexOf('allEvents.length === 0 && failedPages > 0') + 300,
    );
    assert.ok(
      !failBranch.includes("upstashSet('seed-meta"),
      'All-pages-failed branch must NOT update seed-meta (health should reflect actual data freshness)',
    );
  });

  it('does NOT write seed-meta when mapped is empty after filtering', () => {
    // The "mapped.length === 0" branch should also not write seed-meta
    const emptyBranch = fnBody.slice(
      fnBody.indexOf('mapped.length === 0'),
      fnBody.indexOf('mapped.length === 0') + 300,
    );
    assert.ok(
      !emptyBranch.includes("upstashSet('seed-meta"),
      'Empty-after-filtering branch must NOT update seed-meta',
    );
  });

  it('only writes seed-meta on successful publish with actual events', () => {
    // seed-meta write should appear after upstashSet(UCDP_REDIS_KEY, payload, ...)
    const publishSection = fnBody.slice(fnBody.indexOf('const payload = {'));
    assert.match(
      publishSection,
      // Accept both the pre-contract `upstashSet(KEY, payload, ...)` shape and
      // the post-contract `envelopeWrite(KEY, payload, ...)` shape — dual
      // form is part of the seed-contract PR 2 envelope migration.
      /(?:upstashSet|envelopeWrite)\(UCDP_REDIS_KEY,\s*payload/,
      'Should write payload to UCDP key',
    );
    assert.match(
      publishSection,
      /upstashSet\('seed-meta:conflict:ucdp-events'/,
      'Should write seed-meta after successful publish',
    );
  });
});
