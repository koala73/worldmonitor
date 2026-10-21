import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

const storage = new MemoryStorage();

before(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { sessionStorage: storage },
  });
});

const state = await import('../src/services/checkout-return-state.ts');

const previewContext = {
  eventSurface: 'mission-preview' as const,
  origin: {
    kind: 'mission-preview' as const,
    missionId: 'supply-chain-risk' as const,
    panelKey: 'supply-chain' as const,
  },
};

beforeEach(() => storage.clear());

describe('checkout return obligations', () => {
  it('arms analytics and focus in one record', () => {
    const armed = state.armCheckoutReturnState(previewContext, 'url-return');
    assert.equal(armed?.delivery.missionReturn, 'pending');
    assert.equal(armed?.delivery.panelFocus, 'pending');
    assert.deepEqual(state.loadCheckoutReturnState()?.context, previewContext);
  });

  it('keeps focus pending after analytics delivery', () => {
    state.armCheckoutReturnState(previewContext, 'url-return');
    state.settleMissionReturnDelivery();
    assert.deepEqual(state.loadCheckoutReturnState()?.delivery, {
      missionReturn: 'settled',
      panelFocus: 'pending',
    });
    state.settleCheckoutReturnFocus();
    assert.equal(state.loadCheckoutReturnState(), null);
  });

  it('keeps analytics pending after focus completes', () => {
    state.armCheckoutReturnState(previewContext, 'url-return');
    state.settleCheckoutReturnFocus();
    assert.deepEqual(state.loadCheckoutReturnState()?.delivery, {
      missionReturn: 'pending',
      panelFocus: 'focused',
    });
    state.settleMissionReturnDelivery();
    assert.equal(state.loadCheckoutReturnState(), null);
  });

  it('does not arm panel focus for a desktop handoff', () => {
    state.armCheckoutReturnState(previewContext, 'desktop-return');
    assert.equal(state.loadCheckoutReturnState()?.delivery.panelFocus, 'not-required');
  });

  it('rejects malformed stored context', () => {
    storage.setItem(state.CHECKOUT_RETURN_STATE_KEY, JSON.stringify({
      version: 1,
      source: 'url-return',
      createdAt: Date.now(),
      context: {
        eventSurface: 'mission-preview',
        origin: { kind: 'mission-preview', missionId: 'evil', panelKey: 'cii' },
      },
      delivery: { missionReturn: 'pending', panelFocus: 'pending' },
    }));
    assert.equal(state.loadCheckoutReturnState(), null);
    assert.equal(storage.getItem(state.CHECKOUT_RETURN_STATE_KEY), null);
  });
});
