import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  GUIDE_PATH,
  renderMcpDiscoveryDocuments,
  SERVER_CARD_PATH,
  SETUP_PATH,
  serverCardWithoutTools,
} from '../scripts/generate-mcp-discovery-documents.mjs';
import * as generated from '../api/mcp/discovery-documents.generated.ts';
import { serverCardTools } from '../api/mcp/server-card-tools.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the embedded MCP discovery documents match the files under public/', () => {
  const stale = 'is stale; run node scripts/generate-mcp-discovery-documents.mjs';
  assert.equal(generated.MCP_GUIDE_MARKDOWN, read(GUIDE_PATH), `MCP_GUIDE_MARKDOWN ${stale}`);
  assert.equal(generated.MCP_SETUP_HTML, read(SETUP_PATH), `MCP_SETUP_HTML ${stale}`);
  assert.equal(generated.MCP_SERVER_CARD_WITHOUT_TOOLS_JSON, serverCardWithoutTools(read(SERVER_CARD_PATH)),
    `MCP_SERVER_CARD_WITHOUT_TOOLS_JSON ${stale}`);
});

test('the registry projection reproduces the published card tools list', () => {
  assert.deepEqual(serverCardTools(), JSON.parse(read(SERVER_CARD_PATH)).tools);
});

test('a registry tool without a category does not break the served card', () => {
  // The deploy build does not run the product-facts generator that rejects
  // this mismatch, so the runtime projection must not throw on it.
  const tools = serverCardTools(
    [{ name: 'uncategorised_tool', description: 'd', _freeTier: true }],
    {},
  );
  assert.deepEqual(JSON.parse(JSON.stringify(tools)), [
    { name: 'uncategorised_tool', description: 'd', _meta: { 'worldmonitor/access': 'free' } },
  ]);
});

test('the card skeleton keeps the tools key in place and empties it', () => {
  const skeleton = JSON.parse(serverCardWithoutTools('{"name":"a","tools":[{"name":"t"}],"tags":["x"]}'));
  assert.deepEqual(Object.keys(skeleton), ['name', 'tools', 'tags']);
  assert.deepEqual(skeleton.tools, []);
  assert.throws(() => serverCardWithoutTools('{"name":"a"}'), /must carry a tools array/);
});

test('the renderer escapes each document into a string literal that round-trips', () => {
  const sources = {
    [SERVER_CARD_PATH]: '{"name":"`${x}`","tools":[]}',
    [GUIDE_PATH]: 'line\u2028sep */ </script>',
    [SETUP_PATH]: '<title>"quoted" \\ back</title>',
  };
  const rendered = renderMcpDiscoveryDocuments((path) => sources[path]);
  const exportedValue = (name) => {
    const line = rendered.split('\n').find((candidate) => candidate.startsWith(`export const ${name} = `));
    return JSON.parse(line.slice(`export const ${name} = `.length, -1));
  };
  assert.equal(exportedValue('MCP_SERVER_CARD_WITHOUT_TOOLS_JSON'), sources[SERVER_CARD_PATH]);
  assert.equal(exportedValue('MCP_GUIDE_MARKDOWN'), sources[GUIDE_PATH]);
  assert.equal(exportedValue('MCP_SETUP_HTML'), sources[SETUP_PATH]);
});
