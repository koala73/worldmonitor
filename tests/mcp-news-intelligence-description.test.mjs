import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { CACHE_TOOLS } from '../api/mcp/registry/cache-tools.ts';

const tool = CACHE_TOOLS.find(entry => entry.name === 'get_news_intelligence');
const serverCard = JSON.parse(
  readFileSync(new URL('../public/.well-known/mcp/server-card.json', import.meta.url), 'utf8'),
);

describe('get_news_intelligence credibility discovery (#6597)', () => {
  it('advertises credibilityScore in the canonical tool description', () => {
    assert.ok(tool, 'get_news_intelligence must stay registered');
    assert.match(tool.description, /credibilityScore/);
    assert.match(tool.description, /source reliability/i);
  });

  it('keeps the public server card equal to the canonical description', () => {
    const cardTool = serverCard.tools.find(entry => entry.name === 'get_news_intelligence');
    assert.ok(cardTool, 'get_news_intelligence must stay published in the server card');
    assert.equal(cardTool.description, tool.description);
  });
});
