/**
 * The WM-owned dialog that hosts Clerk's mounted SignUp on a resumed attempt
 * (#8577). Clerk's HashRouter reads `location.hash` at mount, so the hash must
 * be in place before `mount` runs, and must be gone after close so a later
 * reload never carries a stale route. The dashboard keeps its state in the
 * query string, which the handshake must leave alone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SIGN_UP_VERIFY_HASH,
  createSignUpResumeOverlay,
  urlWithHash,
  urlWithoutHash,
  type SignUpResumeMountProps,
} from '@/components/SignUpResumeOverlay';
import { asSignUpAttemptId } from '@/services/sign-up-resume';
import { findReloadBlockingModal } from '@/utils/open-modal';

const attempt = { attemptId: asSignUpAttemptId('sua_3Jr2uAz4iuUohdPDXnaKu9y6N6Y'), email: 'new-user@example.com' };
const DASHBOARD = '/?zoom=3&view=map';

interface Recorder {
  mounts: Array<{ host: HTMLDivElement; props: SignUpResumeMountProps; hashAtMount: string }>;
  unmounts: HTMLDivElement[];
}

function overlay() {
  const rec: Recorder = { mounts: [], unmounts: [] };
  const surface = createSignUpResumeOverlay({
    mount: (host, props) => rec.mounts.push({ host, props, hashAtMount: window.location.hash }),
    unmount: (host) => rec.unmounts.push(host),
  });
  return { rec, surface };
}

beforeEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, '', DASHBOARD);
});

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, '', '/');
});

describe('url helpers', () => {
  it('replace and strip the hash without touching the query string', () => {
    const base = `${window.location.origin}${DASHBOARD}`;
    expect(urlWithHash(base, SIGN_UP_VERIFY_HASH)).toBe(`${base}${SIGN_UP_VERIFY_HASH}`);
    expect(urlWithHash(`${base}#stale`, SIGN_UP_VERIFY_HASH)).toBe(`${base}${SIGN_UP_VERIFY_HASH}`);
    expect(urlWithoutHash(`${base}${SIGN_UP_VERIFY_HASH}`)).toBe(base);
  });
});

describe('sign-up resume overlay', () => {
  it('sets the verify hash before mounting and passes the hashless URL as fallbackRedirectUrl', () => {
    const { rec, surface } = overlay();
    surface.open(attempt, () => {});
    expect(rec.mounts).toHaveLength(1);
    expect(rec.mounts[0]!.hashAtMount).toBe(SIGN_UP_VERIFY_HASH);
    expect(rec.mounts[0]!.props).toEqual({
      routing: 'hash',
      fallbackRedirectUrl: `${window.location.origin}${DASHBOARD}`,
    });
    expect(rec.mounts[0]!.host.isConnected).toBe(true);
    expect(surface.isOpen()).toBe(true);
  });

  it('holds automatic reloads off while open', () => {
    const { surface } = overlay();
    surface.open(attempt, () => {});
    expect(findReloadBlockingModal(document)?.policy).toBe('blocking');
  });

  it('unmounts, removes itself and strips the hash on close, keeping the query string', () => {
    const { rec, surface } = overlay();
    surface.open(attempt, () => {});
    surface.close();
    expect(rec.unmounts).toEqual([rec.mounts[0]!.host]);
    expect(surface.isOpen()).toBe(false);
    expect(document.querySelector('.signup-resume-overlay')).toBeNull();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?zoom=3&view=map');
    expect(findReloadBlockingModal(document)).toBeNull();
  });

  it('opens once while already open', () => {
    const { rec, surface } = overlay();
    surface.open(attempt, () => {});
    surface.open(attempt, () => {});
    expect(rec.mounts).toHaveLength(1);
    expect(document.querySelectorAll('.signup-resume-overlay')).toHaveLength(1);
  });

  it('reports a dismissal from the close button, and only then', () => {
    const { surface } = overlay();
    let dismissed = 0;
    surface.open(attempt, () => { dismissed += 1; });
    surface.close();
    expect(dismissed).toBe(0);

    surface.open(attempt, () => { dismissed += 1; });
    (document.querySelector('.signup-resume-close') as HTMLButtonElement).click();
    expect(dismissed).toBe(1);
    expect(surface.isOpen()).toBe(false);
    expect(window.location.hash).toBe('');
  });

  it('reports a dismissal on Escape', () => {
    const { surface } = overlay();
    let dismissed = 0;
    surface.open(attempt, () => { dismissed += 1; });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dismissed).toBe(1);
    expect(surface.isOpen()).toBe(false);
  });

  it('labels the dialog and the close button for assistive technology', () => {
    const { surface } = overlay();
    surface.open(attempt, () => {});
    const el = document.querySelector('.signup-resume-overlay')!;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.getAttribute('aria-label')).toBeTruthy();
    expect(document.querySelector('.signup-resume-close')!.getAttribute('aria-label')).toBeTruthy();
  });
});
