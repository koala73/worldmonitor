/**
 * A Business seat invite link lands on /dashboard?accept-business-invite=<id>&token=<t>.
 * The dashboard's map URL sync rewrites the query string from map state about
 * 250 ms after boot (buildMapUrl keeps only map params), so an invitee who is
 * signed out on arrival and creates an account afterwards used to reach the
 * accept hook with both params gone: the seat never attached and nothing was
 * logged. The invite is now captured at boot and kept in sessionStorage, which
 * also survives the full page load Clerk performs when sign-up completes.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { buildMapUrl } from '../src/utils/urlState.ts';
import type { MapLayers } from '../src/types/index.ts';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.has(key) ? (this.store.get(key) as string) : null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
}

interface MutableLocation { href: string; origin: string; pathname: string; search: string; hash: string; }

let _sessionStorage: MemoryStorage | null;
let _loc: MutableLocation;

function setUrl(href: string): void {
  const url = new URL(href);
  _loc.href = url.toString();
  _loc.origin = url.origin;
  _loc.pathname = url.pathname;
  _loc.search = url.search;
  _loc.hash = url.hash;
}

before(() => {
  _loc = { href: '', origin: '', pathname: '', search: '', hash: '' };
  setUrl('https://www.worldmonitor.app/dashboard');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => _sessionStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: _loc,
      history: {
        replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
          if (url !== undefined && url !== null) setUrl(new URL(String(url), _loc.href).toString());
        },
      },
    },
  });
});

after(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).sessionStorage;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any).window;
});

const {
  captureBusinessInviteFromUrl,
  loadPendingBusinessInvite,
  businessInviteErrorKind,
  clearPendingBusinessInvite,
  keepInviteAfterAttempt,
  resetBusinessInviteMemoryForTests,
  BUSINESS_INVITE_STORAGE_KEY,
} = await import('../src/services/business-invite-capture.ts');

const GRANT = 'pn7c2d3kwfykbagx4nv62t3pnd8gtaps';
const TOKEN = 'v1.1793953325257.01e51e85f422fd9f';
const INVITE_URL = `https://www.worldmonitor.app/dashboard?accept-business-invite=${GRANT}&token=${TOKEN}`;

/** What setupUrlStateSync writes once the map is up. */
function runMapUrlSync(): void {
  const next = buildMapUrl(`${_loc.origin}${_loc.pathname}`, {
    view: 'global',
    zoom: 2,
    center: { lat: 20, lon: 0 },
    timeRange: '7d',
    layers: {} as MapLayers,
  });
  window.history.replaceState({}, '', next);
}

beforeEach(() => {
  _sessionStorage = new MemoryStorage();
  resetBusinessInviteMemoryForTests();
  setUrl('https://www.worldmonitor.app/dashboard');
});

describe('Enterprise invite links', () => {
  const MEMBER = 'k17enterprisememberrow0000000001';
  const ENTERPRISE_URL = `https://www.worldmonitor.app/dashboard?accept-enterprise-invite=${MEMBER}&token=${TOKEN}`;

  it('captures the link as an Enterprise invite and strips its params', () => {
    setUrl(`${ENTERPRISE_URL}&country=UA`);
    assert.deepEqual(captureBusinessInviteFromUrl(), { grantId: MEMBER, token: TOKEN, kind: 'enterprise' });
    const params = new URLSearchParams(_loc.search);
    assert.equal(params.get('accept-enterprise-invite'), null);
    assert.equal(params.get('token'), null);
    assert.equal(params.get('country'), 'UA');
  });

  it('keeps the kind across the reload Clerk performs after sign-up', () => {
    setUrl(ENTERPRISE_URL);
    captureBusinessInviteFromUrl();
    runMapUrlSync();
    resetBusinessInviteMemoryForTests();
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: MEMBER, token: TOKEN, kind: 'enterprise' });
  });

  it('does not clear an Enterprise invite when a Business invite with the same id settles', () => {
    setUrl(ENTERPRISE_URL);
    captureBusinessInviteFromUrl();
    clearPendingBusinessInvite({ grantId: MEMBER, token: TOKEN });
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: MEMBER, token: TOKEN, kind: 'enterprise' });
  });

  it('drops a stored invite with an unknown kind', () => {
    _sessionStorage!.setItem(BUSINESS_INVITE_STORAGE_KEY, JSON.stringify({ grantId: MEMBER, token: TOKEN, kind: 'team' }));
    assert.equal(loadPendingBusinessInvite(), null);
    assert.equal(_sessionStorage!.getItem(BUSINESS_INVITE_STORAGE_KEY), null);
  });

  it('maps the Enterprise accept rejections to their kinds', () => {
    for (const kind of ['CONTRACT_ENDED', 'ALREADY_MEMBER_OF_ANOTHER_ACCOUNT', 'INVITE_NOT_FOUND']) {
      assert.equal(businessInviteErrorKind(new Error(`[CONVEX M(enterpriseSeats:acceptInvite)] ${kind}`)), kind);
    }
  });
});

describe('captureBusinessInviteFromUrl', () => {
  it('the map URL sync drops the invite params (the failure this module exists for)', () => {
    setUrl(INVITE_URL);
    runMapUrlSync();
    const params = new URLSearchParams(_loc.search);
    assert.equal(params.get('accept-business-invite'), null);
    assert.equal(params.get('token'), null);
  });

  it('keeps the invite for a sign-in that happens after the map URL sync', () => {
    setUrl(INVITE_URL);
    assert.deepEqual(captureBusinessInviteFromUrl(), { grantId: GRANT, token: TOKEN });
    runMapUrlSync();
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: GRANT, token: TOKEN });
  });

  it('survives the full page load Clerk performs when sign-up completes', () => {
    setUrl(INVITE_URL);
    captureBusinessInviteFromUrl();
    runMapUrlSync();
    // A reload clears module memory; only sessionStorage carries over.
    resetBusinessInviteMemoryForTests();
    assert.equal(captureBusinessInviteFromUrl(), null, 'the reloaded URL no longer has the params');
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: GRANT, token: TOKEN });
  });

  it('strips the token from the visible URL and keeps unrelated params and the hash', () => {
    setUrl(`${INVITE_URL}&country=UA#/verify`);
    captureBusinessInviteFromUrl();
    const params = new URLSearchParams(_loc.search);
    assert.equal(params.get('accept-business-invite'), null);
    assert.equal(params.get('token'), null);
    assert.equal(params.get('country'), 'UA');
    assert.equal(_loc.hash, '#/verify');
  });

  it('a newer invite link replaces a stored one', () => {
    setUrl(INVITE_URL);
    captureBusinessInviteFromUrl();
    setUrl('https://www.worldmonitor.app/dashboard?accept-business-invite=newgrant&token=newtoken');
    captureBusinessInviteFromUrl();
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: 'newgrant', token: 'newtoken' });
  });

  it('ignores a link carrying only one of the two params, and does not strip a lone token', () => {
    setUrl('https://www.worldmonitor.app/dashboard?accept-business-invite=abc');
    assert.equal(captureBusinessInviteFromUrl(), null);
    assert.equal(loadPendingBusinessInvite(), null);
    setUrl('https://www.worldmonitor.app/dashboard?token=unrelated');
    assert.equal(captureBusinessInviteFromUrl(), null);
    assert.equal(new URLSearchParams(_loc.search).get('token'), 'unrelated');
  });

  it('works for the same page load when sessionStorage is unavailable (Android WebView returns null)', () => {
    _sessionStorage = null;
    setUrl(INVITE_URL);
    captureBusinessInviteFromUrl();
    runMapUrlSync();
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: GRANT, token: TOKEN });
  });

  it('drops a malformed stored record instead of sending it', () => {
    _sessionStorage!.setItem(BUSINESS_INVITE_STORAGE_KEY, '{"grantId":42}');
    assert.equal(loadPendingBusinessInvite(), null);
    assert.equal(_sessionStorage!.getItem(BUSINESS_INVITE_STORAGE_KEY), null);
  });
});

describe('clearPendingBusinessInvite', () => {
  it('clears the invite it was given', () => {
    setUrl(INVITE_URL);
    const invite = captureBusinessInviteFromUrl()!;
    clearPendingBusinessInvite(invite);
    assert.equal(loadPendingBusinessInvite(), null);
    assert.equal(_sessionStorage!.getItem(BUSINESS_INVITE_STORAGE_KEY), null);
  });

  it('leaves a newer invite captured while the older accept was in flight', () => {
    setUrl(INVITE_URL);
    const older = captureBusinessInviteFromUrl()!;
    setUrl('https://www.worldmonitor.app/dashboard?accept-business-invite=newgrant&token=newtoken');
    captureBusinessInviteFromUrl();
    clearPendingBusinessInvite(older);
    assert.deepEqual(loadPendingBusinessInvite(), { grantId: 'newgrant', token: 'newtoken' });
  });
});

describe('businessInviteErrorKind', () => {
  it('reads the kind from object-data ConvexError data, not the message', () => {
    // Production messages can be a bare "[Request ID: X] Server Error".
    const err = Object.assign(new Error('[Request ID: abc] Server Error'), { data: { kind: 'INVITE_EMAIL_MISMATCH' } });
    assert.equal(businessInviteErrorKind(err), 'INVITE_EMAIL_MISMATCH');
  });

  it('falls back to a known kind named in the message', () => {
    assert.equal(businessInviteErrorKind(new Error('Uncaught ConvexError: {"kind":"INVITE_EXPIRED"}')), 'INVITE_EXPIRED');
  });

  it('returns null for an unknown shape', () => {
    assert.equal(businessInviteErrorKind(new Error('[Request ID: abc] Server Error')), null);
    assert.equal(businessInviteErrorKind('boom'), null);
    assert.equal(businessInviteErrorKind(null), null);
  });
});

describe('keepInviteAfterAttempt', () => {
  it('drops an accepted invite, even when the account changed after the server accepted it', () => {
    assert.equal(keepInviteAfterAttempt({ accepted: true, accountChanged: false }), false);
    assert.equal(keepInviteAfterAttempt({ accepted: true, accountChanged: true }), false);
  });

  it('keeps the invite when the user signed out before the answer came back', () => {
    // Sign-out lands between the request and its answer; the next sign-in
    // with the invited address must still find the invite.
    assert.equal(keepInviteAfterAttempt({ accepted: false, accountChanged: true, errorKind: null }), true);
  });

  it('keeps the invite after a wrong-account rejection', () => {
    assert.equal(keepInviteAfterAttempt({ accepted: false, accountChanged: false, errorKind: 'INVITE_EMAIL_MISMATCH' }), true);
  });

  it('drops the invite after a final rejection or an unknown failure', () => {
    for (const kind of ['INVITE_EXPIRED', 'INVITE_ALREADY_USED', 'BUSINESS_NOT_ACTIVE', 'INVALID_INVITE_TOKEN', 'GRANT_NOT_FOUND', null]) {
      assert.equal(keepInviteAfterAttempt({ accepted: false, accountChanged: false, errorKind: kind }), false, String(kind));
    }
  });
});
