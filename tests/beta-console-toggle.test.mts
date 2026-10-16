import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BETA_MODE_STORAGE_KEY,
  installBetaConsoleToggle,
  type BetaConsoleToggleDeps,
} from '../src/bootstrap/beta-console-toggle.ts';

interface BetaHost {
  beta: boolean;
}

interface FakeOverlay {
  rendered: boolean;
}

/** A document holding one blocking overlay while `overlay.rendered` is true. */
function documentWith(overlay?: FakeOverlay) {
  return {
    querySelectorAll: () => (overlay?.rendered ? [{
      checkVisibility: () => true,
      getAttribute: (name: string) => (name === 'role' ? 'dialog' : name === 'data-reload-policy' ? 'blocking' : null),
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
      id: 'sign-up',
      className: 'modal-overlay',
      tagName: 'DIV',
    }] : []),
  } as unknown as BetaConsoleToggleDeps['document'];
}

function harness(stored?: string, overlay?: FakeOverlay): {
  store: Map<string, string>;
  logs: string[];
  reloads: { count: number };
  target: BetaHost;
  deps: BetaConsoleToggleDeps;
} {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set(BETA_MODE_STORAGE_KEY, stored);
  const logs: string[] = [];
  const reloads = { count: 0 };
  const target = {} as BetaHost;
  const deps: BetaConsoleToggleDeps = {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => { store.set(key, value); },
    remove: (key) => { store.delete(key); },
    reload: () => { reloads.count += 1; },
    log: (message) => { logs.push(message); },
    document: documentWith(overlay),
  };
  return { store, logs, reloads, target, deps };
}

describe('installBetaConsoleToggle', () => {
  it('reading beta reports the stored flag', () => {
    const off = harness();
    installBetaConsoleToggle(off.target, off.deps);
    assert.equal(off.target.beta, false);
    assert.deepEqual(off.logs, ['[Beta] OFF']);

    const on = harness('true');
    installBetaConsoleToggle(on.target, on.deps);
    assert.equal(on.target.beta, true);
    assert.deepEqual(on.logs, ['[Beta] ON']);
  });

  it('beta=true persists the flag and reloads', () => {
    const h = harness();
    installBetaConsoleToggle(h.target, h.deps);
    h.target.beta = true;
    assert.equal(h.store.get(BETA_MODE_STORAGE_KEY), 'true');
    assert.equal(h.reloads.count, 1);
  });

  it('beta=false clears the flag and reloads', () => {
    const h = harness('true');
    installBetaConsoleToggle(h.target, h.deps);
    h.target.beta = false;
    assert.equal(h.store.get(BETA_MODE_STORAGE_KEY), undefined);
    assert.equal(h.reloads.count, 1);
  });

  it('saves the flag but does not reload over a blocking overlay', () => {
    const overlay = { rendered: true };
    const h = harness(undefined, overlay);
    installBetaConsoleToggle(h.target, h.deps);
    h.target.beta = true;
    assert.equal(h.store.get(BETA_MODE_STORAGE_KEY), 'true');
    assert.equal(h.reloads.count, 0, 'an open blocking overlay must not be reloaded away');
    assert.match(h.logs.at(-1) ?? '', /not reloading while .+ is open/);
    overlay.rendered = false;
    h.target.beta = false;
    assert.equal(h.store.get(BETA_MODE_STORAGE_KEY), undefined);
    assert.equal(h.reloads.count, 1, 'once the overlay closes the toggle reloads again');
  });

  it('reloads when there is no document to protect', () => {
    const h = harness();
    installBetaConsoleToggle(h.target, { ...h.deps, document: null });
    h.target.beta = true;
    assert.equal(h.reloads.count, 1);
  });

  it('a second install keeps the first accessor', () => {
    const first = harness();
    installBetaConsoleToggle(first.target, first.deps);
    const second = harness('true');
    installBetaConsoleToggle(first.target, second.deps);
    assert.equal(first.target.beta, false);
    assert.deepEqual(first.logs, ['[Beta] OFF']);
    assert.equal(second.reloads.count, 0);
  });

  it('leaves a pre-existing beta property in place', () => {
    const target = {};
    Object.defineProperty(target, 'beta', {
      value: 1,
      writable: false,
      configurable: false,
    });
    const h = harness('true');
    installBetaConsoleToggle(target, h.deps);
    assert.equal((target as { beta: number }).beta, 1);
    assert.deepEqual(h.logs, []);
    assert.equal(h.reloads.count, 0);
  });

  it('does not add beta when the host rejects new properties', () => {
    const sealed = Object.preventExtensions({});
    const h = harness();
    installBetaConsoleToggle(sealed, h.deps);
    assert.equal(Object.getOwnPropertyDescriptor(sealed, 'beta'), undefined);
    assert.equal(h.reloads.count, 0);
  });

  it('can be installed again after the property is removed', () => {
    const h = harness();
    installBetaConsoleToggle(h.target, h.deps);
    assert.equal(Reflect.deleteProperty(h.target, 'beta'), true);
    installBetaConsoleToggle(h.target, h.deps);
    assert.equal(h.target.beta, false);
    assert.deepEqual(h.logs, ['[Beta] OFF']);
  });
});
