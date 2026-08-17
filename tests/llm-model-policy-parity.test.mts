import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  GROQ_DEFAULT_MODEL,
  OPENROUTER_FREE_BACKUP_MODEL,
  OPENROUTER_FREE_PRIMARY_MODEL,
  OPENROUTER_PROVIDER_ROUTING,
} from '../scripts/_llm-model-timeouts.mjs';

const require = createRequire(import.meta.url);
const cjsPolicy = require('../scripts/lib/llm-model-policy.cjs');

test('ESM timeout policy re-exports the canonical CJS model policy', () => {
  assert.equal(cjsPolicy.GROQ_DEFAULT_MODEL, GROQ_DEFAULT_MODEL);
  assert.equal(cjsPolicy.OPENROUTER_FREE_PRIMARY_MODEL, OPENROUTER_FREE_PRIMARY_MODEL);
  assert.equal(cjsPolicy.OPENROUTER_FREE_BACKUP_MODEL, OPENROUTER_FREE_BACKUP_MODEL);
  assert.deepEqual(cjsPolicy.OPENROUTER_PROVIDER_ROUTING, OPENROUTER_PROVIDER_ROUTING);
});
