import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jmespath from 'jmespath';

const root = resolve(import.meta.dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function readText(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function section(doc, heading) {
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `missing section heading: ${heading}`);
  const next = doc.indexOf('\n### ', start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
}

function codeBlock(example, label) {
  const match = example.match(new RegExp(`\\*\\*${label}:\\*\\*[^\\n]*\\n\\n\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``));
  assert.ok(match, `missing ${label} JSON code block`);
  return JSON.parse(match[1]);
}

function docJmespath(example) {
  const toolCall = codeBlock(example, 'Tool call');
  const expr = toolCall.arguments?.jmespath;
  assert.equal(typeof expr, 'string', 'tool call must include a JMESPath expression');
  return expr;
}

function projectedResponse(example) {
  return codeBlock(example, 'Projected response');
}

describe('docs/mcp-jmespath.mdx fixture-backed examples', () => {
  const doc = readText('docs/mcp-jmespath.mdx');
  const fixturesByTool = new Map([
    ['get_market_data', readJson('tests/fixtures/jmespath-samples/fat-get-market-data.response.json')],
    ['get_conflict_events', readJson('tests/fixtures/jmespath-samples/medium-get-conflict-events.response.json')],
    ['get_chokepoint_status', readJson('tests/fixtures/jmespath-samples/thin-get-chokepoint-status.response.json')],
  ]);

  function codeBlocks(text) {
    return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  }

  function projectedJsonBlock(example) {
    const marker = '**Projected response';
    const projectedStart = example.indexOf(marker);
    assert.notEqual(projectedStart, -1, 'missing projected response marker');
    const match = /```json\n([\s\S]*?)\n```/.exec(example.slice(projectedStart));
    assert.ok(match, 'missing projected response JSON block');
    return JSON.parse(match[1]);
  }

  function assertExampleMatchesFixture(number, heading) {
    const example = section(doc, `### ${number}. ${heading}`);
    const [toolCallBlock] = codeBlocks(example);
    assert.ok(toolCallBlock, `example ${number} must have a tool-call JSON block`);
    const toolCall = JSON.parse(toolCallBlock);
    const fixture = fixturesByTool.get(toolCall.name);
    assert.ok(fixture, `example ${number} uses unknown fixture tool ${toolCall.name}`);
    const expression = toolCall.arguments?.jmespath;
    assert.equal(typeof expression, 'string', `example ${number} must define arguments.jmespath`);
    const actual = jmespath.search(fixture, expression);
    const expected = projectedJsonBlock(example);
    assert.deepEqual(actual, expected, `example ${number} projected response must match fixture`);
  }

  it('every fixture-backed example with JSON projected output is executable', () => {
    const cases = [
      [1, 'Drill into a single nested object'],
      [2, 'Slim each item to a few fields (multiselect-hash)'],
      [4, 'Filter on string equality'],
      [5, 'Array projection — flat list of one field'],
      [7, '`length()` for counting'],
      [8, '`sort_by` + reverse + slice — Top-N'],
      [9, 'Filter on enum-string field'],
      [10, 'Object-as-map navigation'],
      [11, 'Object-as-map projection — `*` and `keys()`'],
      [12, 'Pipe combinator — multi-stage projection'],
    ];

    for (const [number, heading] of cases) {
      assertExampleMatchesFixture(number, heading);
    }
  });

  it('example 7 count matches the default-capped conflict-events fixture', () => {
    const fixture = readJson('tests/fixtures/jmespath-samples/medium-get-conflict-events.response.json');
    const count = fixture.data['ucdp-events'].events.length;
    const example = section(doc, '### 7. `length()` for counting');

    assert.equal(count, 30, 'fixture should represent the no-limit default cap');
    assert.match(example, /```json\n30\n```/, 'example 7 projected response must match fixture count');
    assert.match(example, /default cap is applied before JMESPath/, 'example 7 must disclose the pre-projection default cap');
  });

  for (const [number, title] of [
    [8, '`sort_by` + reverse + slice — Top-N'],
    [9, 'Filter on enum-string field'],
    [12, 'Pipe combinator — multi-stage projection'],
  ]) {
    it(`example ${number} projected response matches the conflict-events fixture`, () => {
      const fixture = readJson('tests/fixtures/jmespath-samples/medium-get-conflict-events.response.json');
      const example = section(doc, `### ${number}. ${title}`);
      const actual = jmespath.search(fixture, docJmespath(example));

      assert.deepEqual(actual, projectedResponse(example));
    });
  }

  it('example 11 critical chokepoint counts match the thin chokepoint fixture', () => {
    const fixture = readJson('tests/fixtures/jmespath-samples/thin-get-chokepoint-status.response.json');
    const summaries = fixture.data['transit-summaries'].summaries;
    const counts = Object.values(summaries)
      .filter((row) => row.riskLevel === 'critical')
      .map((row) => row.incidentCount7d)
      .sort((a, b) => a - b);
    const example = section(doc, '### 11. Object-as-map projection');

    assert.deepEqual(counts, [28, 33, 274, 627, 735]);
    for (const count of counts) {
      assert.match(example, new RegExp(`"count": ${count}\\b`), `example 11 must include critical count ${count}`);
    }
  });
});
