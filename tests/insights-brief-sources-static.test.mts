import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/components/InsightsPanel.ts', import.meta.url), 'utf8');

describe('InsightsPanel server brief sources', () => {
  it('does not fabricate legacy world brief citations from topStories[0]', () => {
    // #4928: the cap is now the payload's own citation index space
    // (bounded 6..12) instead of a flat 6 — the invariant this test
    // guards is unchanged: sources come ONLY from explicit
    // worldBriefSources, never fabricated from topStories.
    assert.match(
      source,
      /collectBriefSources\(\s*insights\.worldBriefSources \?\? \[\],\s*Math\.min\(12, Math\.max\(6, insights\.worldBriefSources\?\.length \?\? 6\)\),\s*\)/,
      'server-rendered world briefs should cite only explicit worldBriefSources',
    );
    assert.doesNotMatch(
      source,
      /worldBriefSources[\s\S]{0,400}topStories\.slice\(0,\s*1\)/,
      'legacy source-free server briefs must not borrow topStories[0] as a citation',
    );
  });
});
