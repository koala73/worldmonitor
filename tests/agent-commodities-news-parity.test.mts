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

  it('keeps the MCP full-digest category enum aligned with VARIANT_FEEDS.full keys', () => {
    const nlpSrc = readFileSync(join(ROOT, 'api/mcp/registry/nlp-tools.ts'), 'utf8');
    const match = nlpSrc.match(
      /const FULL_DIGEST_CATEGORIES = \[([\s\S]*?)\] as const;/,
    );
    assert.ok(match, 'FULL_DIGEST_CATEGORIES must be declared in nlp-tools.ts');
    const enumKeys = [...match[1].matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]).sort();
    const feedKeys = [
      ...Object.keys(VARIANT_FEEDS.full ?? {}),
      ...(INTEL_SOURCES.length > 0 ? ['intel'] : []),
    ].sort();
    assert.deepEqual(
      enumKeys,
      feedKeys,
      'FULL_DIGEST_CATEGORIES must list every category emitted by the full digest (and no extras)',
    );
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
    }
  });
});
