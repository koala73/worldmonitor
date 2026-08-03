import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  TOOL_LIST_RESPONSE,
  TOOL_REGISTRY,
} from '../api/mcp/registry/index.ts';

const EXPECTED_CATEGORIES = ['geopolitical', 'tech', 'finance'];
const TOOL_NAME = 'get_prediction_markets';

const englishReference = readFileSync(
  new URL('../docs/mcp-tools-reference.mdx', import.meta.url),
  'utf8',
);
const chineseReference = readFileSync(
  new URL('../docs/zh/mcp-tools-reference.mdx', import.meta.url),
  'utf8',
);
const englishOverview = readFileSync(
  new URL('../docs/mcp-overview.mdx', import.meta.url),
  'utf8',
);
const chineseOverview = readFileSync(
  new URL('../docs/zh/mcp-overview.mdx', import.meta.url),
  'utf8',
);
const serverCard = JSON.parse(readFileSync(
  new URL('../public/.well-known/mcp/server-card.json', import.meta.url),
  'utf8',
));

function sectionForTool(markdown, toolName) {
  const heading = `### \`${toolName}\``;
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const next = markdown.indexOf('\n### `', start + heading.length);
  return markdown.slice(start, next === -1 ? markdown.length : next);
}

function overviewRow(markdown) {
  const row = markdown
    .split('\n')
    .find((line) => line.includes(`| \`${TOOL_NAME}\` |`));
  assert.ok(row, `missing overview row for ${TOOL_NAME}`);
  return row;
}

function assertEnglishCategoryMeaning(text, label) {
  for (const category of EXPECTED_CATEGORIES) {
    assert.match(text, new RegExp(`\\b${category}\\b`, 'i'), `${label} omits ${category}`);
  }
  assert.match(
    text,
    /geopolitical[^.]*election/i,
    `${label} does not associate geopolitical with elections`,
  );
  assert.match(
    text,
    /tech[^.]*\bAI\b[^.]*crypto[^.]*science/i,
    `${label} does not associate tech with AI, crypto, and science`,
  );
  assert.match(
    text,
    /finance[^.]*econom(?:ic|ics)[^.]*fallback/i,
    `${label} does not associate finance/economics with the fallback`,
  );
}

function assertNoGeopoliticalDefault(text, label) {
  assert.doesNotMatch(
    text,
    /(?:default|omit|omission)[^.]{0,60}geopolitical|geopolitical[^.]{0,60}(?:default|omit|omission)/i,
    `${label} must not describe geopolitical as the omission/default bucket`,
  );
}

describe('get_prediction_markets agent-facing category contract', () => {
  const tool = TOOL_REGISTRY.find((entry) => entry.name === TOOL_NAME);

  it('uses the registered tool object to expose the exact enum and meaningful categories', () => {
    assert.ok(tool, `${TOOL_NAME} must be registered`);
    assert.deepEqual(tool.inputSchema.properties.category.enum, EXPECTED_CATEGORIES);
    assertEnglishCategoryMeaning(tool.description, 'registry description');
    assert.match(tool.description, /Kalshi currently supplies no classifier tags/i);
    assert.match(tool.description, /source=kalshi[^.]*category=tech[^.]*returns no records/i);
    assert.match(tool.description, /fall back to finance/i);
    assert.doesNotMatch(
      tool.description,
      /Polymarket/i,
      'the registry description must not imply the multi-venue payload is Polymarket-only',
    );
    assert.match(
      tool.inputSchema.properties.category.description,
      /Omit for all three/i,
      'the category schema must preserve omission as all pools',
    );
    assert.match(
      tool.inputSchema.properties.category.description,
      /Finance also owns untagged non-geopolitical records/i,
      'the category schema must expose the finance fallback',
    );
    assert.match(
      tool.inputSchema.properties.source.description,
      /Kalshi[^.]*no classifier tags[^.]*source=kalshi[^.]*category=tech[^.]*returns no records/i,
      'the source schema must expose the Kalshi tech limitation',
    );
    assertNoGeopoliticalDefault(tool.description, 'registry description');

    const data = {
      'markets-bootstrap': {
        geopolitical: [{ title: 'geopolitical fixture' }],
        tech: [{ title: 'tech fixture' }],
        finance: [{ title: 'finance fixture' }],
      },
    };
    const filtered = tool._postFilter(structuredClone(data), {});
    for (const category of EXPECTED_CATEGORIES) {
      assert.equal(
        filtered['markets-bootstrap'][category].length,
        1,
        `omitting category must preserve the ${category} pool`,
      );
    }
  });

  it('keeps every category discoverable in the actual compressed tools/list description', () => {
    const publicTool = TOOL_LIST_RESPONSE.find((entry) => entry.name === TOOL_NAME);
    assert.ok(publicTool, `${TOOL_NAME} must be published by tools/list`);
    assert.ok(
      Buffer.byteLength(publicTool.description, 'utf8') <= 120,
      'tools/list description must stay within the registry compression budget',
    );
    assertEnglishCategoryMeaning(publicTool.description, 'tools/list description');
    assert.match(publicTool.description, /untagged fallback/i);
    assertNoGeopoliticalDefault(publicTool.description, 'tools/list description');
    assert.match(
      publicTool.inputSchema.properties.source.description,
      /Kalshi[^.]*source=kalshi[^.]*category=tech[^.]*returns no records/i,
      'tools/list source metadata must expose the Kalshi tech limitation',
    );
  });

  it('keeps generated public server-card metadata equal to the canonical registry', () => {
    const cardTool = serverCard.tools.find((entry) => entry.name === TOOL_NAME);
    assert.ok(cardTool, `${TOOL_NAME} must be published in the server card`);
    assert.equal(cardTool.description, tool.description);
  });

  it('keeps the detailed English reference equal to the canonical description', () => {
    const section = sectionForTool(englishReference, TOOL_NAME);
    assert.ok(
      section.includes(tool.description),
      'English reference description must equal the canonical registry description',
    );
    assertEnglishCategoryMeaning(section, 'English reference');
    assert.match(section, /Omit for all three/i);
    assert.match(section, /source=kalshi[^.]*category=tech[^.]*returns no records/i);
    assert.match(section, /fall back to finance/i);
    assertNoGeopoliticalDefault(section, 'English reference');
  });

  it('keeps the detailed Chinese reference translated and semantically synchronized', () => {
    const section = sectionForTool(chineseReference, TOOL_NAME);
    for (const category of EXPECTED_CATEGORIES) {
      assert.match(section, new RegExp(`\`${category}\``), `Chinese reference omits ${category}`);
    }
    for (const term of [
      '预测市场',
      '地缘政治',
      '选举',
      '科技',
      '人工智能',
      '加密货币',
      '科学',
      '金融',
      '经济',
      '分类器标签',
      '未分类',
      '回退',
      'Kalshi',
    ]) {
      assert.ok(section.includes(term), `Chinese reference omits ${term}`);
    }
    assert.doesNotMatch(section, /Active prediction markets:/);
    assert.match(section, /省略则返回全部三类/);
    assert.match(section, /`source=kalshi` 与 `category=tech` 组合不会返回记录/);
  });

  it('keeps both overview rows concise without contradicting the detailed contract', () => {
    const englishRow = overviewRow(englishOverview);
    assertEnglishCategoryMeaning(englishRow, 'English overview');
    assert.match(englishRow, /untagged fallback/i);
    assertNoGeopoliticalDefault(englishRow, 'English overview');
    assert.doesNotMatch(englishRow, /Polymarket/i);

    const chineseRow = overviewRow(chineseOverview);
    for (const category of EXPECTED_CATEGORIES) {
      assert.match(chineseRow, new RegExp(`\`${category}\``), `Chinese overview omits ${category}`);
    }
    for (const term of ['地缘政治', '选举', '人工智能', '加密货币', '科学', '金融', '经济', '未分类', '回退']) {
      assert.ok(chineseRow.includes(term), `Chinese overview omits ${term}`);
    }
    assert.doesNotMatch(chineseRow, /Polymarket/i);
  });
});
