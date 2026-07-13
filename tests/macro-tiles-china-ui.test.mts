import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(new URL('../src/components/MacroTilesPanel.ts', import.meta.url), 'utf8');

describe('MacroTilesPanel China launch surface', () => {
  it('keeps China behind the explicit launch-ready gate and hydrates both seed keys', () => {
    assert.match(source, /type Tab = 'us' \| 'eu' \| 'cn'/);
    assert.match(source, /getHydratedData\('chinaMacro'\)/);
    assert.match(source, /getHydratedData\('chinaReleaseCalendar'\)/);
    assert.match(source, /launchReady === true/);
    assert.match(source, /client\.getChinaMacroSnapshot\(\{\}\)/);
    assert.match(source, /calendarRecord\.events\.map\(normalizeChinaReleaseEvent\)/);
  });

  it('renders permanently attributed mixed-state China tiles', () => {
    assert.match(source, /indicator\.source/);
    assert.match(source, /indicator\.observationDate/);
    assert.match(source, /indicator\.stale/);
    assert.match(source, /indicator\.unavailableReason/);
    assert.match(source, /China release calendar/);
    assert.match(source, /const available = indicator\.hasValue && Number\.isFinite\(indicator\.value\)/);
    assert.match(source, /const state = indicator\.stale \? 'STALE'/);
  });

  it('uses an accessible keyboard-operable tablist with narrow-screen tiles', () => {
    assert.match(source, /role="tablist"/);
    assert.match(source, /role="tab"/);
    assert.match(source, /aria-selected=/);
    assert.match(source, /aria-controls=/);
    assert.match(source, /ArrowRight/);
    assert.match(source, /ArrowLeft/);
    assert.match(source, /Home/);
    assert.match(source, /End/);
    assert.match(source, /this\._render\(\(\) =>/);
    assert.match(source, /setSafeContent\([\s\S]*afterUpdate/);
    assert.match(source, /repeat\(auto-fit,minmax\(130px,1fr\)\)/);
  });
});
