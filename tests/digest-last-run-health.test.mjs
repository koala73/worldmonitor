import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  resolve(__dirname, '../scripts/seed-digest-notifications.mjs'),
  'utf-8',
);

function sourceBetween(start, end) {
  const startIndex = src.indexOf(start);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  const endIndex = src.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return src.slice(startIndex, endIndex);
}

describe('digest-notifications last-run health heartbeat', () => {
  it('defines keys that match api/health.js digestNotifications', () => {
    assert.match(src, /const DIGEST_LAST_RUN_KEY = 'digest:last-run'/);
    assert.match(src, /const DIGEST_LAST_RUN_META_KEY = 'seed-meta:digest:last-run'/);
    assert.match(src, /const DIGEST_LAST_RUN_TTL_SECONDS = 7 \* 24 \* 60 \* 60/);
  });

  it('writes both the data heartbeat and seed-meta heartbeat with positive recordCount', () => {
    const writer = sourceBetween(
      'async function writeDigestLastRunMeta({',
      'function toLocalHour(nowMs, timezone)',
    );

    assert.match(writer, /recordCount: 1/);
    assert.match(writer, /status,/);
    assert.match(writer, /sentCount,/);
    assert.match(writer, /errorReason/);
    assert.match(writer, /\['SET', DIGEST_LAST_RUN_KEY, JSON\.stringify\(run\), 'EX', String\(DIGEST_LAST_RUN_TTL_SECONDS\)\]/);
    assert.match(writer, /\['SET', DIGEST_LAST_RUN_META_KEY, JSON\.stringify\(run\), 'EX', String\(DIGEST_LAST_RUN_TTL_SECONDS\)\]/);
  });

  it('stamps SEED_ERROR metadata for rule-fetch failures', () => {
    assert.match(
      src,
      /if \(!res\.ok\) \{[\s\S]*?await writeDigestLastRunMeta\(\{[\s\S]*?status: 'error'[\s\S]*?errorReason: `fetch_rules_http_\$\{res\.status\}`,[\s\S]*?\}\);[\s\S]*?return;/,
    );
    assert.match(
      src,
      /catch \(err\) \{[\s\S]*?await writeDigestLastRunMeta\(\{[\s\S]*?status: 'error'[\s\S]*?errorReason: `fetch_rules_failed:\$\{err\.message\}`,[\s\S]*?\}\);[\s\S]*?return;/,
    );
  });

  it('stamps a healthy run even when there is nothing to send', () => {
    assert.match(
      src,
      /No digest rules found[\s\S]*?await writeDigestLastRunMeta\(\{ startedAtMs: nowMs, sentCount: 0 \}\);[\s\S]*?return;/,
    );
    assert.match(
      src,
      /No rules matched userId=\$\{onlyUserFilter\.userId\}[\s\S]*?await writeDigestLastRunMeta\(\{ startedAtMs: nowMs, sentCount: 0 \}\);[\s\S]*?return;/,
    );
  });

  it('stamps brief-compose failures before nonzero exit and healthy runs at the end', () => {
    assert.match(
      src,
      /if \(shouldExitOnBriefFailures\(\{ success: composeSuccess, failed: composeFailed \}\)\) \{[\s\S]*?await writeDigestLastRunMeta\(\{[\s\S]*?status: 'error'[\s\S]*?sentCount,[\s\S]*?brief_compose_failed:\$\{composeFailed\}:success:\$\{composeSuccess\}[\s\S]*?\}\);[\s\S]*?process\.exit\(1\);/,
    );
    assert.match(src, /await writeDigestLastRunMeta\(\{ startedAtMs: nowMs, sentCount \}\);/);
  });

  it('stamps fatal crashes before process.exit(1)', () => {
    assert.match(
      src,
      /main\(\)\.catch\(async \(err\) => \{[\s\S]*?await writeDigestLastRunMeta\(\{[\s\S]*?status: 'error'[\s\S]*?errorReason: `fatal:\$\{err\?\.message \?\? err\}`,[\s\S]*?\}\);[\s\S]*?process\.exit\(1\);/,
    );
  });

  it('uses the main start time for fatal-crash duration metadata', () => {
    assert.match(src, /let digestRunStartedAtMs = null;/);
    assert.match(src, /const nowMs = Date\.now\(\);\s+digestRunStartedAtMs = nowMs;/);
    assert.match(
      src,
      /main\(\)\.catch\(async \(err\) => \{[\s\S]*?const finishedAtMs = Date\.now\(\);[\s\S]*?startedAtMs: digestRunStartedAtMs \?\? finishedAtMs,[\s\S]*?finishedAtMs,[\s\S]*?process\.exit\(1\);/,
    );
    assert.doesNotMatch(
      src,
      /main\(\)\.catch\(async \(err\) => \{[\s\S]*?startedAtMs: Date\.now\(\)/,
    );
  });
});
