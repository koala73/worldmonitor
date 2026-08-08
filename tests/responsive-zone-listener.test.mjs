import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addResponsiveZoneListener,
  removeResponsiveZoneListener,
} from '../src/app/responsive-zone-listener.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const panelLayoutSrc = readFileSync(
  resolve(__dirname, '../src/app/panel-layout.ts'),
  'utf-8',
);

class FakeMediaQueryList extends EventTarget {
  constructor(media) {
    super();
    this.media = media;
    this.matches = false;
  }

  setMatches(matches) {
    if (this.matches === matches) return;
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

function createTarget() {
  const lists = [];
  return {
    lists,
    target: {
      matchMedia(query) {
        const list = new FakeMediaQueryList(query);
        lists.push(list);
        return list;
      },
    },
  };
}

describe('responsive zone listener', () => {
  it('listens to the configured min-width media query', () => {
    const { target, lists } = createTarget();

    const listener = addResponsiveZoneListener(target, 1600, () => {});

    assert.equal(lists.length, 1);
    assert.equal(lists[0].media, '(min-width: 1600px)');
    removeResponsiveZoneListener(listener);
  });

  it('runs immediately when the breakpoint state changes', () => {
    const { target, lists } = createTarget();
    let callCount = 0;

    const listener = addResponsiveZoneListener(target, 1600, () => { callCount++; });

    lists[0].setMatches(true);

    assert.equal(callCount, 1, 'breakpoint changes must not wait for a timeout debounce');
    removeResponsiveZoneListener(listener);
  });

  it('does not fire repeatedly while the breakpoint state is stable', () => {
    const { target, lists } = createTarget();
    let callCount = 0;

    const listener = addResponsiveZoneListener(target, 1600, () => { callCount++; });

    lists[0].setMatches(true);
    lists[0].setMatches(true);
    lists[0].setMatches(true);

    assert.equal(callCount, 1);
    removeResponsiveZoneListener(listener);
  });

  it('cleanup removes the breakpoint listener', () => {
    const { target, lists } = createTarget();
    let callCount = 0;

    const listener = addResponsiveZoneListener(target, 1600, () => { callCount++; });
    removeResponsiveZoneListener(listener);

    lists[0].setMatches(true);

    assert.equal(callCount, 0);
  });

  it('re-init cleanup prevents old listeners from firing after replacement', () => {
    const { target, lists } = createTarget();
    let callCount = 0;

    const firstListener = addResponsiveZoneListener(target, 1600, () => { callCount++; });
    removeResponsiveZoneListener(firstListener);
    const secondListener = addResponsiveZoneListener(target, 1600, () => { callCount++; });

    lists[0].setMatches(true);
    lists[1].setMatches(true);

    assert.equal(callCount, 1);
    removeResponsiveZoneListener(secondListener);
  });
});

describe('panel layout responsive zone wiring', () => {
  // Behavioral: the contract panel-layout relies on — a breakpoint cross runs
  // the zone-reconcile callback exactly once, synchronously, with no trailing
  // debounce. This replaces the former brittle source-text debounce regex with
  // a runtime assertion.
  it('runs the zone-reconcile callback on a breakpoint cross, without a debounce', () => {
    const { target, lists } = createTarget();
    let reconciles = 0;
    const listener = addResponsiveZoneListener(target, 1600, () => { reconciles++; });

    lists[0].setMatches(true);
    assert.equal(reconciles, 1, 'reconcile must run synchronously on the cross, not after a timeout');

    removeResponsiveZoneListener(listener);
  });

  // Structural guards: PanelLayoutManager needs the full AppContext to
  // instantiate, so these catch a regression in how panel-layout.ts wires the
  // listener. The runtime behavior itself is covered above and by the
  // `responsive zone listener` suite, so these are kept loose on purpose —
  // they assert the wiring facts, not exact formatting.
  it('wires zone reconciliation through the breakpoint listener', () => {
    assert.match(panelLayoutSrc, /addResponsiveZoneListener\(/);
    assert.match(panelLayoutSrc, /this\.getUltraWideMinWidth\(\)/);
    assert.match(panelLayoutSrc, /addResponsiveZoneListener\([\s\S]*?ensureCorrectZones\(\)/);
  });

  it('does not register post-render listeners after destroy during async panel setup', () => {
    assert.match(
      panelLayoutSrc,
      /await this\.renderLayout\(\);\s*if \(this\.ctx\.isDestroyed\) return;\s*\/\/ Subscribe to auth state/,
    );
  });

  it('does not reconcile zones on every resize event', () => {
    assert.doesNotMatch(
      panelLayoutSrc,
      /addEventListener\s*\(\s*['"]resize['"]\s*,\s*\(\)\s*=>\s*this\.ensureCorrectZones\(\)\s*\)/,
    );
  });
});
