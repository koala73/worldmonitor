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
const aiIntelligenceText = readFileSync(
  resolve(repoRoot, 'docs/ai-intelligence.mdx'),
  'utf8',
);
const algorithmsText = readFileSync(
  resolve(repoRoot, 'docs/algorithms.mdx'),
  'utf8',
);
const apiBriefText = readFileSync(
  resolve(repoRoot, 'docs/api-brief.mdx'),
  'utf8',
);
const latestBriefPanelText = readFileSync(
  resolve(repoRoot, 'docs/panels/latest-brief.mdx'),
  'utf8',
);
const dataSourcesText = readFileSync(
  resolve(repoRoot, 'docs/data-sources.mdx'),
  'utf8',
);
const panelNewsFeedsText = readFileSync(
  resolve(repoRoot, 'docs/panels/news-feeds.mdx'),
  'utf8',
);
const panelIndicatorsText = readFileSync(
  resolve(repoRoot, 'docs/panels/indicators-and-signals.mdx'),
  'utf8',
);
const digestSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/list-feed-digest.ts'),
  'utf8',
);
const classifierSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/_classifier.ts'),
  'utf8',
);
const breakingAlertsSrc = readFileSync(
  resolve(repoRoot, 'src/services/breaking-news-alerts.ts'),
  'utf8',
);
const summarizeSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/summarize-article.ts'),
  'utf8',
);
const feedsSrc = readFileSync(
  resolve(repoRoot, 'server/worldmonitor/news/v1/_feeds.ts'),
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
const latestBriefApiSrc = readFileSync(
  resolve(repoRoot, 'api/latest-brief.ts'),
  'utf8',
);
const apiRouteExceptionsText = readFileSync(
  resolve(repoRoot, 'api/api-route-exceptions.json'),
  'utf8',
);
const briefShareUrlApiSrc = readFileSync(
  resolve(repoRoot, 'api/brief/share-url.ts'),
  'utf8',
);
const publicBriefApiSrc = readFileSync(
  resolve(repoRoot, 'api/brief/public/[hash].ts'),
  'utf8',
);
const signedBriefApiSrc = readFileSync(
  resolve(repoRoot, 'api/brief/[userId]/[issueDate].ts'),
  'utf8',
);
const sharedBriefEnvelopeText = readFileSync(
  resolve(repoRoot, 'shared/brief-envelope.d.ts'),
  'utf8',
);
const briefShareUrlSrc = readFileSync(
  resolve(repoRoot, 'server/_shared/brief-share-url.ts'),
  'utf8',
);
const briefUrlSrc = readFileSync(
  resolve(repoRoot, 'server/_shared/brief-url.ts'),
  'utf8',
);
const briefRenderSrc = readFileSync(
  resolve(repoRoot, 'server/_shared/brief-render.js'),
  'utf8',
);
const scriptBriefUrlSignSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/brief-url-sign.mjs'),
  'utf8',
);
const briefComposeSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/brief-compose.mjs'),
  'utf8',
);
const briefDedupConstsSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/brief-dedup-consts.mjs'),
  'utf8',
);
const briefDedupJaccardSrc = readFileSync(
  resolve(repoRoot, 'scripts/lib/brief-dedup-jaccard.mjs'),
  'utf8',
);
const briefFilterSrc = readFileSync(
  resolve(repoRoot, 'shared/brief-filter.js'),
  'utf8',
);
const weeklyBriefSrc = readFileSync(
  resolve(repoRoot, 'scripts/regional-snapshot/weekly-brief.mjs'),
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

function extractArrayLiteralValues(src, constName) {
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*\\[`);
  const match = src.match(re);
  assert.ok(match?.index !== undefined, `failed to locate ${constName}`);

  let depth = 1;
  let quote = null;
  let escaped = false;
  const bodyStart = match.index + match[0].length;
  for (let i = bodyStart; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0) {
      const body = src.slice(bodyStart, i);
      return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    }
  }
  assert.fail(`failed to parse array literal ${constName}`);
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
  const re = new RegExp(`const\\s+${constName}\\s*=\\s*([0-9_]+(?:\\.[0-9_]+)?|Infinity)\\s*;`);
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

function extractStoryTrackWriterFields(src) {
  const body = extractFunctionBody(src, 'buildStoryTrackHsetFields');
  const hsetFields = [...body.matchAll(/^\s*'([A-Za-z][A-Za-z0-9]*)',/gm)]
    .map((m) => m[1]);
  assert.ok(hsetFields.length > 0, 'failed to extract story-track HSET fields');

  const writeStoryTrackingBody = extractFunctionBody(src, 'writeStoryTracking');
  const commandFields = [...writeStoryTrackingBody.matchAll(
    /\['(?:HSETNX|HINCRBY)',\s*trackKey,\s*'([A-Za-z][A-Za-z0-9]*)'/g,
  )].map((m) => m[1]);
  assert.ok(commandFields.includes('firstSeen'), 'failed to extract story-track HSETNX firstSeen field');
  assert.ok(commandFields.includes('mentionCount'), 'failed to extract story-track HINCRBY mentionCount field');

  return [...new Set([...hsetFields, ...commandFields])].sort();
}

function extractDocStoryTrackHashFields(text) {
  const match = text.match(/The story-track hash fields written today are:\n\n([\s\S]*?)\n\n/);
  assert.ok(match, 'failed to locate documented story-track hash field list');
  return [...match[1].matchAll(/`([A-Za-z][A-Za-z0-9]*)`/g)]
    .map((m) => m[1])
    .sort();
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

function formatFeedName(name, lang) {
  return lang ? `${name} (${lang})` : name;
}

function extractFeedInventoryRows(src) {
  const rows = [];
  let inVariants = false;
  let currentVariant = null;
  let currentCategory = null;

  for (const line of src.split(/\r?\n/)) {
    if (line.startsWith('export const VARIANT_FEEDS')) {
      inVariants = true;
      continue;
    }
    if (!inVariants) continue;
    if (line.startsWith('};')) break;

    const variantMatch = line.match(/^  ([A-Za-z][A-Za-z0-9_]*): \{$/);
    if (variantMatch) {
      currentVariant = variantMatch[1];
      currentCategory = null;
      continue;
    }
    if (currentVariant && line === '  },') {
      currentVariant = null;
      currentCategory = null;
      continue;
    }

    const categoryMatch = line.match(/^    (?:(['"])(.*?)\1|([A-Za-z][A-Za-z0-9_]*)):\s\[$/);
    if (currentVariant && categoryMatch) {
      currentCategory = categoryMatch[2] ?? categoryMatch[3];
      rows.push({ variant: currentVariant, category: currentCategory, sources: [] });
      continue;
    }
    if (currentCategory && line === '    ],') {
      currentCategory = null;
      continue;
    }

    const feedMatch = line.match(/\{\s*name:\s*(['"])(.*?)\1,/);
    if (currentVariant && currentCategory && feedMatch) {
      const lang = line.match(/lang:\s*'([^']+)'/)?.[1];
      rows.at(-1).sources.push(formatFeedName(feedMatch[2], lang));
    }
  }

  const intelSources = [];
  let inIntelSources = false;
  for (const line of src.split(/\r?\n/)) {
    if (line.startsWith('export const INTEL_SOURCES')) {
      inIntelSources = true;
      continue;
    }
    if (!inIntelSources) continue;
    if (line.startsWith('];')) break;
    const feedMatch = line.match(/\{\s*name:\s*(['"])(.*?)\1,/);
    if (feedMatch) {
      const lang = line.match(/lang:\s*'([^']+)'/)?.[1];
      intelSources.push(formatFeedName(feedMatch[2], lang));
    }
  }

  assert.ok(rows.length > 0, 'failed to extract VARIANT_FEEDS inventory rows');
  assert.ok(intelSources.length > 0, 'failed to extract INTEL_SOURCES inventory');
  const fullSectionInsertAt = rows.findLastIndex((row) => row.variant === 'full');
  assert.notEqual(fullSectionInsertAt, -1, 'failed to extract full variant rows for INTEL_SOURCES insertion');
  rows.splice(
    fullSectionInsertAt + 1,
    0,
    { variant: 'full', category: 'intel', sources: intelSources },
  );
  return rows;
}

function formatInventoryRow(row) {
  return `| \`${row.variant}\` | \`${row.category}\` | ${row.sources.join('; ')} |`;
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

  it('documents the server news feed inventory in public data-source docs', () => {
    assert.ok(
      dataSourcesText.includes('source-backed from `server/worldmonitor/news/v1/_feeds.ts`'),
      'data sources page must identify _feeds.ts as the server inventory source of truth',
    );

    const rows = extractFeedInventoryRows(feedsSrc);
    assert.equal(
      rows.length,
      65,
      'server news feed inventory row count changed; update _feeds.ts, docs/data-sources.mdx, and this assertion together',
    );
    for (const row of rows) {
      assert.ok(
        dataSourcesText.includes(formatInventoryRow(row)),
        `data sources page must disclose feed inventory row ${row.variant}/${row.category}`,
      );
    }

    assert.ok(
      dataSourcesText.includes('Trump - Truth Social'),
      'data sources page must disclose politically sensitive source choices',
    );
    assert.ok(
      panelNewsFeedsText.includes('server digest feed inventory'),
      'news-feeds panel docs should point readers to disclosed server inventory',
    );
    for (const [label, text] of [
      ['news-feeds panel docs', panelNewsFeedsText],
      ['indicators-and-signals panel docs', panelIndicatorsText],
    ]) {
      assert.doesNotMatch(
        text,
        /full upstream source list/i,
        `${label} must not reintroduce the unbacked full upstream source list claim`,
      );
    }
  });

  it('documents news digest cache TTLs from the implementation', () => {
    const healthyTtl = extractNumericConst(digestSrc, 'CACHE_TTL_HEALTHY_S');
    const emptyTtl = extractNumericConst(digestSrc, 'CACHE_TTL_EMPTY_S');
    const digestTtl = digestSrc.match(/cachedFetchJson<ListFeedDigestResponse>\(\s*digestCacheKey,\s*([0-9_]+)/s);

    assert.equal(
      healthyTtl,
      3600,
      'healthy feed TTL changed; update data-sources and methodology docs plus this disclosure guard together',
    );
    assert.equal(
      emptyTtl,
      300,
      'empty or failed feed TTL changed; update data-sources and methodology docs plus this disclosure guard together',
    );
    assert.equal(
      Number(digestTtl?.[1]?.replace(/_/g, '')),
      900,
      'digest cache TTL changed; update docs/data-sources.mdx and this disclosure guard together',
    );

    for (const text of [docText, dataSourcesText]) {
      assert.ok(text.includes(`${healthyTtl} seconds`), 'docs must mention healthy feed TTL');
      assert.ok(text.includes(`${emptyTtl} seconds`), 'docs must mention empty or failed feed TTL');
    }
    assert.ok(dataSourcesText.includes('900-second TTL'), 'data sources page must mention digest TTL');
    assert.doesNotMatch(
      dataSourcesText,
      /cached\s+600s\s+per URL|per URL for 600 seconds/i,
      'data sources page must not retain stale 600s per-feed TTL wording',
    );
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

  it('documents keyword-classifier lifestyle exclusions and substring behavior', () => {
    const exclusions = extractArrayLiteralValues(classifierSrc, 'EXCLUSIONS');
    const expectedExclusions = [
      'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
      'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
      'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
      'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
    ];
    assert.deepEqual(
      [...exclusions].sort(),
      [...expectedExclusions].sort(),
      'EXCLUSIONS array values must match docs (order-insensitive)',
    );
    assert.ok(
      classifierSrc.includes('EXCLUSIONS.some(ex => lower.includes(ex))'),
      'classifier exclusions must remain substring checks unless docs are updated',
    );
    for (const exclusion of exclusions) {
      assertDocIncludes(`\`${exclusion}\``, `classifier exclusion ${exclusion}`);
      assert.ok(
        aiIntelligenceText.includes(`\`${exclusion}\``),
        `ai-intelligence docs must disclose classifier exclusion ${exclusion}`,
      );
    }
    assertDocMatches(/substring matches[\s\S]*word-boundary keyword matches/, 'classifier exclusion substring behavior');
    assert.ok(
      aiIntelligenceText.includes('lower-case substring checks'),
      'ai-intelligence docs must document exclusion substring behavior',
    );
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

  it('documents diplomacy severity promotion scope', () => {
    const promotionBody = extractFunctionBody(digestSrc, 'promoteDiplomacySeverity');
    assert.ok(
      /if\s*\(\s*level\s*===\s*'critical'\s*\|\|\s*level\s*===\s*'high'\s*\)\s*return\s+level\s*;/.test(promotionBody),
      'diplomacy promotion should only skip critical/high levels',
    );
    assertDocMatches(
      /Any non-`critical`, non-`high` item, including `info`, can[\s\S]*promoted to `high`/,
      'diplomacy promotion from any non-critical/non-high level',
    );
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
    const expectedFields = extractStoryTrackWriterFields(digestSrc);
    assert.deepEqual(extractDocStoryTrackHashFields(docText), expectedFields);
    for (const field of expectedFields) {
      assert.ok(cacheKeysSrc.includes(field), `cache-key contract comment must mention ${field}`);
      assertDocIncludes(`\`${field}\``, `story-track field ${field}`);
    }
    const hashSummary = cacheKeysSrc.match(/^\/\/ Hash:[^\n]*(?:\n\/\/       [^\n]*)*/m)?.[0] ?? '';
    const alwaysWrittenSummary = cacheKeysSrc.match(/story:track:v1:\$\{titleHash\}.*\(always-written\)/)?.[0] ?? '';
    assert.ok(hashSummary.length > 0, 'failed to locate cache-key hash summary comment');
    assert.ok(alwaysWrittenSummary.length > 0, 'failed to locate cache-key always-written summary comment');
    for (const reservedField of ['sourceCount', 'peakScore']) {
      assert.ok(
        !hashSummary.includes(reservedField) && !alwaysWrittenSummary.includes(reservedField),
        `cache-key contract comment must not list ${reservedField} as an always-written hash field`,
      );
      assertDocMatches(
        new RegExp('`' + reservedField + '`[\\s\\S]*(?:not stored|reserved|placeholder|live .*? (?:Set|ZSet))'),
        `story-track ${reservedField} caveat`,
      );
    }
    assertDocMatches(/`story:sources:v1:\{titleHash\}`[\s\S]*?`SADD`/, 'story sources set write path');
    assertDocIncludes('`SCARD`', 'story source-count set cardinality');
    assertDocIncludes('`story:peak:v1:{titleHash}` ZSet', 'story peak score ZSet');
    assertDocIncludes('`story:track:v1:{titleHash}`', 'story track key');
    assertDocIncludes('7 days', 'story tracking TTL');
    assertDocIncludes('48 hours', 'digest accumulator TTL');
  });

  it('documents reserved feed fading phase and digest read-path fading behavior', () => {
    assert.ok(
      digestSrc.includes('branch is intentionally') &&
        digestSrc.includes("return 'STORY_PHASE_FADING'"),
      'feed digest fading branch must remain explicitly guarded/inactive unless docs are updated',
    );
    assertDocMatches(
      /`fading`[\s\S]*Reserved for score-history support[\s\S]*zero placeholders[\s\S]*inert/,
      'reserved feed fading phase',
    );
    assertDocMatches(
      /notification cron[\s\S]*more than 24 hours of silence[\s\S]*`fading`/,
      'digest read-path fading phase',
    );
  });

  it('documents regional weekly brief provider chain separately from digest prose', () => {
    const providerNames = [...weeklyBriefSrc.matchAll(/name:\s*'([^']+)'/g)]
      .map((m) => m[1]);
    const providerModels = [...weeklyBriefSrc.matchAll(/model:\s*'([^']+)'/g)]
      .map((m) => m[1]);
    const weeklyTemperature = extractNumericConst(weeklyBriefSrc, 'BRIEF_TEMPERATURE');

    assert.deepEqual(providerNames, ['groq', 'openrouter']);
    assert.deepEqual(providerModels, ['llama-3.3-70b-versatile', 'google/gemini-2.5-flash']);
    assert.equal(weeklyTemperature, 0.3);

    assertDocMatches(
      /Regional weekly briefs[\s\S]*tr(?:y|ies) Groq first[\s\S]*`llama-3\.3-70b-versatile`[\s\S]*OpenRouter `google\/gemini-2\.5-flash`[\s\S]*temperature\s+`0\.3`/,
      'regional weekly brief provider order, models, and temperature',
    );
    assertDocMatches(
      /intentionally differ[\s\S]*digest prose and `whyMatters` surfaces/,
      'regional weekly brief chain differs from digest prose and whyMatters',
    );
    assertDocMatches(
      /provider chain to OpenRouter by skipping Ollama and Groq[\s\S]*`google\/gemini-2\.5-flash`/,
      'digest prose and whyMatters OpenRouter-only posture',
    );
  });

  it('documents dedup fallback and followed-country personalization knobs', () => {
    const jaccardThreshold = extractNumericConst(briefDedupConstsSrc, 'JACCARD_MERGE_THRESHOLD');
    assert.equal(jaccardThreshold, 0.55);
    assert.ok(
      briefDedupJaccardSrc.includes(`> ${jaccardThreshold}`),
      'Jaccard fallback implementation must still merge above the documented threshold',
    );
    assertDocIncludes(`\`${jaccardThreshold.toFixed(2)}\``, 'Jaccard fallback threshold');
    assertDocIncludes('DIGEST_DEDUP_CLUSTERING', 'dedup clustering env knob');

    assert.ok(
      /return\s+1\.25\s*;/.test(extractFunctionBody(briefComposeSrc, 'readFollowedBiasMultiplier')),
      'FOLLOWED_BIAS_MULTIPLIER default must remain 1.25 unless docs are updated',
    );
    for (const text of [docText, latestBriefPanelText]) {
      assert.ok(text.includes('FOLLOWED_BIAS_MULTIPLIER'), 'brief docs must name followed bias env knob');
      assert.ok(text.includes('`1.25`'), 'brief docs must document followed bias default');
      assert.ok(text.includes('same severity lane'), 'brief docs must document within-lane behavior');
      assert.ok(text.includes('`3`'), 'brief docs must document free-tier followed-country cap');
    }
  });

  it('documents brief Redis slot keys and supported digest cadences', () => {
    const latestBriefApiHeader = latestBriefApiSrc.match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
    assert.ok(
      seedDigestSrc.includes('const key = `brief:${userId}:${issueSlot}`') &&
        seedDigestSrc.includes('const latestPointerKey = `brief:latest:${userId}`'),
      'digest cron must still write slot-keyed brief envelope and latest pointer',
    );
    assert.ok(
      latestBriefApiSrc.includes('issueDate: preview.issueDate') &&
        latestBriefApiSrc.includes('issueSlot,') &&
        latestBriefApiSrc.includes("issueDate: requestedSlot.slice(0, 10)"),
      'latest-brief API must still expose issueDate plus issueSlot where a slot is known',
    );
    assert.match(
      latestBriefApiHeader,
      /\{ status: 'ready', issueDate, issueSlot, dateLong, greeting,\s*\*\s+threadCount, magazineUrl \}/,
      'latest-brief header must document the ready response shape including status and issueSlot',
    );
    assert.match(
      latestBriefApiHeader,
      /\{ status: 'composing', issueDate, issueSlot\? \}/,
      'latest-brief header must document the composing response shape including issueDate and optional issueSlot',
    );
    assert.match(
      latestBriefApiHeader,
      /current\/requested slot/,
      'latest-brief header must describe the current/requested slot rather than a strictly daily brief',
    );
    assert.doesNotMatch(
      latestBriefApiHeader,
      /\{ issueDate, dateLong, greeting, threadCount, magazineUrl \}|\{ status: 'composing' \}|today's brief/,
      'latest-brief header must not retain stale response-shape or daily-only wording',
    );
    assert.ok(
      briefShareUrlApiSrc.includes('brief:latest:{userId}') &&
        briefShareUrlApiSrc.includes('{userId, issueSlot, BRIEF_SHARE_SECRET}') &&
        briefShareUrlApiSrc.includes('return jsonResponse({ shareUrl, hash, issueSlot }, 200, cors);'),
      'share-url API docs must stay slot-keyed and expose issueSlot',
    );
    assert.ok(
      apiBriefText.includes('`issueDate` remains the display/date field') &&
        /`issueSlot` is the\s+frozen edition key/.test(apiBriefText) &&
        apiBriefText.includes('{ status: "ready", issueDate, issueSlot'),
      'api brief docs must distinguish issueDate from issueSlot response fields',
    );
    assert.ok(
      sharedBriefEnvelopeText.includes('brief:{userId}:{issueSlot}') &&
        sharedBriefEnvelopeText.includes('frozen edition id'),
      'shared brief-envelope boundary must document the slot-keyed Redis envelope',
    );
    assert.ok(
      briefShareUrlSrc.includes('/api/brief/{userId}/{issueSlot}') &&
        briefShareUrlSrc.includes('HMAC over (userId, issueSlot)') &&
        briefShareUrlSrc.includes('brief:{userId}:{issueSlot}'),
      'brief share-url helper comments must describe slot-keyed public sharing',
    );
    assert.ok(
      briefUrlSrc.includes('/api/brief/{userId}/{issueSlot}') &&
        briefUrlSrc.includes('sign `${userId}:${issueSlot}`') &&
        briefUrlSrc.includes('token against userId + issueSlot') &&
        briefUrlSrc.includes('issueDate` is the legacy property name') &&
        briefUrlSrc.includes('Legacy name for the frozen issueSlot'),
      'brief URL signer comments must describe slot-keyed magazine tokens',
    );
    assert.ok(
      scriptBriefUrlSignSrc.includes('sign `${userId}:${issueSlot}`') &&
        scriptBriefUrlSignSrc.includes('issueSlot-shaped value') &&
        scriptBriefUrlSignSrc.includes('issueDate is the legacy property name'),
      'cron brief URL signer comments must describe slot-keyed magazine tokens',
    );
    assert.ok(
      publicBriefApiSrc.includes('/api/brief/{userId}/{issueSlot}') &&
        briefRenderSrc.includes('userId, issueSlot') &&
        apiRouteExceptionsText.includes('user + frozen issue slot'),
      'brief route comments and route exceptions must describe the path segment as issueSlot',
    );
    for (const text of [apiBriefText, latestBriefPanelText]) {
      assert.ok(text.includes('`brief:{userId}:{issueSlot}`'), 'brief docs must document slot-keyed envelope');
      assert.ok(text.includes('`brief:latest:{userId}`'), 'brief docs must document latest pointer');
      assert.ok(text.includes('twice-daily') || text.includes('twice_daily'), 'brief docs must mention twice-daily cadence');
      assert.ok(text.includes('weekly'), 'brief docs must mention weekly cadence');
      assert.doesNotMatch(
        text,
        /brief:\{userId\}:\{issueDate\}/,
        'brief docs must not retain stale issueDate key shape',
      );
    }
    for (const [label, text] of Object.entries({
      sharedBriefEnvelopeText,
      briefShareUrlSrc,
      briefUrlSrc,
      briefRenderSrc,
      scriptBriefUrlSignSrc,
      seedDigestSrc,
      signedBriefApiSrc,
      publicBriefApiSrc,
      apiRouteExceptionsText,
    })) {
      assert.doesNotMatch(
        text,
        /brief:\{userId\}:\{issueDate\}/,
        `${label} must not retain stale issueDate Redis key shape`,
      );
    }
    for (const [label, text] of Object.entries({ briefShareUrlSrc, briefUrlSrc, scriptBriefUrlSignSrc })) {
      assert.doesNotMatch(
        text,
        /HMAC over \(userId, issueDate\)|userId \+ issueDate|\/api\/brief\/\{userId\}\/\{issueDate\}/,
        `${label} must not describe brief URLs or hashes as issueDate-bound`,
      );
    }
    assert.doesNotMatch(
      latestBriefPanelText,
      /strictly daily|once per eligible user per day/,
      'latest brief panel docs must not claim a strictly daily-only product',
    );
  });

  it('documents breaking-news banner gates on public alert docs', () => {
    const importanceFloor = extractNumericConst(breakingAlertsSrc, 'IMPORTANCE_SCORE_MIN');
    assert.equal(importanceFloor, 30);
    assert.ok(
      breakingAlertsSrc.includes('const STARTUP_GRACE_MS = 10 * 1000;'),
      'startup grace must remain 10 seconds unless docs are updated',
    );
    assert.ok(
      breakingAlertsSrc.includes("if (phase === 'sustained' || phase === 'fading') continue;"),
      'breaking banner must still suppress sustained/fading story phases',
    );
    for (const text of [aiIntelligenceText, algorithmsText]) {
      assert.ok(text.includes('importanceScore < 30'), 'alert docs must document importance score floor');
      assert.ok(text.includes('sustained and fading'), 'alert docs must document story-phase suppression');
      assert.ok(text.includes('10 seconds'), 'alert docs must document startup grace');
      assert.ok(text.includes('OREF siren alerts are exempt'), 'alert docs must document OREF exemption');
    }
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
