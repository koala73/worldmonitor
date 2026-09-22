import { expect, it, vi } from 'vitest';

vi.mock('@/locales/en.json', () => { throw new Error('locale download failed'); });

import { initI18n, t } from '@/services/i18n';

it('lets standalone startup continue with shell translations when the full locale fails', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    localStorage.setItem('wm-locale-explicit', 'en');
    await expect(initI18n({ waitForFullTranslation: true })).resolves.toBeUndefined();
    expect(t('header.search')).toBe('Search');
    expect(warning).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
