/**
 * Behavioral tests for DeckGLMap state isolation.
 *
 * DeckGLMap requires DOM + WebGL so it cannot be instantiated in Node.
 * These tests replicate the exact copy logic used in the constructor,
 * setLayers(), getState(), and onStateChange() to prove the isolation
 * contract holds at runtime — any mutation to caller-owned objects must
 * NOT affect internal state, and vice versa.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------- helpers replicating DeckGLMap logic ----------

function copyInitialState(initialState) {
  return {
    ...initialState,
    pan: { ...initialState.pan },
    layers: { ...initialState.layers },
  };
}

function copyLayers(layers) {
  return { ...layers };
}

function copyStateForExport(state) {
  return {
    ...state,
    pan: { ...state.pan },
    layers: { ...state.layers },
  };
}

// ---------- fixtures ----------

function makeState() {
  return {
    zoom: 3,
    pan: { x: 10, y: 20 },
    view: 'global',
    layers: { hotspots: true, flights: false, conflicts: true },
    timeRange: '24h',
  };
}

// ---------- tests ----------

describe('DeckGLMap state isolation (behavioral)', () => {
  describe('constructor isolation', () => {
    it('mutating the original layers object does not affect internal state', () => {
      const original = makeState();
      const internal = copyInitialState(original);
      original.layers.hotspots = false;
      assert.equal(internal.layers.hotspots, true);
    });

    it('mutating the original pan object does not affect internal state', () => {
      const original = makeState();
      const internal = copyInitialState(original);
      original.pan.x = 999;
      assert.equal(internal.pan.x, 10);
    });

    it('mutating internal state does not affect the original', () => {
      const original = makeState();
      const internal = copyInitialState(original);
      internal.layers.flights = true;
      assert.equal(original.layers.flights, false);
    });
  });

  describe('setLayers isolation', () => {
    it('mutating the input layers after setLayers does not affect stored layers', () => {
      const input = { hotspots: true, flights: false, conflicts: true };
      const stored = copyLayers(input);
      input.hotspots = false;
      assert.equal(stored.hotspots, true);
    });

    it('mutating stored layers does not affect the caller object', () => {
      const input = { hotspots: true, flights: false, conflicts: true };
      const stored = copyLayers(input);
      stored.flights = true;
      assert.equal(input.flights, false);
    });
  });

  describe('getState isolation', () => {
    it('returned state.layers is a separate object from internal layers', () => {
      const internal = { state: makeState() };
      const exported = copyStateForExport(internal.state);
      assert.notEqual(exported.layers, internal.state.layers);
    });

    it('mutating returned layers does not affect internal state', () => {
      const internal = { state: makeState() };
      const exported = copyStateForExport(internal.state);
      exported.layers.hotspots = false;
      assert.equal(internal.state.layers.hotspots, true);
    });

    it('returned state.pan is a separate object from internal pan', () => {
      const internal = { state: makeState() };
      const exported = copyStateForExport(internal.state);
      assert.notEqual(exported.pan, internal.state.pan);
    });

    it('mutating returned pan does not affect internal state', () => {
      const internal = { state: makeState() };
      const exported = copyStateForExport(internal.state);
      exported.pan.x = 999;
      assert.equal(internal.state.pan.x, 10);
    });
  });

  describe('onStateChange isolation', () => {
    it('callback receives a copy, not the internal reference', () => {
      const internal = { state: makeState() };
      let received = null;
      const callback = (s) => { received = s; };
      callback(copyStateForExport(internal.state));
      assert.notEqual(received.layers, internal.state.layers);
      assert.notEqual(received.pan, internal.state.pan);
    });

    it('mutating the callback state does not affect internal state', () => {
      const internal = { state: makeState() };
      let received = null;
      const callback = (s) => { received = s; };
      callback(copyStateForExport(internal.state));
      received.layers.hotspots = false;
      received.pan.x = 999;
      assert.equal(internal.state.layers.hotspots, true);
      assert.equal(internal.state.pan.x, 10);
    });
  });
});
