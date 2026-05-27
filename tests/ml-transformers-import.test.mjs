import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { env, pipeline } from '@huggingface/transformers';

describe('@huggingface/transformers import shape', () => {
  it('exposes the worker APIs used by ml.worker.ts', () => {
    assert.equal(typeof pipeline, 'function');
    assert.equal(typeof env, 'object');
    assert.ok(env);
  });
});
