import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangelog } from '../scripts/build-crawlable-corpus.mjs';

it('preserves visible Markdown autolinks in public changelog text', () => {
  const [release] = parseChangelog('## [1.0] - 2026-09-09\n- See <https://example.org/fix> or <help@example.org> with **details**.');
  assert.deepEqual(release.bullets, ['See https://example.org/fix or help@example.org with details.']);
});

it('retains continuation prose within the eight-bullet release limit', () => {
  const source = [
    '## [Unreleased]',
    ...Array.from({ length: 7 }, (_, index) => `- New announcement ${index + 1}.`),
    '- A complete announcement',
    '  keeps its continuation and `methodology_version` detail.',
    '- An older announcement beyond the public limit.',
  ].join('\n');
  const [release] = parseChangelog(source);
  assert.equal(release.bullets.length, 8);
  assert.equal(release.bullets.at(-1), 'A complete announcement keeps its continuation and methodology_version detail.');
  assert.ok(release.bullets.every((bullet) => !bullet.includes('older announcement')));
});
