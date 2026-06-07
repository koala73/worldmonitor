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
const summarizeSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/summarize-article.ts'),
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
const newsItemProtoText = readFileSync(
  resolve(repoRoot, 'proto/worldmonitor/news/v1/news_item.proto'),
  'utf8',
);
const summarizeArticleProtoText = readFileSync(
  resolve(repoRoot, 'proto/worldmonitor/news/v1/summarize_article.proto'),
  'utf8',
);
const newsServiceOpenApiText = readFileSync(
  resolve(repoRoot, 'docs/api/NewsService.openapi.json'),
  'utf8',
);
const newsServiceOpenApiYaml = readFileSync(
  resolve(repoRoot, 'docs/api/NewsService.openapi.yaml'),
  'utf8',
);
const worldmonitorOpenApiYaml = readFileSync(
  resolve(repoRoot, 'docs/api/worldmonitor.openapi.yaml'),
  'utf8',
);
const newsServiceOpenApi = JSON.parse(newsServiceOpenApiText);

function extractSetLiteralValues(src, constName) {
  const re = new RegExp(
    `const\\s+${constName}\\s*=\\s*(?:Object\\.freeze\\()?\\s*new\\s+Set\\s*\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)\\s*\\)?\\s*;`,
  );
  const match = src.match(re);
  assert.ok(match, `failed to locate ${constName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function extractFunctionBody(src, functionName) {
  const re = new RegExp(`function\\s+${functionName}\\s*\\([^)]*\\)\\s*(?::[^\\{]+)?\\{`);
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

function extractInterfaceBody(src, interfaceName) {
  const re = new RegExp(`interface\\s+${interfaceName}\\s*\\{`);
  const match = src.match(re);
  assert.ok(match?.index !== undefined, `failed to locate interface ${interfaceName}`);

  let depth = 1;
  const bodyStart = match.index + match[0].length;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) return src.slice(bodyStart, i);
  }
  assert.fail(`failed to parse interface body for ${interfaceName}`);
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

function extractStringUnionValues(src, propertyName) {
  const re = new RegExp(`${propertyName}\\s*:\\s*([^;]+);`);
  const match = src.match(re);
  assert.ok(match, `failed to locate union property ${propertyName}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function extractPromptPairLimit(src) {
  const match = src.match(/nonEmpty\.slice\(0,\s*([0-9]+)\)/);
  assert.ok(match, 'failed to locate prompt-pair headline limit');
  return Number(match[1]);
}

function extractEntityCorroborationCap(src) {
  const body = extractFunctionBody(src, 'entityCorroborationScore');
  const match = body.match(/Math\.min\(\s*Math\.max\([^,]+,\s*0\s*\),\s*([0-9]+)\s*\)/);
  assert.ok(match, 'failed to locate entity corroboration source cap');
  return Number(match[1]);
}

function openApiDescription(schemaName, propertyName, nestedPropertyName) {
  let property = newsServiceOpenApi.components.schemas[schemaName]?.properties?.[propertyName];
  if (nestedPropertyName) property = property?.items?.properties?.[nestedPropertyName] ?? property?.items;
  const description = property?.description ?? property?.items?.description;
  assert.ok(description, `failed to locate ${schemaName}.${propertyName} description`);
  return description;
}

function extractYamlSchemaBlock(yamlText, schemaName) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((line) => line === `        ${schemaName}:`);
  assert.notEqual(start, -1, `failed to locate YAML schema ${schemaName}`);

  const end = lines.findIndex((line, index) =>
    index > start && /^        \S.*:\s*$/.test(line),
  );
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
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
  it('keeps SummarizeArticle headline limits aligned across implementation and API docs', () => {
    const rawHeadlineLimit = extractNumericConst(summarizeSrc, 'MAX_HEADLINES');
    const promptPairLimit = extractPromptPairLimit(summarizeSrc);
    assert.equal(rawHeadlineLimit, 10);
    assert.equal(promptPairLimit, 5);

    const headlineDescription = openApiDescription('SummarizeArticleRequest', 'headlines');
    const newsServiceRequestYaml = extractYamlSchemaBlock(newsServiceOpenApiYaml, 'SummarizeArticleRequest');
    const worldmonitorRequestYaml = extractYamlSchemaBlock(
      worldmonitorOpenApiYaml,
      'worldmonitor_news_v1_SummarizeArticleRequest',
    );
    for (const surface of [
      summarizeArticleProtoText,
      headlineDescription,
      newsServiceRequestYaml,
      worldmonitorRequestYaml,
    ]) {
      assert.ok(
        surface.includes(`Up to ${rawHeadlineLimit} raw headlines`),
        'SummarizeArticle docs must document raw headline cache/input limit',
      );
      assert.ok(
        surface.includes(`up to ${promptPairLimit} unique, non-empty`),
        'SummarizeArticle docs must document prompt-pair limit',
      );
      assert.ok(
        surface.includes('headline/body pairs'),
        'SummarizeArticle docs must document paired headline/body behavior',
      );
      assert.ok(
        !surface.includes('max 8 used'),
        'SummarizeArticle docs must not retain the stale max-8 contract',
      );
    }
  });

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

  it('documents importance-score boosts in the API contract', () => {
    const diplomacyBoost = extractNumericConst(digestSrc, 'DIPLOMACY_FLASHPOINT_BOOST');
    const entityBoost = extractNumericConst(digestSrc, 'ENTITY_CORROBORATION_SCORE_PER_SOURCE');
    const entityCap = extractEntityCorroborationCap(digestSrc);
    assert.equal(diplomacyBoost, 18);
    assert.equal(entityBoost, 4);
    assert.equal(entityCap, 5);
    const boostedScoreCap = 100 + diplomacyBoost + entityBoost * entityCap;
    assert.equal(boostedScoreCap, 138);

    const importanceDescription = openApiDescription('NewsItem', 'importanceScore');
    const newsServiceNewsItemYaml = extractYamlSchemaBlock(newsServiceOpenApiYaml, 'NewsItem');
    const worldmonitorNewsItemYaml = extractYamlSchemaBlock(
      worldmonitorOpenApiYaml,
      'worldmonitor_news_v1_NewsItem',
    );
    for (const surface of [
      newsItemProtoText,
      importanceDescription,
      newsServiceNewsItemYaml,
      worldmonitorNewsItemYaml,
    ]) {
      assert.ok(
        surface.includes(`${diplomacyBoost}-point diplomacy/flashpoint boost`),
        'NewsItem.importanceScore docs must document the diplomacy/flashpoint boost',
      );
      assert.ok(
        surface.includes(`${entityBoost} points per entity-level`) &&
          surface.includes('capped at five sources'),
        'NewsItem.importanceScore docs must document entity corroboration boost and cap',
      );
      assert.ok(
        surface.includes('final score can exceed') &&
          surface.includes('100') &&
          surface.includes(String(boostedScoreCap)),
        'NewsItem.importanceScore docs must document the boosted final score range',
      );
      assert.ok(
        !surface.includes('Composite importance score (0-100):'),
        'NewsItem.importanceScore docs must not imply the final score is only the base 0-100 formula',
      );
    }
  });

  it('documents emitted threat classification sources in the API contract', () => {
    const parsedItemInterface = extractInterfaceBody(digestSrc, 'ParsedItem');
    const classSources = extractStringUnionValues(parsedItemInterface, 'classSource');
    assert.deepEqual(classSources, ['keyword', 'keyword-historical-downgrade', 'llm']);

    const sourceDescription = openApiDescription('ThreatClassification', 'source');
    const newsServiceThreatYaml = extractYamlSchemaBlock(newsServiceOpenApiYaml, 'ThreatClassification');
    const worldmonitorThreatYaml = extractYamlSchemaBlock(
      worldmonitorOpenApiYaml,
      'worldmonitor_news_v1_ThreatClassification',
    );
    for (const surface of [
      newsItemProtoText,
      sourceDescription,
      newsServiceThreatYaml,
      worldmonitorThreatYaml,
    ]) {
      for (const classSource of classSources) {
        assert.ok(
          surface.includes(`"${classSource}"`),
          `ThreatClassification.source docs must mention ${classSource}`,
        );
      }
      assert.ok(
        !surface.includes('"ml"'),
        'ThreatClassification.source docs must not retain stale ml vocabulary',
      );
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
