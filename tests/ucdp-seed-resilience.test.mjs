import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
const standaloneSeedSrc = readFileSync('scripts/seed-ucdp-events.mjs', 'utf8');

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

// Brace-matched extraction of a top-level function declaration from the source.
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

describe('UCDP version selection prefers the newest release', () => {
  const discover = src.slice(
    src.indexOf('async function ucdpDiscoverVersion()'),
    src.indexOf('async function seedUcdpEvents()'),
  );

  it('probes all candidates and does NOT first-responder race (Promise.any)', () => {
    // Promise.any let an older release that merely replied faster win, freezing
    // conflict:ucdp-events:v1 at v24.1 (2023 data) outside the CII 2-year window.
    // Match the CALL form (`Promise.any(`) so the explanatory comment that names
    // the old behavior doesn't trip this guard.
    assert.doesNotMatch(discover, /Promise\.any\(/, 'must not first-responder race');
    assert.match(discover, /Promise\.allSettled\(/, 'must probe all candidates');
  });

  it('selects the newest valid version (sorts by ucdpVersionNewer)', () => {
    assert.match(discover, /ucdpVersionNewer\(/, 'must rank candidates by version recency');
    // only versions that returned a non-empty Result are eligible
    assert.match(discover, /Result\.length === 0\) throw/);
  });

  it('on-demand relay discovery requires a non-empty Result (no empty newer wins)', () => {
    const relayDiscover = src.slice(
      src.indexOf('async function ucdpRelayDiscoverVersion()'),
      src.indexOf('async function ucdpFetchAllEvents()'),
    );
    assert.match(relayDiscover, /Array\.isArray\(page0\?\.Result\) && page0\.Result\.length > 0/);
  });

  it('standalone cron discovery also requires non-empty Result for the same Redis key', () => {
    assert.match(standaloneSeedSrc, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    const standaloneDiscover = standaloneSeedSrc.slice(
      standaloneSeedSrc.indexOf('async function discoverVersion('),
      standaloneSeedSrc.indexOf('function parseDateMs('),
    );
    assert.match(
      standaloneDiscover,
      /!Array\.isArray\(page0\?\.Result\) \|\| page0\.Result\.length === 0/,
      'standalone UCDP seeder must not let an empty newer GED release win',
    );
  });

  it('ucdpVersionNewer ranks GED versions newest-first (behavioral)', () => {
    const ucdpVersionNewer = new Function(
      `${extractFn('ucdpVersionRank')}\n${extractFn('ucdpVersionNewer')}\nreturn ucdpVersionNewer;`,
    )();
    assert.equal(ucdpVersionNewer('25.1', '24.1'), true, '25.1 newer than 24.1');
    assert.equal(ucdpVersionNewer('24.1', '25.1'), false, '24.1 not newer than 25.1');
    assert.equal(ucdpVersionNewer('26.1', '25.1'), true, '26.1 newer than 25.1');
    assert.equal(ucdpVersionNewer('25.0.6', '25.0.5'), true, 'monthly candidate ordering');
    assert.equal(ucdpVersionNewer('24.1', '24.1'), false, 'equal versions are not newer');
  });
});
