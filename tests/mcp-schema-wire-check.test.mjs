import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { collectToolSchemaWireFailures } from '../scripts/mcp-schema-wire-check.mjs';

describe('collectToolSchemaWireFailures', () => {
  it('accepts valid type strings and union arrays at arbitrary depth', () => {
    let outputSchema = { type: ['number', 'null'] };
    for (let depth = 0; depth < 32; depth += 1) outputSchema = { type: 'array', items: outputSchema };

    assert.deepEqual(collectToolSchemaWireFailures([{
      name: 'deep_tool',
      inputSchema: { type: 'object' },
      outputSchema,
    }]), []);
  });

  it('reports every invalid type keyword with its tool and JSON path', () => {
    const failures = collectToolSchemaWireFailures([{
      name: 'broken_tool',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: {
          value: { type: ['number', '[truncated]'] },
          year: { type: 7 },
        },
      },
    }]);

    assert.equal(failures.length, 2);
    assert.ok(failures.every((failure) => failure.includes('broken_tool.outputSchema')));
    assert.ok(failures.some((failure) => failure.includes('properties.value.type')));
    assert.ok(failures.some((failure) => failure.includes('properties.year.type')));
  });

  it('reports truncation sentinels outside type keywords and missing schemas', () => {
    const failures = collectToolSchemaWireFailures([
      { name: 'truncated_tool', inputSchema: { type: 'object' }, outputSchema: { items: '[truncated]' } },
      { name: 'missing_tool', inputSchema: { type: 'object' } },
      { name: 'empty_tool', inputSchema: {}, outputSchema: { type: 'object' } },
    ]);

    assert.ok(failures.some((failure) => failure.includes('truncated_tool.outputSchema.items')));
    assert.ok(failures.some((failure) => failure.includes('missing_tool.outputSchema')));
    assert.ok(failures.some((failure) => failure.includes('empty_tool.inputSchema')));
  });

  it('reports empty and duplicate type arrays', () => {
    const failures = collectToolSchemaWireFailures([{
      name: 'bad_unions',
      inputSchema: { type: [] },
      outputSchema: {
        type: 'object',
        properties: { value: { type: ['string', 'string'] } },
      },
    }]);

    assert.ok(failures.some((failure) => failure.includes('type array must not be empty')));
    assert.ok(failures.some((failure) => failure.includes('duplicate JSON Schema type')));
  });
});
