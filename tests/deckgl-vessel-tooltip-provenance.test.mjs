import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const deckGLMapSrc = readFileSync(join(root, 'src', 'components', 'DeckGLMap.ts'), 'utf-8');

describe('DeckGLMap military vessel tooltip provenance', () => {
  const start = deckGLMapSrc.indexOf("case 'military-vessels-layer':");
  const end = deckGLMapSrc.indexOf("case 'military-flights-layer':", start);
  const tooltipBlock = start >= 0 && end > start ? deckGLMapSrc.slice(start, end) : '';

  it('labels USNI-only vessel positions as estimated/approximate', () => {
    assert.ok(tooltipBlock, 'military-vessels-layer tooltip block must exist');
    assert.match(tooltipBlock, /obj\.usniSource/, 'tooltip must branch on USNI source provenance');
    assert.match(
      tooltipBlock,
      /popups\.militaryVessel\.estPosition/,
      'tooltip must show the same estimated-position label as the popup',
    );
    assert.match(
      tooltipBlock,
      /popups\.militaryVessel\.approximatePosition/,
      'tooltip must explain USNI positions are approximate and not real-time AIS',
    );
  });
});
