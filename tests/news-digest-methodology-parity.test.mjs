// Focused parity guard for the public news/digest/briefing methodology.
//
// The implementation has grown across RSS parsing, scoring, story tracking,
// digest notification, brief composition, dedupe, and cooldown modules. This
// test locks the small set of public constants/vocabularies that readers and
// API clients rely on, without trying to parse every sentence in the doc.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const docText = readFileSync(
  resolve(repoRoot, 'docs/methodology/news-digest-and-briefing.mdx'),
  'utf8',
);
const digestSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/list-feed-digest.ts'),
  'utf8',
);
const cacheKeysSrc = readFileSync(
  resolve(repoRoot, 'server/_shared/cache-keys.ts'),
  'utf8',
);
const cooldownConfigSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/digest-cooldown-config.mjs'),
  'utf8',
);
const cooldownDecisionSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/digest-cooldown-decision.mjs'),
  'utf8',
);
const seedDigestSrc = readFileSync(
  resolve(repoRoot, 'scripts/seed-digest-notifications.mjs'),
  'utf8',
);
const briefComposeSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/brief-compose.mjs'),
  'utf8',
);
const briefFilterSrc = readFileSync(
  resolve(repoRoot, 'shared/brief-filter.js'),
  'utf8',
);
const protoText = readFileSync(
  resolve(repoRoot, 'proto/worldmonitor/news/v1/list_feed_digest.proto'),
  'utf8',
);

function extractSetLiteralValues(src, constName) {
  const re = new RegExp(
    `const\\s+${constName}\\s*=\\s*(?:Object\\.freeze\\()?\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)\\s*\\)?\\s*;`,
  );
  const match = src.match(re);
  assert.ok(match, `failed to locate ${constName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function extractFunctionBody(src, functionName) {
  const re = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = src.match(re);
  assert.ok(match?.index !== undefined, `failed to locate function ${functionName}`);

  let depth = 1;
  const bodyStart = match.index + match[0].length;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return src.slice(bodyStart, i);
  }
  assert.fail(`failed to parse function body for ${functionName}`);
}

function extractNumberMapLiteral(src, constName) {
  const re = new RegExp(`const\\s+${constName}[^=]*=\\s*(\\{[\\s\\S]*?\\})\\s*(?:as const)?;`);
  const match = src.match(re);
  assert.ok(match, `failed to locate ${constName}`);
  return Object.fromEntries(
    [...match[1].matchAll(/([A-Za-z0-9_]+):\s*([0-9]+(?:\.[0-9]+)?)/g)]
      .map((m) => [m[1], Number(m[2])]),
  );
}

function extractNumericConst(src, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*([0-9_]+|Infinity)\\s*;`);
  const match = src.match(re);
  assert.ok(match, `failed to locate ${constName}`);
  return match[1] === 'Infinity'
    ? Infinity
    : Number(match[1].replace(/_/g, ''));
}

function assertDocIncludes(value, label) {
  assert.ok(
    docText.includes(String(value)),
    `news digest methodology must document ${label}: ${value}`,
  );
}

function assertDocMatches(re, label) {
  assert.ok(
    re.test(docText),
    `news digest methodology must document ${label}: ${re}`,
  );
}

describe('news digest methodology parity', () => {
  it('documents the accepted feed digest variants from VALID_VARIANTS', () => {
    const variants = extractSetLiteralValues(digestSrc, 'VALID_VARIANTS');
    assert.deepEqual(variants, ['full', 'tech', 'finance', 'happy', 'commodity']);
    for (const variant of variants) assertDocIncludes(`\`${variant}\``, `variant ${variant}`);
    for (const variant of variants) {
      assert.ok(
        protoText.includes(variant),
        `list_feed_digest.proto variant comment must mention ${variant}`,
      );
    }
    assertDocIncludes('`energy` is a site and client-feed variant', 'energy site-variant distinction');
    assertDocMatches(/variant=energy[\s\S]*to\s+`full`/, 'energy digest fallback');
    assert.ok(
      protoText.includes('including energy') && protoText.includes('fall back to full'),
      'list_feed_digest.proto variant comment must document energy fallback',
    );
  });

  it('documents the ingest freshness floor default', () => {
    assert.ok(
      digestSrc.includes('process.env.NEWS_MAX_AGE_HOURS') &&
        /const\s+hours\s*=.*\?\s*raw\s*:\s*96\s*;/s.test(digestSrc),
      'resolveMaxAgeMs must still default NEWS_MAX_AGE_HOURS to 96h',
    );
    assertDocIncludes('NEWS_MAX_AGE_HOURS', 'freshness env var');
    assertDocIncludes('`96`', 'NEWS_MAX_AGE_HOURS default');
  });

  it('documents importance-score weights and severity scores', () => {
    const weights = extractNumberMapLiteral(digestSrc, 'SCORE_WEIGHTS');
    assert.deepEqual(weights, {
      severity: 0.55,
      sourceTier: 0.2,
      corroboration: 0.15,
      recency: 0.1,
    });
    for (const [name, value] of Object.entries(weights)) {
      assertDocIncludes(value.toFixed(2), `SCORE_WEIGHTS.${name}`);
    }

    const severityScores = extractNumberMapLiteral(digestSrc, 'SEVERITY_SCORES');
    assert.deepEqual(severityScores, {
      critical: 100,
      high: 75,
      medium: 50,
      low: 25,
      info: 0,
    });
    for (const [name, value] of Object.entries(severityScores)) {
      assertDocIncludes(`\`${name}\``, `severity label ${name}`);
      assertDocIncludes(`\`${value}\``, `SEVERITY_SCORES.${name}`);
    }
  });

  it('documents item/category/brief caps from the implementation', () => {
    const itemsPerFeed = extractNumericConst(digestSrc, 'ITEMS_PER_FEED');
    const maxItemsPerCategory = extractNumericConst(digestSrc, 'MAX_ITEMS_PER_CATEGORY');
    const digestMaxItems = extractNumericConst(seedDigestSrc, 'DIGEST_MAX_ITEMS');
    const digestHighLimit = extractNumericConst(seedDigestSrc, 'DIGEST_HIGH_LIMIT');
    const digestMediumLimit = extractNumericConst(seedDigestSrc, 'DIGEST_MEDIUM_LIMIT');

    assertDocMatches(new RegExp(`reads at most\\s+\`${itemsPerFeed}\`\\s+items per feed`), 'ITEMS_PER_FEED');
    assertDocMatches(
      new RegExp(`returns at most\\s+\`${maxItemsPerCategory}\`\\s+items per\\s+category`),
      'MAX_ITEMS_PER_CATEGORY',
    );
    assertDocMatches(new RegExp(`caps at\\s+\`${digestMaxItems}\`\\s+clusters`), 'DIGEST_MAX_ITEMS');
    assertDocMatches(new RegExp(`high stories at\\s+\`${digestHighLimit}\``), 'DIGEST_HIGH_LIMIT');
    assertDocMatches(new RegExp(`medium stories at\\s+\`${digestMediumLimit}\``), 'DIGEST_MEDIUM_LIMIT');

    const readMaxStoriesBody = extractFunctionBody(briefComposeSrc, 'readMaxStoriesPerUser');
    assert.ok(
      /if\s*\(\s*raw\s*==\s*null\s*\|\|\s*raw\s*===\s*''\s*\)\s*return\s+12\s*;/.test(readMaxStoriesBody),
      'readMaxStoriesPerUser must default unset DIGEST_MAX_STORIES_PER_USER to 12',
    );
    assert.ok(
      /return\s+Number\.isFinite\(n\)\s*&&\s*n\s*>\s*0\s*\?\s*n\s*:\s*12\s*;/.test(readMaxStoriesBody),
      'readMaxStoriesPerUser must fall back to 12 for invalid or non-positive values',
    );
    assert.ok(
      /export\s+const\s+MAX_STORIES_PER_USER\s*=\s*readMaxStoriesPerUser\(\)\s*;/.test(briefComposeSrc),
      'MAX_STORIES_PER_USER must still be exported from readMaxStoriesPerUser()',
    );
    assertDocIncludes('MAX_STORIES_PER_USER', 'brief story cap name');
    assertDocIncludes('default `12`', 'MAX_STORIES_PER_USER default');

    assert.ok(
      /filterTopStories\(\{\s*stories,\s*sensitivity,\s*maxStories\s*=\s*12,\s*maxPerSourceTopic\s*=\s*2/s.test(briefFilterSrc),
      'filterTopStories defaults must remain maxStories=12 and maxPerSourceTopic=2',
    );
    assertDocMatches(/source\/category pair at\s+`2`\s+stories/, 'source/category cap');
  });

  it('documents feed-status vocabulary in code and proto', () => {
    const statuses = [...new Set(
      [...digestSrc.matchAll(/feedStatuses\[[^\]]+\]\s*=\s*'([^']+)'/g)]
        .map((m) => m[1]),
    )].sort();
    assert.deepEqual(statuses, ['all-undated', 'empty', 'partial-undated', 'timeout']);
    for (const status of statuses) {
      assertDocIncludes(`\`${status}\``, `feed_statuses value ${status}`);
      assert.ok(
        protoText.includes(status),
        `list_feed_digest.proto feed_statuses comment must mention ${status}`,
      );
    }
  });

  it('documents story-track fields and TTL split', () => {
    const expectedFields = [
      'firstSeen',
      'lastSeen',
      'mentionCount',
      'sourceCount',
      'currentScore',
      'peakScore',
      'title',
      'link',
      'severity',
      'lang',
      'description',
      'publishedAt',
      'entityCorroborationCount',
      'isOpinion',
      'isFeelGood',
      'isEphemeralLiveCoverage',
      'category',
    ];
    for (const field of expectedFields) {
      assert.ok(cacheKeysSrc.includes(field), `cache-key contract comment must mention ${field}`);
      assertDocIncludes(`\`${field}\``, `story-track field ${field}`);
    }
    assertDocIncludes('`story:track:v1:{titleHash}`', 'story track key');
    assertDocIncludes('7 days', 'story tracking TTL');
    assertDocIncludes('48 hours', 'digest accumulator TTL');
  });

  it('documents cooldown modes and table types', () => {
    const modes = extractSetLiteralValues(cooldownConfigSrc, 'VALID_MODES');
    assert.deepEqual(modes, ['shadow', 'off']);
    for (const mode of modes) assertDocIncludes(`\`${mode}\``, `cooldown mode ${mode}`);

    const typeNames = [...cooldownDecisionSrc.matchAll(/^\s*'([^']+)':\s+\{\s*hours:/gm)]
      .map((m) => m[1]);
    assert.deepEqual(typeNames, [
      'critical-developing',
      'critical-sustained',
      'high-event',
      'high-single-corporate',
      'sanctions-regulatory',
      'analysis',
      'med',
    ]);
    for (const typeName of typeNames) assertDocIncludes(`\`${typeName}\``, `cooldown type ${typeName}`);
  });
});
