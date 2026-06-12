import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/components/InsightsPanel.ts', import.meta.url), 'utf8');

describe('InsightsPanel server brief sources', () => {
  it('does not fabricate legacy world brief citations from topStories[0]', () => {
    assert.match(
      source,
      /collectBriefSources\(\s*insights\.worldBriefSources \?\? \[\],\s*6,\s*\)/,
      'server-rendered world briefs should cite only explicit worldBriefSources',
    );
    assert.doesNotMatch(
      source,
      /worldBriefSources[\s\S]{0,400}topStories\.slice\(0,\s*1\)/,
      'legacy source-free server briefs must not borrow topStories[0] as a citation',
    );
  });
});
