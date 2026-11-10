// Agent-facing files must state the real free tier. Five of them used to say
// every MCP data tool except get_sources needs a paid plan, while the server
// card marks 37 tools `free-account`. The sentence is defined once in
// scripts/generate-public-product-facts.mjs, which also fails the derived
// check when a file drops it; this test pins the files and the server card.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const flat = (text) => text.replace(/\s+/g, ' ');

const generatorSource = read('scripts/generate-public-product-facts.mjs');
const sentence = generatorSource.match(/const FREE_TIER_SENTENCE =\s*"([^"]+)";/)?.[1];

const FILES = [
  'public/agents.md',
  'public/developers.md',
  'public/mcp-server.md',
  'public/api/llms.txt',
  'public/agent.txt',
  'public/agent-view.json',
  'public/llms.txt',
  'public/developers/llms.txt',
];

const STALE_CLAIM = /other than `get_sources` require|every other data call needs subscription/i;

describe('agent files state the free-account MCP tier', () => {
  it('defines the sentence in the generator', () => {
    assert.ok(sentence, 'FREE_TIER_SENTENCE must be a double-quoted literal in generate-public-product-facts.mjs');
    assert.match(sentence, /free-account/);
  });

  for (const path of FILES) {
    it(`${path} carries the sentence and not the old claim`, () => {
      const source = read(path);
      // JSON files escape nothing in this sentence, so a flat compare covers
      // markdown wrapping and the line-wrapped agent.txt.
      assert.ok(flat(source).includes(flat(sentence)), `${path} must contain the free-tier sentence`);
      assert.doesNotMatch(flat(source), STALE_CLAIM, `${path} still carries the old subscription-only claim`);
    });
  }

  it('keeps the sentence true: the server card has free-account tools', () => {
    const card = JSON.parse(read('public/.well-known/mcp/server-card.json'));
    const freeAccount = card.tools.filter((tool) => tool._meta?.['worldmonitor/access'] === 'free-account');
    assert.ok(freeAccount.length > 0, 'no tool is marked free-account, so the sentence would be false');
  });
});
