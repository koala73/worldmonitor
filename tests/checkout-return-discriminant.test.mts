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
