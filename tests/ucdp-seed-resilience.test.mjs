import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { discoverVersion as discoverStandaloneUcdpVersion } from '../scripts/seed-ucdp-events.mjs';

const src = readFileSync('scripts/ais-relay.cjs', 'utf8');
const standaloneSrc = readFileSync('scripts/seed-ucdp-events.mjs', 'utf8');
const UCDP_REDIS_KEY = 'conflict:ucdp-events:v1';
const EXPECTED_UCDP_WRITER_PATHS = [
  'scripts/ais-relay.cjs',
  'scripts/seed-ucdp-events.mjs',
];
const SOURCE_SCAN_IGNORED_DIRS = new Set([
  '.git',
  '.vercel',
  'blog-site/node_modules',
  'coverage',
  'dist',
  'node_modules',
  'src/generated',
]);

function shouldScanSourceDir(path) {
  return !SOURCE_SCAN_IGNORED_DIRS.has(path);
}

function sourceFilesContaining(rootDir, needle) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      // The parallel test runner churns short-lived fixtures under scripts/
      // (bundle-runner, seed-utils-sigterm-cleanup), so a file readdirSync
      // just listed can vanish before we stat/read it. Such files are never
      // real source — skip them rather than letting a transient ENOENT crash
      // the whole audit (flaky under --test-concurrency); re-throw anything
      // else so a genuine fs error still surfaces.
      let stat;
      try {
        stat = statSync(path);
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (stat.isDirectory()) {
        if (!shouldScanSourceDir(path)) continue;
        stack.push(path);
        continue;
      }
      if (!/\.(?:cjs|mjs|js|mts|ts)$/.test(path)) continue;
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw err;
      }
      if (text.includes(needle)) matches.push(path);
    }
  }
  return matches.sort();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ucdpRedisWriterPaths() {
  return sourceFilesContaining('.', UCDP_REDIS_KEY)
    .filter((path) => !path.endsWith('.test.mjs') && !path.endsWith('.test.mts'))
    .filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (new RegExp(`(?:envelopeWrite|upstashSet)\\(\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`).test(text)) {
        return true;
      }
      if (new RegExp(`\\[\\s*['"]SET['"]\\s*,\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`).test(text)) {
        return true;
      }
      const keyVars = Array.from(
        text.matchAll(new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"]${escapeRegExp(UCDP_REDIS_KEY)}['"]`, 'g')),
        (match) => match[1],
      );
      return keyVars.some((keyVar) => (
        new RegExp(`(?:envelopeWrite|upstashSet)\\(\\s*${keyVar}\\b`).test(text)
          || new RegExp(`\\[\\s*['"]SET['"]\\s*,\\s*${keyVar}\\b`).test(text)
      ));
    })
    .map((path) => path.replace(/\\/g, '/'))
    .sort();
}

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

  it('all UCDP Redis writers are covered by this guard', () => {
    assert.deepEqual(ucdpRedisWriterPaths(), EXPECTED_UCDP_WRITER_PATHS);
  });

  it('standalone cron discovery also requires non-empty Result for the same Redis key', async () => {
    assert.match(standaloneSrc, /const REDIS_KEY = 'conflict:ucdp-events:v1'/);
    const standaloneDiscover = standaloneSrc.slice(
      standaloneSrc.indexOf('async function discoverVersion('),
      standaloneSrc.indexOf('function parseDateMs('),
    );
    assert.match(
      standaloneDiscover,
      /!Array\.isArray\(page0\?\.Result\) \|\| page0\.Result\.length === 0/,
      'standalone UCDP seeder must not let an empty newer GED release win',
    );

    const pages = new Map([
      ['26.1', { Result: [], TotalPages: 1 }],
      ['25.1', { Result: [{ id: 'older-populated' }], TotalPages: 1 }],
    ]);
    const originalLog = console.log;
    console.log = () => {};
    try {
      const selected = await discoverStandaloneUcdpVersion(
        '',
        async (version) => pages.get(version),
        ['26.1', '25.1'],
      );
      assert.equal(selected.version, '25.1');
      assert.deepEqual(selected.page0.Result, [{ id: 'older-populated' }]);
    } finally {
      console.log = originalLog;
    }
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
