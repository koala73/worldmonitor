import { describe, it, expect } from 'vitest';
import { BOOT_VERSION, BOOT_SEEN_KEY, chooseBootMode, markBootSeen } from './boot-mode';

/** Minimal Storage stand-in. Real Storage throws in some webview privacy
 *  modes, which is the case the `throwing` variant covers. */
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    read: () => Object.fromEntries(map),
  };
}

const throwing = {
  getItem: () => { throw new Error('storage disabled'); },
  setItem: () => { throw new Error('storage disabled'); },
};

describe('chooseBootMode', () => {
  it('plays the full ceremony the first time it ever runs', () => {
    expect(chooseBootMode({ storage: fakeStorage() })).toBe('full');
  });

  it('shortens the boot once this version has been seen', () => {
    const storage = fakeStorage({ [BOOT_SEEN_KEY]: BOOT_VERSION });
    expect(chooseBootMode({ storage })).toBe('short');
  });

  it('plays the full ceremony again after a version bump', () => {
    // The intro is also the release note: a rebuilt sequence should be seen.
    const storage = fakeStorage({ [BOOT_SEEN_KEY]: 'something-older' });
    expect(chooseBootMode({ storage })).toBe('full');
  });

  it('lets ?boot=full force the ceremony back on a seen install', () => {
    const storage = fakeStorage({ [BOOT_SEEN_KEY]: BOOT_VERSION });
    expect(chooseBootMode({ storage, search: '?boot=full' })).toBe('full');
  });

  it('lets ?boot=short skip the ceremony on a fresh install', () => {
    expect(chooseBootMode({ storage: fakeStorage(), search: '?boot=short' })).toBe('short');
  });

  it('ignores an unrecognised ?boot value rather than guessing', () => {
    expect(chooseBootMode({ storage: fakeStorage(), search: '?boot=sideways' })).toBe('full');
  });

  it('shortens the boot when the user asked for reduced motion', () => {
    expect(chooseBootMode({ storage: fakeStorage(), reducedMotion: true })).toBe('short');
  });

  it('still honours an explicit ?boot=full under reduced motion', () => {
    // Reduced motion is a default, not a veto — the director separately drops
    // the sequence's durations, so asking for it explicitly stays possible.
    expect(chooseBootMode({ storage: fakeStorage(), reducedMotion: true, search: '?boot=full' }))
      .toBe('full');
  });

  it('falls back to the full ceremony when storage is unavailable', () => {
    // A webview with storage disabled must still boot, and the safe default is
    // the sequence that is guaranteed to build the title.
    expect(chooseBootMode({ storage: throwing })).toBe('full');
    expect(chooseBootMode({ storage: null })).toBe('full');
  });
});

describe('markBootSeen', () => {
  it('records the current version so the next launch is short', () => {
    const storage = fakeStorage();
    markBootSeen(storage);
    expect(storage.read()[BOOT_SEEN_KEY]).toBe(BOOT_VERSION);
    expect(chooseBootMode({ storage })).toBe('short');
  });

  it('never throws when storage refuses to be written', () => {
    expect(() => markBootSeen(throwing)).not.toThrow();
    expect(() => markBootSeen(null)).not.toThrow();
  });
});
