import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { INTEL_SOURCES, VARIANT_FEEDS } from '../server/worldmonitor/news/v1/_feeds.ts';
import { NEWS_POOL_LAYOUT } from '../shared/news-pool-layout.generated.ts';

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

  it('gives MCP tools every category each digest edition emits', () => {
    // nlp-tools.ts builds its category enum from this generated layout.
    for (const [edition, categories] of Object.entries(NEWS_POOL_LAYOUT.editions)) {
      const feedKeys = [
        ...Object.keys(VARIANT_FEEDS[edition] ?? {}),
        ...(edition === 'full' && INTEL_SOURCES.length > 0 ? ['intel'] : []),
      ].sort();
      assert.deepEqual([...categories].sort(), feedKeys, `${edition} categories must match its digest (and no extras)`);
    }
    const nlpSrc = readFileSync(join(ROOT, 'api/mcp/registry/nlp-tools.ts'), 'utf8');
    assert.match(nlpSrc, /const ALL_DIGEST_CATEGORIES = \[\.\.\.new Set\(Object\.values\(NEWS_POOL_LAYOUT\.editions\)/);
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
