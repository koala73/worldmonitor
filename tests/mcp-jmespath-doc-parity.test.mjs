import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

describe('docs/mcp-jmespath.mdx fixture-backed examples', () => {
  const doc = readText('docs/mcp-jmespath.mdx');

  it('example 7 count matches the default-capped conflict-events fixture', () => {
    const fixture = readJson('tests/fixtures/jmespath-samples/medium-get-conflict-events.response.json');
    const count = fixture.data['ucdp-events'].events.length;
    const example = section(doc, '### 7. `length()` for counting');

    assert.equal(count, 30, 'fixture should represent the no-limit default cap');
    assert.match(example, /```json\n30\n```/, 'example 7 projected response must match fixture count');
    assert.match(example, /default cap is applied before JMESPath/, 'example 7 must disclose the pre-projection default cap');
  });

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
