import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  collectRequiredCapabilityFailures,
  collectToolSchemaWireFailures,
} from '../scripts/mcp-schema-wire-check.mjs';
import { TOOL_LIST_RESPONSE } from '../api/mcp/registry/index.ts';

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

  it('accepts schema properties named type without treating their names as keywords', () => {
    const tools = [{
      name: 'property_named_type',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          metadata: {
            type: 'object',
            examples: [{ type: 'domain-value' }],
          },
        },
      },
    }];

    assert.deepEqual(collectToolSchemaWireFailures(tools), []);
  });

  it('accepts the complete first-party tool catalog', () => {
    assert.deepEqual(collectToolSchemaWireFailures(TOOL_LIST_RESPONSE), []);
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

  it('reports truncation sentinels inside annotation data', () => {
    const failures = collectToolSchemaWireFailures([{
      name: 'truncated_annotation',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        examples: [{ type: '[truncated]' }],
      },
    }]);

    assert.ok(failures.some((failure) => failure.includes('examples[0].type')));
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

  it('reports schema defects outside type keywords', () => {
    const invalidSchemas = [
      { type: 'object', required: 'value', properties: { value: { type: 'string' } } },
      { type: 'array', minItems: -1, items: { type: 'string' } },
      { type: 'array', uniqueItems: 'yes', items: { type: 'string' } },
      { type: 'string', pattern: '[' },
      { type: 'string', enum: [] },
    ];

    for (const [index, outputSchema] of invalidSchemas.entries()) {
      const failures = collectToolSchemaWireFailures([{
        name: `invalid_schema_${index}`,
        inputSchema: { type: 'object' },
        outputSchema,
      }]);

      assert.ok(
        failures.some((failure) => failure.includes(`invalid_schema_${index}.outputSchema`)),
        `schema ${index} must fail strict compilation`,
      );
    }
  });
});

describe('collectRequiredCapabilityFailures', () => {
  it('requires the production tools capability', () => {
    assert.deepEqual(collectRequiredCapabilityFailures({ tools: {} }), []);
    assert.deepEqual(
      collectRequiredCapabilityFailures({ prompts: {} }),
      ['initialize.capabilities.tools: required capability is missing'],
    );
  });
});
