import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(resolve(__dirname, '../src/App.ts'), 'utf-8');

// App.ts can't be imported under node:test (it pulls in the whole app graph), so
// extract the private async openSearch() method, strip its types, and run it
// against a mocked `this`. Same source-extraction approach as
// sentry-beforesend.test.mjs / deckgl-interleaved-race-filter.test.mjs.
function extractOpenSearch() {
  const sig = 'private async openSearch(';
  const start = appSrc.indexOf(sig);
  assert.ok(start >= 0, 'openSearch must remain a method in App.ts');
  // Match the parameter-list parens first so the inline type literal
  // `{ toggle?: boolean; ... }` in the signature isn't mistaken for the body.
  const parenStart = start + sig.length - 1;
  let pd = 0;
  let parenEnd = -1;
  for (let i = parenStart; i < appSrc.length; i++) {
    const c = appSrc[i];
    if (c === '(') pd++;
    else if (c === ')') { pd--; if (pd === 0) { parenEnd = i; break; } }
  }
  assert.ok(parenEnd > parenStart, 'openSearch parameter list must have balanced parens');
  const braceStart = appSrc.indexOf('{', parenEnd);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < appSrc.length; i++) {
    const ch = appSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > braceStart, 'openSearch body must have balanced braces');
  // Drop the `private ` qualifier so it is a valid class method.
  const methodSrc = appSrc.slice(start, end).replace(/^private\s+/, '');
  const classSrc = `class __OpenSearchHarness { ${methodSrc} }`;
  const js = ts.transpileModule(classSrc, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  // showToast is a free (module-level) reference inside the method — inject it.
  // eslint-disable-next-line no-new-func
  return new Function('showToast', `${js}\nreturn __OpenSearchHarness;`);
}

const toastMessages = [];
const Harness = extractOpenSearch()((msg) => toastMessages.push(msg));

function makeInstance({ failLoad = false } = {}) {
  const inst = new Harness();
  const modal = {
    _open: false, opens: 0, closes: 0,
    open() { this._open = true; this.opens++; },
    close() { this._open = false; this.closes++; },
    isOpen() { return this._open; },
  };
  const manager = { updateSearchIndex() { manager.indexBuilds++; }, indexBuilds: 0 };
  let resolveGate, rejectGate;
  const gate = new Promise((res, rej) => { resolveGate = res; rejectGate = rej; });
  inst.openSearchEpoch = 0;
  inst.searchToggleDesiredOpen = false;
  inst.searchManager = null;
  inst.state = { searchModal: null, isDestroyed: false };
  inst.waitForUiReady = async () => {};
  inst.ensureSearchManager = function ensureSearchManager() {
    return gate.then(() => {
      if (failLoad) throw new Error('chunk load failed');
      this.searchManager = manager;
      this.state.searchModal = modal;
      return manager;
    });
  };
  return {
    inst, modal, manager,
    resolveLoad: () => { resolveGate(); return Promise.resolve(); },
    failLoadNow: () => { rejectGate(new Error('network')); },
  };
}

describe('App.openSearch lazy-load state machine (#4403)', () => {
  beforeEach(() => { toastMessages.length = 0; });

  it('opens on a single Cmd+K toggle (first load)', async () => {
    const h = makeInstance();
    const p = h.inst.openSearch({ toggle: true });
    await h.resolveLoad();
    await p;
    assert.equal(h.modal.opens, 1, 'modal should open once');
    assert.equal(h.modal.closes, 0);
  });

  it('opens once on a plain (non-toggle) button click', async () => {
    const h = makeInstance();
    const p = h.inst.openSearch({});
    await h.resolveLoad();
    await p;
    assert.equal(h.modal.opens, 1);
  });

  it('nets to CLOSED on two rapid Cmd+K presses during load (XOR parity)', async () => {
    const h = makeInstance();
    const p1 = h.inst.openSearch({ toggle: true });
    const p2 = h.inst.openSearch({ toggle: true });
    await h.resolveLoad();
    await Promise.all([p1, p2]);
    assert.equal(h.modal.opens, 0, 'even presses must cancel — modal stays closed');
  });

  it('nets to OPEN on three rapid Cmd+K presses during load (XOR parity)', async () => {
    const h = makeInstance();
    const ps = [h.inst.openSearch({ toggle: true }), h.inst.openSearch({ toggle: true }), h.inst.openSearch({ toggle: true })];
    await h.resolveLoad();
    await Promise.all(ps);
    assert.equal(h.modal.opens, 1, 'odd presses must open exactly once');
  });

  it('opens exactly once when a button click interleaves a pending Cmd+K toggle (no double-drive — ADV-1/JFR-001)', async () => {
    const h = makeInstance();
    const p1 = h.inst.openSearch({ toggle: true });
    const p2 = h.inst.openSearch({}); // button click during the load
    await h.resolveLoad();
    await Promise.all([p1, p2]);
    assert.equal(h.modal.opens, 1, 'interleave must resolve to a single open, not a double modal.open()');
  });

  it('surfaces a toast (no throw) when the search chunk fails to load on the user path', async () => {
    const h = makeInstance({ failLoad: true });
    const p = h.inst.openSearch({ toggle: true });
    h.failLoadNow();
    await p; // must not reject on the user path
    assert.equal(toastMessages.length, 1, 'user should get failure feedback');
    assert.equal(h.modal.opens, 0);
  });

  it('rethrows on the throwOnFailure (WebMCP) path so an agent gets a real failure', async () => {
    const h = makeInstance({ failLoad: true });
    const p = h.inst.openSearch({ throwOnFailure: true });
    h.failLoadNow();
    await assert.rejects(p);
    assert.equal(toastMessages.length, 0, 'agent path should not show a user toast');
  });

  it('closes an already-open modal on toggle (loaded)', async () => {
    const h = makeInstance();
    const p = h.inst.openSearch({ toggle: true });
    await h.resolveLoad();
    await p;
    assert.equal(h.modal.opens, 1);
    await h.inst.openSearch({ toggle: true }); // second toggle, now loaded + open
    assert.equal(h.modal.closes, 1, 'toggle on an open modal closes it');
  });
});
