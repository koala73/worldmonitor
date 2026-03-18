/**
 * Regression test: digest-backed news items must NOT trigger client-side
 * classifyWithAI calls. The server digest already runs enrichWithAiCache()
 * against the same Redis keys, so client reclassification wastes edge requests.
 *
 * Run: node --test tests/digest-no-reclassify.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(__dirname, '..', 'src', 'app', 'data-loader.ts'), 'utf-8');
const serverSrc = readFileSync(
  resolve(__dirname, '..', 'server', 'worldmonitor', 'news', 'v1', 'list-feed-digest.ts'),
  'utf-8',
);

describe('Digest branch must not reclassify with AI', () => {
  const digestBranchStart = src.indexOf("// Digest branch: server already aggregated feeds");
  const digestBranchEnd = src.indexOf('} else {', digestBranchStart);
  const digestBranch = src.slice(digestBranchStart, digestBranchEnd);

  it('digest branch exists in data-loader.ts', () => {
    assert.ok(digestBranchStart !== -1, 'Digest branch comment must exist');
    assert.ok(digestBranchEnd > digestBranchStart, 'Digest branch must have an else clause');
  });

  it('digest branch does NOT call classifyWithAI', () => {
    assert.ok(!digestBranch.includes('classifyWithAI'),
      'Digest items must not trigger classifyWithAI (server already classified via enrichWithAiCache)');
  });

  it('digest branch does NOT call canQueueAiClassification', () => {
    assert.ok(!digestBranch.includes('canQueueAiClassification'),
      'Digest items must not be queued for AI classification');
  });

  it('digest branch does NOT reference aiCandidates', () => {
    assert.ok(!digestBranch.includes('aiCandidates'),
      'No aiCandidates filtering should exist in the digest branch');
  });

  it('classifyWithAI is not imported in data-loader.ts', () => {
    assert.ok(!src.includes("import { classifyWithAI }") && !src.includes("import { classifyWithAI,"),
      'classifyWithAI should not be imported (no call sites remain)');
  });

  it('canQueueAiClassification is not imported in data-loader.ts', () => {
    assert.ok(!src.includes("import { canQueueAiClassification"),
      'canQueueAiClassification should not be imported (no call sites remain)');
  });
});

describe('feedStatuses must not emit ok entries', () => {
  it('buildDigest does not write ok to feedStatuses', () => {
    assert.ok(
      !serverSrc.includes("feedStatuses[feed.name] = items.length > 0 ? 'ok' : 'empty'"),
      "feedStatuses must not write 'ok' entries — wastes payload on every response",
    );
  });
});
