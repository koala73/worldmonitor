import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_STRING_MAX_BYTES,
  validateGeneratedRequest,
} from '../server/request-validator.ts';
import { GENERATED_MESSAGE_RULES } from '../src/generated/server/request_validation.ts';

// #8402: un-annotated (and max_bytes-less) proto strings must still reject
// payloads above a global UTF-8 ceiling so the platform body limit cannot
// become the only bound.

describe('request validator default string max_bytes (#8402)', () => {
  it('exports the 64 KiB global ceiling the pentest follow-up asked for', () => {
    assert.equal(DEFAULT_STRING_MAX_BYTES, 64 * 1024);
  });

  it('rejects an over-ceiling value on a field that only declares min_len', () => {
    const oversized = 'x'.repeat(DEFAULT_STRING_MAX_BYTES + 1);
    assert.deepEqual(validateGeneratedRequest('getFredSeries', { seriesId: oversized }), [
      {
        field: 'seriesId',
        description: `string UTF-8 length must be at most ${DEFAULT_STRING_MAX_BYTES} bytes`,
      },
    ]);
  });

  it('rejects an over-ceiling value on a previously unregistered request string', () => {
    const oversized = 'x'.repeat(DEFAULT_STRING_MAX_BYTES + 1);
    assert.deepEqual(validateGeneratedRequest('getBlsSeries', { seriesId: oversized }), [
      {
        field: 'seriesId',
        description: `string UTF-8 length must be at most ${DEFAULT_STRING_MAX_BYTES} bytes`,
      },
    ]);
  });

  it('still accepts a value exactly at the global ceiling', () => {
    const atCeiling = 'x'.repeat(DEFAULT_STRING_MAX_BYTES);
    assert.equal(validateGeneratedRequest('getFredSeries', { seriesId: atCeiling }), undefined);
  });

  it('keeps every generated string field bounded by an explicit or default max_bytes', () => {
    const rules = GENERATED_MESSAGE_RULES as Record<
      string,
      { fields: Record<string, { kind?: string; stringMaxBytes?: number; stringMaxLen?: number; stringLen?: number }> }
    >;
    let stringFields = 0;
    for (const [message, def] of Object.entries(rules)) {
      for (const [field, rule] of Object.entries(def.fields ?? {})) {
        if (rule.kind !== 'string') continue;
        stringFields += 1;
        assert.ok(
          rule.stringMaxBytes != null && rule.stringMaxBytes > 0,
          `${message}.${field} must carry stringMaxBytes (got ${rule.stringMaxBytes})`,
        );
        // Explicit proto bounds may be stricter or (rarely) larger than the
        // default; both are fine as long as every string is bounded.
        assert.ok(
          Number.isInteger(rule.stringMaxBytes),
          `${message}.${field} stringMaxBytes must be an integer`,
        );
      }
    }
    assert.ok(stringFields > 100, `expected a broad string registry, saw ${stringFields}`);
  });
});
