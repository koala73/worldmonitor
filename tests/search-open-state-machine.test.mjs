import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  raceWebMcpAbort,
  throwIfWebMcpAborted,
} from '../src/services/webmcp.ts';

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
  // Module-level references inside the method are injected as recording doubles.
  // eslint-disable-next-line no-new-func
  return new Function(
    'showToast',
    'overlayHistory',
    'raceWebMcpAbort',
    'throwIfWebMcpAborted',
    `${js}\nreturn __OpenSearchHarness;`,
  );
}

const toastMessages = [];
const historyDouble = {
  calls: [],
  current: null,
  beginPending(id, replaceOverlayId, onCancel) {
    const state = { active: true, id, onCancel };
    this.current = state;
    this.calls.push({ method: 'beginPending', id, replaceOverlayId });
    return {
      isCurrent: () => state.active && this.current === state,
      cancel: () => {
        if (!state.active) return;
        state.active = false;
        onCancel();
        this.calls.push({ method: 'cancel', id });
      },
    };
  },
  back() {
    if (!this.current?.active) return;
    this.current.active = false;
    this.current.onCancel();
    this.calls.push({ method: 'back', id: this.current.id });
  },
  reset() {
    this.calls.length = 0;
    this.current = null;
  },
};
const Harness = extractOpenSearch()(
  (msg) => toastMessages.push(msg),
  historyDouble,
  raceWebMcpAbort,
  throwIfWebMcpAborted,
);

function makeInstance({ failLoad = false } = {}) {
  const inst = new Harness();
  const modal = {
    _open: false, opens: 0, closes: 0, openArgs: [], queryArgs: [],
    open(replaceOverlayId) { this._open = true; this.opens++; this.openArgs.push(replaceOverlayId); },
    applyQuery(term) { this.queryArgs.push(term); },
    close() { this._open = false; this.closes++; },
    isOpen() { return this._open; },
  };
  const manager = {
    indexBuilds: 0,
    cancelCalls: 0,
    onCancel: null,
    updateSearchIndex() { manager.indexBuilds++; },
    cancelPendingProgrammaticSelection() {
      manager.cancelCalls++;
      manager.onCancel?.();
    },
  };
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
  it('startup consumes SearchAction ?q= through the lazy openSearch path', () => {
    assert.match(appSrc, /readDashboardSearchQuery\(window\.location\.search\)/);
    assert.match(
      appSrc,
      /pendingDeepLinkSearchQuery/,
      'the term must be captured before URL sync rewrites the address bar',
    );
    assert.match(
      appSrc,
      /openSearch\(\{\s*initialQuery:\s*searchQuery\s*\}\)/,
      'captured ?q= must enter the existing lazy search path',
    );
    assert.match(
      appSrc,
      /if \(options\.initialQuery\) modal\.applyQuery\(options\.initialQuery\)/,
      'openSearch must hand the term to the modal after lazy init',
    );
  });

  beforeEach(() => {
    toastMessages.length = 0;
    historyDouble.reset();
  });

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

  it('cancels a WebMCP open while the search chunk is loading without a late modal', async () => {
    const h = makeInstance();
    const controller = new AbortController();
    const pending = h.inst.openSearch({ throwOnFailure: true, signal: controller.signal });
    controller.abort();

    await assert.rejects(pending, (error) => error === controller.signal.reason);
    await h.resolveLoad();
    await Promise.resolve();
    assert.equal(h.modal.opens, 0);
    assert.deepEqual(toastMessages, []);
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

  it('denies an older deferred result before reopening the human palette', async () => {
    const h = makeInstance();
    const load = h.inst.openSearch({});
    await h.resolveLoad();
    await load;
    h.modal._open = false;

    let resolveAgent;
    const pendingAgent = new Promise((resolve) => { resolveAgent = resolve; });
    h.manager.onCancel = () => resolveAgent({
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });

    assert.equal(await h.inst.openSearch({}), true);
    assert.deepEqual(await pendingAgent, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(h.manager.cancelCalls, 1);
    assert.equal(h.modal.isOpen(), true, 'the newer palette intent must remain open');
    assert.equal(h.modal.closes, 0, 'the superseded agent must not close the palette later');
  });

  it('records replacement context and passes the pending marker to SearchModal', async () => {
    const h = makeInstance();
    const p = h.inst.openSearch({ historyPending: true, replaceOverlayId: 'menu' });
    assert.deepEqual(historyDouble.calls, [
      { method: 'beginPending', id: 'search-pending', replaceOverlayId: 'menu' },
    ]);

    await h.resolveLoad();
    await p;
    assert.deepEqual(h.modal.openArgs, ['search-pending']);
  });

  it('does not open Search after Back cancels its pending lazy load', async () => {
    const h = makeInstance();
    const p = h.inst.openSearch({ historyPending: true });
    historyDouble.back();

    await h.resolveLoad();
    await p;
    assert.equal(h.modal.opens, 0);
    assert.equal(h.inst.searchToggleDesiredOpen, false);
  });

  it('passes a SearchAction query through the lazy path to the modal', async () => {
    const h = makeInstance();
    const p = h.inst.openSearch({ initialQuery: 'hormuz strait' });
    await h.resolveLoad();
    await p;
    assert.equal(h.modal.opens, 1, 'lazy load must still open the modal');
    assert.deepEqual(h.modal.queryArgs, ['hormuz strait'], 'modal must receive the deep-link term');
  });

  it('does not toast when a Back-cancelled Search chunk later fails', async () => {
    const h = makeInstance({ failLoad: true });
    const p = h.inst.openSearch({ historyPending: true });
    await Promise.resolve(); // let openSearch attach its handler to the in-flight chunk
    historyDouble.back();
    h.failLoadNow();

    await p;
    assert.equal(h.modal.opens, 0);
    assert.deepEqual(toastMessages, []);
  });
});
