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
  let inBacktick = false;
  for (let i = 1; i < line.length - 1; i += 1) {
    const ch = line[i];
    if (ch === '`') inBacktick = !inBacktick;
    if (ch === '|' && !inBacktick && line[i - 1] !== '\\') {
      cells.push(current.trim().replace(/\\\|/g, '|'));
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim().replace(/\\\|/g, '|'));
  return cells;
}

function unwrapInlineCode(value) {
  return value.replace(/^`([^`]+)`$/, '$1');
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
      name: unwrapInlineCode(nameCell),
      type: unwrapInlineCode(type),
      description,
    });
  }
  return rows;
}

function documentedCacheToolNames() {
  const sections = DOC.split(/(?=\n### `)/);
  return sections.flatMap((section) => {
    const heading = section.match(/^### `([^`]+)`/m);
    if (!heading || !section.includes('**Parameters (tool-specific):**')) return [];
    // The reference also documents selected RPC tools with dedicated query
    // budgets. This parity suite intentionally owns cache-tool tables only,
    // because cache tools gain the universal `summary` parameter while RPC
    // tools do not. Ignore the documented RPC sections here rather than
    // making their presence look like a stale cache-tool entry.
    const tool = __testing__.TOOL_REGISTRY.find((entry) => entry.name === heading[1]);
    // Preserve the bidirectional check: a stale heading must remain visible to
    // the assertion below instead of being silently mistaken for an RPC tool.
    if (!tool) return [heading[1]];
    return tool._execute === undefined ? [heading[1]] : [];
  });
}

/**
 * Every registry tool must have its own `### `<name>`` section in the public
 * reference. The cache-tool parity check below is deliberately scoped to cache
 * tools, so before this guard an RPC tool could ship with no reference section
 * at all and nothing failed -- which is how `get_resilience_indicators` reached
 * production undocumented.
 */
function documentedToolSectionNames() {
  return new Set(
    [...DOC.matchAll(/^### `([a-z0-9_]+)`/gm)].map((match) => match[1]),
  );
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

  it('documents every registry tool, RPC tools included', () => {
    const documented = documentedToolSectionNames();
    const undocumented = __testing__.TOOL_REGISTRY
      .map((tool) => tool.name)
      .filter((name) => !documented.has(name))
      .sort();
    assert.deepEqual(
      undocumented,
      [],
      'every TOOL_REGISTRY tool needs a section in docs/mcp-tools-reference.mdx',
    );
  });

  it('cache tool-specific parameter tables match registry inputSchema properties', () => {
    const cacheTools = __testing__.TOOL_REGISTRY.filter((tool) => tool._execute === undefined);
    assert.deepEqual(
      documentedCacheToolNames().sort(),
      cacheTools.map((tool) => tool.name).sort(),
      'docs/mcp-tools-reference.mdx cache-tool sections must be bidirectional with TOOL_REGISTRY',
    );

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

  // The page uses get_country_risk's outputSchema as THE worked example for
  // the whole outputSchema feature, and hand-maintains a matching TypeScript
  // type sketch below it. Both silently drifted through the schema fix that
  // renamed every field, because the checks above only cover cache tools'
  // INPUT parameter tables. A reader copying either block got field names
  // that do not exist on the wire — the same defect the schema fix removed,
  // still shipping from the docs.
  const WORKED_EXAMPLE_TOOL = 'get_country_risk';

  // First fenced ```json block after the worked-example heading. Anchor on
  // the untranslated code spans rather than the prose, so the zh mirror —
  // whose lead-in is translated — resolves with the same locator.
  function workedExampleSchema(doc) {
    const heading = doc.search(
      new RegExp(`\`outputSchema\`[^\\n]*\`${WORKED_EXAMPLE_TOOL}\`|\`${WORKED_EXAMPLE_TOOL}\`[^\\n]*\`outputSchema\``),
    );
    assert.notEqual(heading, -1, `worked-example heading for ${WORKED_EXAMPLE_TOOL} not found`);
    const open = doc.indexOf('```json', heading);
    assert.notEqual(open, -1, 'no json block after the worked-example heading');
    const start = doc.indexOf('\n', open) + 1;
    const end = doc.indexOf('```', start);
    assert.notEqual(end, -1, 'unterminated json block after the worked-example heading');
    return JSON.parse(doc.slice(start, end));
  }

  for (const [label, path] of [['en', '../docs/mcp-tools-reference.mdx'], ['zh', '../docs/zh/mcp-tools-reference.mdx']]) {
    it(`${label} worked-example outputSchema matches the live ${WORKED_EXAMPLE_TOOL} schema`, () => {
      const doc = readFileSync(new URL(path, import.meta.url), 'utf8');
      const tool = __testing__.TOOL_REGISTRY.find((t) => t.name === WORKED_EXAMPLE_TOOL);
      assert.ok(tool, `${WORKED_EXAMPLE_TOOL} not found in TOOL_REGISTRY`);

      assert.deepEqual(
        Object.keys(workedExampleSchema(doc).properties ?? {}).sort(),
        Object.keys(tool.outputSchema.properties).sort(),
        `docs (${label}) worked example advertises different top-level fields than the live outputSchema`,
      );

      // The TS sketch restates the same field names; keep it honest too.
      const tsStart = doc.indexOf('type CountryRisk = {');
      assert.notEqual(tsStart, -1, `${label} docs must keep the CountryRisk type sketch`);
      // `\n};` is the type's own closing brace at column 0 — a bare `};`
      // would stop at the nested `cii` object and hide every field after it.
      const sketch = doc.slice(tsStart, doc.indexOf('\n};', tsStart));
      for (const field of Object.keys(tool.outputSchema.properties)) {
        assert.ok(sketch.includes(field), `${label} CountryRisk type sketch is missing ${field}`);
      }
      for (const stale of ['country_code', 'travelAdvisory', 'sanctionsExposure']) {
        assert.ok(!sketch.includes(stale), `${label} CountryRisk type sketch still advertises removed field ${stale}`);
      }
      assert.match(
        doc,
        /parsed\.cii\?\.combinedScore/,
        `${label} CountryRisk example must read the headline score from cii.combinedScore`,
      );
      assert.match(
        doc,
        /parsed\.cii\?\.components\?\.geoConvergence/,
        `${label} CountryRisk example must read component values from cii.components`,
      );
      assert.doesNotMatch(
        doc,
        /parsed\.components\.conflict/,
        `${label} CountryRisk example must not use the removed top-level components.conflict path`,
      );
    });
  }
});
