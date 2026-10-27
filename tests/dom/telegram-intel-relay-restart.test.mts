import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';

const panels: TelegramIntelPanel[] = [];

function mountPanel(): TelegramIntelPanel {
  const panel = new TelegramIntelPanel();
  panels.push(panel);
  document.body.appendChild(panel.getElement());
  return panel;
}

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  // destroy() drops the document and watchlist listeners each panel registers.
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.innerHTML = '';
});

// A relay container that has not polled yet answers enabled with no posts and
// no updatedAt. On 2026-10-27 every dashboard loaded during a relay deploy
// showed "No messages available" for 3 minutes, though the feed was fine.
describe('TelegramIntelPanel during a relay restart', () => {
  it('keeps the connecting state instead of claiming there are no messages', () => {
    const panel = mountPanel();
    panel.setData({ source: 'telegram', earlySignal: true, enabled: true, count: 0, updatedAt: null, items: [] });

    const text = panel.getElement().textContent ?? '';
    expect(text).toContain('Connecting to Telegram relay');
    expect(text).not.toContain('No messages available');
  });

  it('still says there are no messages when a polled relay has none', () => {
    const panel = mountPanel();
    panel.setData({ source: 'telegram', earlySignal: true, enabled: true, count: 0, updatedAt: '2026-10-27T16:08:23.000Z', items: [] });

    expect(panel.getElement().textContent).toContain('No messages available');
  });
});
