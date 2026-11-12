import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDismissed, setDismissed } from '@/utils/cross-domain-storage';

const KEY = 'wm-layer-warning-dismissed';

afterEach(() => {
  restoreCookie();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('cross-domain dismissal', () => {
  it('honors a local dismissal when the shared cookie write does not persist', () => {
    stubHost('www.worldmonitor.app');
    installCookieJar({ persist: false });

    setDismissed(KEY);

    expect(localStorage.getItem(KEY)).toBe('1');
    expect(getDismissed(KEY)).toBe(true);
  });

  it('keeps a dismissal that only the shared cookie still holds', () => {
    stubHost('tech.worldmonitor.app');
    const jar = installCookieJar({ persist: true });

    setDismissed(KEY);
    localStorage.removeItem(KEY);

    expect(jar.writes[0]).toContain('domain=.worldmonitor.app');
    expect(getDismissed(KEY)).toBe(true);
  });

  it('honors a legacy localStorage true flag when the cookie is absent', () => {
    stubHost('worldmonitor.app');
    installCookieJar({ persist: true });
    localStorage.setItem(KEY, 'true');

    expect(getDismissed(KEY)).toBe(true);
  });

  it('stays unset when neither the cookie nor localStorage has the flag', () => {
    stubHost('finance.worldmonitor.app');
    installCookieJar({ persist: true });

    expect(getDismissed(KEY)).toBe(false);
  });

  it('reads the cookie when localStorage is unavailable', () => {
    stubHost('www.worldmonitor.app');
    installCookieJar({ persist: true });
    vi.stubGlobal('localStorage', null);

    expect(() => setDismissed(KEY)).not.toThrow();
    expect(getDismissed(KEY)).toBe(true);
  });

  it('returns false when cookies and localStorage are both unavailable', () => {
    stubHost('www.worldmonitor.app');
    installCookieJar({ persist: false });
    vi.stubGlobal('localStorage', null);

    expect(() => setDismissed(KEY)).not.toThrow();
    expect(getDismissed(KEY)).toBe(false);
  });

  it('keeps the localhost path on localStorage and does not write a cookie', () => {
    stubHost('localhost');
    const jar = installCookieJar({ persist: true });

    setDismissed(KEY);

    expect(jar.writes).toEqual([]);
    expect(getDismissed(KEY)).toBe(true);
  });

  it('does not treat a different cookie as this dismissal', () => {
    stubHost('www.worldmonitor.app');
    const jar = installCookieJar({ persist: true });
    jar.seed('other-notice', '1');
    localStorage.removeItem(KEY);

    expect(getDismissed(KEY)).toBe(false);
  });
});

function stubHost(hostname: string): void {
  vi.stubGlobal('location', {
    hostname,
    host: hostname,
    protocol: hostname === 'localhost' ? 'http:' : 'https:',
    origin: `${hostname === 'localhost' ? 'http' : 'https'}://${hostname}`,
    href: `${hostname === 'localhost' ? 'http' : 'https'}://${hostname}/`,
  });
}

let restoreCookie: () => void = () => {};

function installCookieJar(options: { persist: boolean }): { writes: string[]; seed: (name: string, value: string) => void } {
  const jar = new Map<string, string>();
  const writes: string[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(document, 'cookie');
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    set(line: string) {
      writes.push(line);
      if (!options.persist) return;
      const [pair] = line.split(';');
      const trimmed = pair?.trim() ?? '';
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return;
      const name = trimmed.slice(0, eq);
      const value = trimmed.slice(eq + 1);
      if (line.includes('max-age=0')) jar.delete(name);
      else jar.set(name, value);
    },
  });
  restoreCookie = () => {
    if (descriptor) Object.defineProperty(document, 'cookie', descriptor);
    else delete (document as { cookie?: string }).cookie;
    restoreCookie = () => {};
  };
  return {
    writes,
    seed(name, value) {
      jar.set(name, value);
    },
  };
}
