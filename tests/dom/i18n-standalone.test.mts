import { expect, it } from 'vitest';
import { initI18n, t } from '@/services/i18n';

it('loads full English labels before standalone initialization completes', async () => {
  localStorage.setItem('wm-locale-explicit', 'en');
  await initI18n({ waitForFullTranslation: true });
  expect(t('components.liveNews.manage')).toBe('Manage channels');
  expect(t('components.liveNews.addChannel')).toBe('Add channel');
});
