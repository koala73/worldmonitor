import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// No jsdom in the suite, so lock U4a structurally: DeductionPanel must yield to
// the main thread between the awaited marked.parse and the synchronous
// DOMPurify.sanitize, so the post-response paint isn't blocked by the sanitize
// long task (#4537). Re-checks isConnected after the new async gap.
const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/components/DeductionPanel.ts'),
  'utf8',
);

test('DeductionPanel imports the shared yield primitive (R5)', () => {
  assert.match(src, /import \{ yieldToMain \} from '@\/utils\/after-paint'/);
});

test('DeductionPanel yields before the synchronous DOMPurify.sanitize (R5)', () => {
  const parseIdx = src.indexOf('await marked.parse(resp.analysis)');
  const yieldIdx = src.indexOf('await yieldToMain()', parseIdx);
  const sanitizeIdx = src.indexOf('DOMPurify.sanitize(parsed)', parseIdx);
  assert.ok(parseIdx >= 0, 'marked.parse present');
  assert.ok(yieldIdx > parseIdx, 'yieldToMain present after parse');
  assert.ok(sanitizeIdx > yieldIdx, 'sanitize runs after the yield');
});

test('DeductionPanel re-checks isConnected after the new yield gap (R5)', () => {
  const yieldIdx = src.indexOf('await yieldToMain()');
  const between = src.slice(yieldIdx, src.indexOf('DOMPurify.sanitize(parsed)', yieldIdx));
  assert.match(between, /isConnected/, 'guard re-checked after the async yield');
});
