import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = 'https://worldmonitor.app/';

interface MutableLocation {
  href: string;
  pathname: string;
  search: string;
  hash: string;
}

interface MutableHistory {
  replaceState: (state: unknown, unused: string, url?: string | URL | null) => void;
}

let _loc: MutableLocation;
let _history: MutableHistory;

function setUrl(href: string): void {
  const url = new URL(href);
  _loc.href = url.toString();
  _loc.pathname = url.pathname;
  _loc.search = url.search;
  _loc.hash = url.hash;
}

before(() => {
  _loc = { href: BASE_URL, pathname: '/', search: '', hash: '' };
  _history = {
    replaceState: (_state, _unused, url) => {
      if (url !== undefined && url !== null) setUrl(new URL(String(url), _loc.href).toString());
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: _loc, history: _history },
  });
});

after(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
});

beforeEach(() => {
  setUrl(BASE_URL);
});

const { handleCheckoutReturn } = await import('../src/services/checkout-return.ts');

describe('handleCheckoutReturn', () => {
  it('returns { kind: "none" } when no checkout params present', () => {
    setUrl(`${BASE_URL}?foo=bar`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'none' });
    assert.equal(_loc.href, `${BASE_URL}?foo=bar`, 'URL is not modified when no checkout params');
  });

  it('returns { kind: "success" } for status=active', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=active`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'success' });
  });

  it('returns { kind: "success" } for status=succeeded', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=succeeded`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'success' });
  });

  it('returns { kind: "failed" } for status=failed with raw status preserved', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=failed`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'failed', rawStatus: 'failed' });
  });

  it('returns { kind: "failed" } for status=declined', () => {
    setUrl(`${BASE_URL}?payment_id=pay_X&status=declined`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'failed', rawStatus: 'declined' });
  });

  it('returns { kind: "failed" } for status=cancelled', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=cancelled`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'failed', rawStatus: 'cancelled' });
  });

  it('treats unknown status as failed (prefer surfacing over silent success)', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=bogus_new_value`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'failed', rawStatus: 'bogus_new_value' });
  });

  it('returns { kind: "none" } when checkout params present but status missing', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'none' });
  });

  it('cleans checkout params from URL on success', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=active&foo=bar`);
    handleCheckoutReturn();
    assert.equal(_loc.href, `${BASE_URL}?foo=bar`);
  });

  it('cleans checkout params from URL on failure too', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=failed&foo=bar`);
    handleCheckoutReturn();
    assert.equal(_loc.href, `${BASE_URL}?foo=bar`);
  });

  it('strips email and license_key alongside status params', () => {
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=active&email=u@x&license_key=k`);
    handleCheckoutReturn();
    assert.equal(_loc.href, BASE_URL);
  });
});

describe('handleCheckoutReturn — /pro overlay-success marker (?wm_checkout=)', () => {
  it('returns { kind: "success" } for ?wm_checkout=success alone (no Dodo params)', () => {
    setUrl(`${BASE_URL}?wm_checkout=success`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'success' });
  });

  it('cleans the wm_checkout param from URL after handling', () => {
    setUrl(`${BASE_URL}?wm_checkout=success&foo=bar`);
    handleCheckoutReturn();
    assert.equal(_loc.href, `${BASE_URL}?foo=bar`);
  });

  it('ignores unknown wm_checkout values without triggering success', () => {
    setUrl(`${BASE_URL}?wm_checkout=weird_new_value`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'none' });
    // URL still cleans defensively — we don't want a garbage marker
    // lingering visible.
    assert.equal(_loc.href, BASE_URL);
  });

  it('Dodo success status wins over wm_checkout marker when both present', () => {
    // Defensive: if both signals arrive together (unlikely but possible
    // via a manually-constructed URL), the Dodo status carries the
    // richer information and should be honored.
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=active&wm_checkout=success`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'success' });
  });

  it('Dodo failure status wins over wm_checkout=success (surface actual failure)', () => {
    // If Dodo says failed but the URL also carries our success marker,
    // prefer the failure so the user isn't falsely congratulated.
    setUrl(`${BASE_URL}?subscription_id=sub_X&status=failed&wm_checkout=success`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'failed', rawStatus: 'failed' });
  });

  it('a second call after cleanup returns kind:"none" (no repeat trigger)', () => {
    setUrl(`${BASE_URL}?wm_checkout=success`);
    assert.equal(handleCheckoutReturn().kind, 'success');
    // URL is now clean; the next call must NOT re-fire the success path.
    assert.equal(handleCheckoutReturn().kind, 'none');
  });

  it('rejects ?status=active without Dodo IDs — cannot spoof success via wm_checkout presence', () => {
    // Regression guard: before the priority-order tightening, any URL
    // with a wm_checkout value would unlock Dodo-status evaluation even
    // without subscription_id/payment_id, meaning an attacker could
    // craft `?status=active&wm_checkout=x` to fire a success banner.
    // Now the Dodo status is only honored when Dodo IDs are present.
    setUrl(`${BASE_URL}?status=active&wm_checkout=garbage`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'none' });
  });

  it('rejects ?status=failed without Dodo IDs (symmetric with success guard)', () => {
    setUrl(`${BASE_URL}?status=failed&wm_checkout=garbage`);
    assert.deepEqual(handleCheckoutReturn(), { kind: 'none' });
  });
});
