import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EventHandlerManager } from '@/app/event-handlers';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { SearchModal } from '@/components/SearchModal';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

afterEach(() => {
  document.getElementById('deep-dive-close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  document.getElementById('country-deep-dive-panel')?.remove();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('UI SVG icons replacing missing-glyph Unicode symbols (#11065)', () => {
  it('renders inline SVGs on the Search MAP scope tab, map tip card, and fullscreen command', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const modal = new SearchModal(container);
    modal.open();

    const mapScopeBtn = container.querySelector<HTMLButtonElement>('[data-search-scope="map"]');
    expect(mapScopeBtn).not.toBeNull();
    expect(mapScopeBtn!.querySelector('svg')).not.toBeNull();
    expect(mapScopeBtn!.textContent).not.toContain('\u2316');

    const mapTipIcon = container.querySelector<HTMLElement>('.tip-item .search-result-icon');
    expect(mapTipIcon).not.toBeNull();
    expect(mapTipIcon!.querySelector('svg')).not.toBeNull();
    expect(mapTipIcon!.textContent).not.toContain('\u2316');

    modal.applyQuery('fullscreen');
    const fsCommand = container.querySelector<HTMLElement>('[data-command="view:fullscreen"] .search-result-icon');
    expect(fsCommand).not.toBeNull();
    expect(fsCommand!.querySelector('svg')).not.toBeNull();
    expect(fsCommand!.textContent).not.toContain('\u26F6');

    modal.close();
  });

  it('renders inline SVGs on the Country Brief maximize button and switches between expand and collapse', () => {
    const panel = new CountryDeepDivePanel();
    panel.show('Germany', 'DE', null, null);

    const maxBtn = document.querySelector<HTMLButtonElement>('.cdp-maximize-btn');
    expect(maxBtn).not.toBeNull();
    expect(maxBtn!.querySelector('svg')).not.toBeNull();
    expect(maxBtn!.textContent).not.toContain('\u26F6');
    const expandMarkup = maxBtn!.innerHTML;

    panel.maximize();
    expect(maxBtn!.querySelector('svg')).not.toBeNull();
    expect(maxBtn!.textContent).not.toContain('\u229F');
    const collapseMarkup = maxBtn!.innerHTML;
    expect(collapseMarkup).not.toBe(expandMarkup);

    panel.minimize();
    expect(maxBtn!.innerHTML).toBe(expandMarkup);
  });

  it('toggles distinct expand and collapse SVGs on #fullscreenBtn during fullscreenchange', () => {
    const container = document.createElement('div');
    const button = document.createElement('button');
    button.id = 'fullscreenBtn';
    document.body.append(container, button);

    const manager = new EventHandlerManager({
      container,
      isDesktopApp: false,
      panels: {},
      panelSettings: {},
      mapLayers: {},
      map: { resize: vi.fn(), setIsResizing: vi.fn() },
    } as never, {} as never);
    manager.init();

    try {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: document.documentElement });
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.textContent).not.toContain('\u26F6');
      const exitMarkup = button.innerHTML;

      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      document.dispatchEvent(new Event('fullscreenchange'));
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.textContent).not.toContain('\u26F6');
      const enterMarkup = button.innerHTML;

      expect(exitMarkup).not.toBe(enterMarkup);
    } finally {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      manager.destroy();
    }
  });

  it('contains no raw missing-glyph symbol codepoints in the affected UI modules', () => {
    const files = [
      'src/components/SearchModal.ts',
      'src/components/CountryDeepDivePanel.ts',
      'src/app/panel-layout.ts',
      'src/app/event-handlers.ts',
      'src/config/commands.ts',
    ];
    for (const relPath of files) {
      const src = readFileSync(resolve(process.cwd(), relPath), 'utf8');
      expect(src, `${relPath} should not use U+2316/U+26F6/U+229F`).not.toMatch(/\\u2316|\\u26F6|\\u229F|⌖|⛶|⊟/);
    }
  });
});
