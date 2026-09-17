import { afterEach, beforeAll, expect, it } from 'vitest';
import { MonitorPanel } from '@/components/MonitorPanel';
import { initTestI18n } from './helpers/i18n.mts';
let panel: MonitorPanel;
beforeAll(initTestI18n);
afterEach(() => { panel?.destroy(); document.body.innerHTML = ''; });
it('keeps query parameters intact and rejects executable schemes on DOM links', () => {
  panel = new MonitorPanel([{ id: 'test', keywords: ['oil'], color: '#f00' }]);
  document.body.append(panel.getElement());
  panel.renderResults([
    { title: 'oil price', source: 'Test', link: 'https://example.com/?a=1&b=%22x%22', pubDate: new Date(), isAlert: false },
    { title: 'oil risk', source: 'Test', link: 'javascript:alert(1)', pubDate: new Date(), isAlert: false },
  ]);
  const links = panel.getElement().querySelectorAll('a.item-title');
  expect(links[0]?.getAttribute('href')).toBe('https://example.com/?a=1&b=%22x%22');
  expect(links[1]?.getAttribute('href')).toBe('');
});
