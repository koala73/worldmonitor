import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const insightsPanelSrc = readFileSync(
  path.join(repoRoot, 'src/components/InsightsPanel.ts'),
  'utf8',
);

it('keeps structured world-brief delimiters as escaped newline literals', () => {
  assert.match(
    insightsPanelSrc,
    /brief\.split\(\/\\n\(\?=SITUATION OVERVIEW\|KEY DEVELOPMENTS\|THREAT ASSESSMENT\|WATCH NEXT\)\/\)/,
    'world-brief parser should split sections on an escaped newline regex, not a broken literal line break',
  );
  assert.match(
    insightsPanelSrc,
    /\.split\('\\n'\)/,
    'world-brief developments should split on escaped newline strings, not raw line breaks in source',
  );
  assert.match(
    insightsPanelSrc,
    /const level = levelMatch\?\.\[1\]\?\.toUpperCase\(\) \?\? '';/,
    'world-brief threat parsing should handle regex captures without tripping strict undefined checks',
  );
});
