// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

describe('Marketplace deployment template', () => {
  it('rejects product lists that the EventBridge rule and worker would interpret differently', () => {
    const template = parseDocument(readFileSync(new URL('../../workers/aws-marketplace/template.yaml', import.meta.url), 'utf8'));
    const pattern = template.getIn(['Parameters', 'ProductCodes', 'AllowedPattern']);
    expect(typeof pattern).toBe('string');
    const allowed = new RegExp(pattern as string);
    expect(allowed.test('product-1,product/2')).toBe(true);
    for (const value of ['product-1, product-2', ' product-1', 'product-1 ', 'product-1,,product-2', '']) {
      expect(allowed.test(value), value).toBe(false);
    }
  });
});
