/**
 * Source-text lock for #7779: optional local-AI init must not gate dashboard
 * startup.
 *
 * App.init() is a DOM/bootstrap module that can't be imported under
 * `tsx --test`, so — per the repo's established pattern (see
 * tests/business-invite-wiring.test.mts) — this locks the integration with
 * source-text assertions plus a behavioral delayed-readiness test on the
 * ml-worker side (the blocking `await mlWorker.init()` used to sit ahead of
 * layout/panels; now boot continues while the worker settles detached).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('optional local-AI init stays off the dashboard critical path (#7779)', () => {
  it('does not block early boot on mlWorker.init()', async () => {
    const src = await read('src/App.ts');
    // The only `await mlWorker.init()` lives inside the detached boot
    // continuation (`void (async () => { ... })()`); boot itself proceeds to
    // layout/panels first. A bare `await mlWorker.init();` statement at
    // boot-module statement level or directly in init()'s pre-layout section
    // would reintroduce the gate.
    assert.match(
      src,
      /void \(async \(\) => \{\s*\n\s*try \{\s*\n\s*const ready = await mlWorker\.init\(\);/,
      'optional local-AI init must run inside a detached continuation',
    );
    assert.doesNotMatch(
      src,
      /\n    await mlWorker\.init\(\);/,
      'boot must never await mlWorker.init() at the init() statement level',
    );
  });

  it('starts optional local AI detached and guards the continuation on epoch, lifetime and current settings', async () => {
    const src = await read('src/App.ts');
    assert.match(
      src,
      /const ready = await mlWorker\.init\(\);/,
      'the detached boot continuation must still use the manager readiness promise',
    );
    assert.match(
      src,
      /if \(this\.localAiInitEpoch !== localAiEpoch \|\| this\.state\.isDestroyed\) return;/,
      'a late boot continuation must bail for a stale epoch or destroyed app',
    );
    assert.match(
      src,
      /if \(!getAiFlowSettings\(\)\.browserModel && !isDesktopRuntime\(\)\) return;/,
      'a late boot continuation must recheck the browser-model/desktop authority',
    );
  });

  it('keeps the browser-model and headline-memory parent/authority gates on every detached path', async () => {
    const src = await read('src/App.ts');
    assert.match(
      src,
      /mlWorker\.whenReady\('app-boot:headline-memory'\)/,
      'headline-memory boot must join the shared init, not spawn its own',
    );
    // Settings enable-paths use init(), NOT whenReady(): cold-boot with the
    // toggle off leaves the manager disabled, and whenReady() on a disabled
    // manager resolves false without starting anything (#7796 review P1).
    const settingsSection = src.slice(src.indexOf('this.unsubAiFlow = subscribeAiFlowChange'));
    assert.match(
      settingsSection,
      /void mlWorker\.init\(\)\.then\(\(ready\) => \{/,
      'settings enable-paths must START the worker via init()',
    );
    assert.doesNotMatch(
      settingsSection,
      /whenReady\('app-settings:/,
      'settings enable-paths must not use whenReady(), which cannot start a disabled worker',
    );
    assert.match(
      src,
      /if \(!isHeadlineMemoryEnabled\(\)\) return;/,
      'detached headline-memory continuations must recheck the parent gate',
    );
  });

  it('invalidates detached continuations on destroy so they cannot revive a dead app', async () => {
    const src = await read('src/App.ts');
    const destroyIndex = src.indexOf('public destroy(): void {');
    assert.notEqual(destroyIndex, -1, 'could not locate App.destroy');
    const epochBump = src.indexOf('this.localAiInitEpoch += 1;', destroyIndex);
    assert.ok(
      epochBump !== -1 && epochBump - destroyIndex < 600,
      'destroy() must invalidate detached local-AI continuations before teardown',
    );
  });

  it('snapshots clustering availability per news generation instead of reloading on ready', async () => {
    const src = await read('src/app/data-loader.ts');
    assert.match(
      src,
      /Snapshot local-ML availability AT this generation's clustering choice/,
      'loadNews must snapshot mlWorker.isAvailable per generation, never reload on worker-ready',
    );
    assert.doesNotMatch(
      src,
      /whenReady|addEventListener\(['"]ml|onWorkerReady/,
      'data-loader must not subscribe to worker readiness — readiness alone never regroups committed results',
    );
  });
});
