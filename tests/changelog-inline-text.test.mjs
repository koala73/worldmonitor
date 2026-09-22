import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog } from '../scripts/build-crawlable-corpus.mjs';

it('preserves visible Markdown autolinks in public changelog text', () => {
  const [release] = parseChangelog('## [1.0] - 2026-09-09\n- See <https://example.org/fix> or <help@example.org> with **details**.');
  assert.deepEqual(release.bullets, ['See https://example.org/fix or help@example.org with details.']);
});
