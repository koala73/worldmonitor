import { afterEach, describe, expect, it, vi } from 'vitest';

import { setPersistentCache } from '@/services/persistent-cache';
import { saveToStorage } from '@/utils';
import { isStorageQuotaExceeded } from '@/utils/storage-quota';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('storage quota backoff', () => {
  it('stops cache writes after quota exhaustion but still saves preferences', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const write = vi.spyOn(localStorage, 'setItem');
    write.mockImplementationOnce(() => { throw new DOMException('Storage full', 'QuotaExceededError'); });

    await setPersistentCache('large-feed', { articles: [] });
    expect(write).toHaveBeenCalledOnce();
    expect(isStorageQuotaExceeded()).toBe(true);
    write.mockClear();

    await setPersistentCache('next-feed', { articles: [] });
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem('worldmonitor-persistent-cache:next-feed')).toBeNull();

    const open = vi.fn(() => { throw new Error('Cache must not retry IndexedDB after quota exhaustion'); });
    vi.stubGlobal('indexedDB', { open });
    await setPersistentCache('indexed-feed', { articles: [] });
    expect(open).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();

    expect(saveToStorage('worldmonitor-panels', { news: true })).toBe(true);
    expect(localStorage.getItem('worldmonitor-panels')).toBe('{"news":true}');
  });
});
