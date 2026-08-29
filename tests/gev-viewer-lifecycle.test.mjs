/**
 * God's Eye View mount/unmount contract.
 *
 * Upstream never unmounted its viewer — it was a page, not a component — so
 * `createGevViewer`'s teardown is entirely fork code, and the first version
 * of it was quietly broken in a way no type checker or unit test could see:
 *
 *   styleManager?.destroy?.()   // StyleManager's method is `dispose()`
 *   voiceCommands?.destroy?.()  // the controller's method is `stop()`
 *   annotations?.destroy?.()    // the engine's method is `clear()`
 *
 * Optional chaining turns a wrong method name into a silent no-op. Three of
 * five collaborators were never torn down: the world overlay kept a
 * MutationObserver firing against a destroyed scene, its two canvases stayed
 * in the DOM, and the render governor kept a module-level reference to the
 * dead viewer — which killed the NEXT mount, so the globe could be opened
 * exactly once per page load.
 *
 * These tests tie each call site to the method it is supposed to be calling.
 * A re-vendor that renames one of them fails here instead of silently
 * reintroducing the leak. `scripts/qa-render-audit.mjs` proves the runtime
 * behaviour; this proves the wiring, and runs in milliseconds.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

const mainSrc = read('src/gev/src/main.js');
const uiSrc = read('src/gev/src/ui.js');
const hudSrc = read('src/gev/src/hud.js');
const voiceSrc = read('src/gev/src/voice/gevRealtime.js');
const governorSrc = read('src/gev/src/renderGovernor.js');
const managerSrc = read('src/gev/src/data/manager.js');

/** The body of createGevViewer's `destroy()`. */
const destroyBody = (() => {
  const start = mainSrc.indexOf('async destroy() {');
  assert.ok(start > 0, 'createGevViewer must expose an async destroy()');
  return mainSrc.slice(start, mainSrc.indexOf('\n      },', start));
})();

describe('teardown calls a method that exists', () => {
  const cases = [
    ['StyleManager', /styleManager\?\.dispose\?\.\(\)/, uiSrc, /^\s{2}async dispose\(\)/m],
    ['IntelHUD', /styleManager\?\.hud\?\.destroy\?\.\(\)/, hudSrc, /^\s{2}destroy\(\)/m],
    ['voice controller', /voiceCommands\?\.stop\?\.\(/, voiceSrc, /^\s{2}stop\(options/m],
    ['DataLayerManager', /dataManager\.destroyAll\?\.\(\)/, managerSrc, /^\s{2}async destroyAll\(\)/m],
  ];

  for (const [label, callSite, moduleSrc, declaration] of cases) {
    it(`${label} teardown is wired to a real method`, () => {
      assert.match(destroyBody, callSite, `destroy() must call ${label}'s teardown`);
      assert.match(moduleSrc, declaration,
        `${label} no longer declares the method destroy() calls — the call is now a silent no-op`);
    });
  }

  it('does not call a `destroy` that these collaborators never had', () => {
    // The exact three that were wrong. Named individually so a failure says
    // which one came back rather than "something matched a regex".
    assert.doesNotMatch(destroyBody, /styleManager\?\.destroy\?\.\(\)/);
    assert.doesNotMatch(destroyBody, /voiceCommands\?\.destroy\?\.\(\)/);
    assert.doesNotMatch(destroyBody, /annotations\?\.destroy\?\.\(\)/);
  });
});

describe('module singletons are released', () => {
  it('the render governor is uninstalled', () => {
    // Without this the singleton keeps the destroyed viewer, and the next
    // mount throws inside initDetection before installing its own.
    assert.match(governorSrc, /export function uninstallRenderGovernor\(\)/);
    assert.match(destroyBody, /uninstallRenderGovernor\(\)/);
  });

  it('the test-only reset delegates rather than duplicating the reset', () => {
    const seam = governorSrc.slice(governorSrc.indexOf('_resetRenderGovernorForTest'));
    assert.match(seam.slice(0, 200), /uninstallRenderGovernor\(\)/,
      'two copies of the reset will drift; the test seam must call the real one');
  });

  it("StyleManager's dispose is what releases the world overlay", () => {
    // The overlay's canvases and MutationObserver are torn down here and
    // nowhere else, which is why dispose() cannot be skipped.
    assert.match(uiSrc, /destroyWorldOverlay\(\);/);
  });
});

describe('teardown ordering', () => {
  it('StyleManager.dispose is awaited before the viewer is destroyed', () => {
    // dispose() reaches destroyWorldOverlay() only after an internal await,
    // so firing it without awaiting lets viewer.destroy() win the race and
    // the overlay then tears down against a dead scene.
    const disposeAt = destroyBody.indexOf('styleManager?.dispose?.()');
    const viewerAt = destroyBody.indexOf('viewer.destroy()');
    assert.ok(disposeAt > 0 && viewerAt > 0, 'both teardown steps must be present');
    assert.ok(disposeAt < viewerAt, 'dispose() must run before viewer.destroy()');
    assert.match(destroyBody, /await styleManager\?\.dispose\?\.\(\)/,
      'dispose() is async and must be awaited');
  });

  it('the render governor is released after the viewer is gone', () => {
    const viewerAt = destroyBody.indexOf('viewer.destroy()');
    const governorAt = destroyBody.indexOf('uninstallRenderGovernor()');
    assert.ok(governorAt > viewerAt,
      'releasing the governor first would leave the teardown below it unable to request a frame');
  });
});

describe('the embedding options upstream does not have', () => {
  for (const [option, why] of [
    ['firstRun', 'World Monitor owns onboarding'],
    ['initialCamera', "MapContainer's view is the opening shot"],
    ['exposeGlobal', 'a second instance would clobber window.__godsEyeView'],
  ]) {
    it(`${option} is opt-out and defaults to upstream's behaviour (${why})`, () => {
      assert.match(mainSrc, new RegExp(`${option} = true`),
        `${option} must default true so a standalone run is unchanged`);
    });
  }
});
