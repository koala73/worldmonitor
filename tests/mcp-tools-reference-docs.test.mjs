import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__, buildPublicTool } from '../api/mcp.ts';

const DOC = readFileSync(new URL('../docs/mcp-tools-reference.mdx', import.meta.url), 'utf8');
const UNIVERSAL_ARGS = new Set(['summary', 'jmespath']);

function typeText(schema) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const primary = types.filter(Boolean).join(' / ') || 'unknown';
  const items = schema.items;
  if (primary === 'array' && items && typeof items === 'object') {
    const itemType = Array.isArray(items.type) ? items.type.join(' / ') : (items.type || 'unknown');
    const enums = Array.isArray(items.enum) ? ': ' + items.enum.join(' / ') : '';
    return `array<${itemType}${enums}>`;
  }
  if (Array.isArray(schema.enum)) return `${primary}: ${schema.enum.join(' / ')}`;
  return primary;
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = '';
  for (let i = 1; i < line.length - 1; i += 1) {
    const ch = line[i];
    if (ch === '|' && line[i - 1] !== '\\') {
      cells.push(current.trim().replace(/\\\|/g, '|'));
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim().replace(/\\\|/g, '|'));
  return cells;
}

function sectionForTool(toolName) {
  const heading = `### \`${toolName}\``;
  const start = DOC.indexOf(heading);
  assert.notEqual(start, -1, `docs/mcp-tools-reference.mdx missing heading for ${toolName}`);
  const next = DOC.indexOf('\n### `', start + heading.length);
  return DOC.slice(start, next === -1 ? DOC.length : next);
}

function documentedToolSpecificParams(toolName) {
  const section = sectionForTool(toolName);
  const marker = '**Parameters (tool-specific):**';
  const markerAt = section.indexOf(marker);
  assert.notEqual(markerAt, -1, `${toolName}: missing tool-specific parameter marker`);
  const afterMarker = section.slice(markerAt + marker.length);
  if (afterMarker.trimStart().startsWith('none')) return [];

  const tableStart = afterMarker.indexOf('| Name | Type | Description |');
  assert.notEqual(tableStart, -1, `${toolName}: missing parameter table`);
  const table = afterMarker.slice(tableStart).split('\n');
  const rows = [];
  for (const line of table.slice(2)) {
    if (!line.startsWith('|')) break;
    const [nameCell, type, description] = splitMarkdownRow(line);
    rows.push({
      name: nameCell.replace(/^`|`$/g, ''),
      type,
      description,
    });
  }
  return rows;
}

function expectedToolSpecificParams(tool) {
  const publicTool = buildPublicTool(tool, { compressDescriptions: false });
  return Object.entries(publicTool.inputSchema.properties)
    .filter(([name]) => !UNIVERSAL_ARGS.has(name))
    .map(([name, schema]) => ({
      name,
      type: typeText(schema),
      description: schema.description,
    }));
}

describe('MCP tools reference docs — cache tool parameter parity', () => {
  it('documents universal injected MCP arguments once', () => {
    assert.match(DOC, /Universal arguments:/);
    assert.match(DOC, /Every tool accepts `jmespath`/);
    assert.match(DOC, /Every cache tool also accepts `summary`/);
  });

  it('cache tool-specific parameter tables match registry inputSchema properties', () => {
    const cacheTools = __testing__.TOOL_REGISTRY.filter((tool) => tool._execute === undefined);
    assert.ok(cacheTools.length >= 27, `expected at least 27 cache tools, got ${cacheTools.length}`);

    const failures = [];
    for (const tool of cacheTools) {
      try {
        assert.deepEqual(
          documentedToolSpecificParams(tool.name),
          expectedToolSpecificParams(tool),
        );
      } catch (err) {
        failures.push(`${tool.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    assert.deepEqual(failures, [], `MCP tools reference cache parameter drift:\n${failures.join('\n\n')}`);
  });
});
