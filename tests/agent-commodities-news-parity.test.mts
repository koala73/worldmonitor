import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { INTEL_SOURCES, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('commodities news agent parity (#5889)', () => {
  it('exposes the finance dashboard commodities bucket in the full digest used by agents', () => {
    const financeCommodities = VARIANT_FEEDS.finance?.commodities;
    const agentCommodities = VARIANT_FEEDS.full?.commodities;

    assert.ok(financeCommodities?.length, 'finance dashboard commodities feeds must exist');
    assert.ok(agentCommodities?.length, 'full agent digest must expose a commodities category');
    assert.deepEqual(
      agentCommodities,
      financeCommodities,
      'agents and the finance dashboard must read the same commodities headline sources',
    );
  });

  it('keeps the MCP category enums aligned with each agent-addressable digest variant', () => {
    const nlpSrc = readFileSync(join(ROOT, 'api/mcp/registry/nlp-tools.ts'), 'utf8');
    const expectations = [
      {
        constant: 'FULL_DIGEST_CATEGORIES',
        feedKeys: [
          ...Object.keys(VARIANT_FEEDS.full ?? {}),
          ...(INTEL_SOURCES.length > 0 ? ['intel'] : []),
        ].sort(),
      },
      {
        constant: 'TECH_DIGEST_CATEGORIES',
        feedKeys: Object.keys(VARIANT_FEEDS.tech ?? {}).sort(),
      },
    ];

    for (const { constant, feedKeys } of expectations) {
      const match = nlpSrc.match(
        new RegExp(`const ${constant} = \\[([\\s\\S]*?)\\] as const;`),
      );
      assert.ok(match, `${constant} must be declared in nlp-tools.ts`);
      const enumKeys = [...match[1].matchAll(/'([A-Za-z0-9_-]+)'/g)]
        .map((entry) => entry[1])
        .sort();
      assert.deepEqual(
        enumKeys,
        feedKeys,
        `${constant} must list every category emitted by its digest variant (and no extras)`,
      );
    }
  });

  it('keeps the published MCP server card discoverable for category filtering', () => {
    const card = JSON.parse(readFileSync(
      join(ROOT, 'public/.well-known/mcp/server-card.json'),
      'utf8',
    ));
    const tools = new Map((card.tools ?? []).map((tool) => [tool.name, tool.description]));
    for (const name of ['extract_entities', 'get_news_clusters']) {
      const description = tools.get(name) ?? '';
      assert.match(description, /category/,
        `${name} server-card description must advertise category filtering`);
      assert.match(description, /commodities/,
        `${name} server-card description must advertise commodities filtering`);
      assert.match(description, /variant/,
        `${name} server-card description must advertise variant selection`);
      assert.match(description, /tech/,
        `${name} server-card description must advertise Tech digest access`);
    }
  });
});
