import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
const access = vi.hoisted(() => ({ desktop: true, premium: false }));
vi.mock('@/services/runtime', async () => ({
  ...(await vi.importActual<typeof import('@/services/runtime')>(
    '@/services/runtime',
  )),
  isDesktopRuntime: () => access.desktop,
}));
vi.mock('@/services/panel-gating', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/panel-gating')
  >('@/services/panel-gating');
  return {
    ...actual,
    hasPremiumAccess: () => access.premium,
    getPanelGateReason: (_state: unknown, premium: boolean) =>
      premium && !access.premium
        ? actual.PanelGateReason.FREE_TIER
        : actual.PanelGateReason.NONE,
  };
});
import { PanelLayoutManager } from '@/app/panel-layout';
import { TelegramIntelPanel } from '@/components/TelegramIntelPanel';
import {
  enqueuePanelCall,
  clearAllPendingCalls,
} from '@/app/pending-panel-data';
import { getTelegramIntelGeneration } from '@/services/telegram-intel';
const feed = {
  source: 'telegram',
  earlySignal: true,
  enabled: true,
  count: 0,
  updatedAt: null,
  items: [],
};
const panels: TelegramIntelPanel[] = [];
beforeAll(initTestI18n);
afterEach(() => {
  panels.splice(0).forEach((p) => p.destroy());
  clearAllPendingCalls();
  access.desktop = true;
  access.premium = false;
});
function layout() {
  const manager = Object.create(PanelLayoutManager.prototype);
  manager.ctx = {
    isDesktopApp: access.desktop,
    panels: {},
    isDestroyed: false,
  };
  manager.updateTabCapLock = vi.fn();
  manager.shouldCreatePanel = () => true;
  manager.lazyPanelRegistrations = new Map();
  // Object.create skips field initializers; mirror production defaults used by updatePanelGating.
  manager.gatingPrincipal = undefined;
  manager.premiumPanelsUnlocked = new Set();
  return manager;
}
describe('Telegram layout gating and lazy mount', () => {
  it('keeps desktop Telegram gated on repeated passes and unlocks on current access', () => {
    const manager = layout();
    const p = new TelegramIntelPanel();
    const load = vi.fn();
    p.setAccessGrantedHandler(load);
    panels.push(p);
    manager.ctx.panels['telegram-intel'] = p;
    manager.updatePanelGating({ user: null });
    manager.updatePanelGating({ user: null });
    expect(p.getElement().classList.contains('panel-is-locked')).toBe(true);
    expect(load).not.toHaveBeenCalled();
    access.premium = true;
    manager.updatePanelGating({ user: null });
    expect(p.getElement().classList.contains('panel-is-locked')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    manager.updatePanelGating({ user: null });
    expect(load).toHaveBeenCalledTimes(1);
    access.premium = false;
    manager.updatePanelGating({ user: null });
    expect(p.getElement().classList.contains('panel-is-locked')).toBe(true);
    p.unlockPanel();
    expect(load).toHaveBeenCalledTimes(1);
    access.premium = true;
    p.destroy();
    p.unlockPanel();
    expect(load).toHaveBeenCalledTimes(1);
  });
  it('does not gate free web Telegram', () => {
    access.desktop = false;
    const manager = layout();
    const p = new TelegramIntelPanel();
    panels.push(p);
    manager.ctx.panels['telegram-intel'] = p;
    manager.updatePanelGating({ user: null });
    p.setData(feed);
    expect(p.getElement().classList.contains('panel-is-locked')).toBe(false);
    expect(p.getElement().querySelector('input')!.disabled).toBe(false);
  });
  it.each([false, true])(
    'uses live access after deferred import (premium=%s)',
    async (premium) => {
      const manager = layout();
      access.premium = !premium;
      let resolve!: (panel: TelegramIntelPanel) => void;
      manager.lazyPanel(
        'telegram-intel',
        () =>
          new Promise((ok) => {
            resolve = ok;
          }),
      );
      const loading = manager.lazyPanelRegistrations
        .get('telegram-intel')
        .load();
      access.premium = premium;
      const p = new TelegramIntelPanel();
      panels.push(p);
      resolve(p);
      await loading;
      expect(p.getElement().classList.contains('panel-is-locked')).toBe(
        !premium,
      );
    },
  );
  it('rejects a queued result from before revoke even when the panel mounts after recovery', async () => {
    const manager = layout();
    access.premium = true;
    enqueuePanelCall('telegram-intel', 'setData', [
      feed,
      getTelegramIntelGeneration(),
    ]);
    access.premium = false;
    manager.updatePanelGating({ user: null });
    access.premium = true;
    const p = new TelegramIntelPanel();
    panels.push(p);
    manager.lazyPanel('telegram-intel', async () => p);
    await manager.lazyPanelRegistrations.get('telegram-intel').load();
    expect(p.getElement().querySelector('input')!.disabled).toBe(true);
    p.setData(feed);
    expect(p.getElement().querySelector('input')!.disabled).toBe(false);
  });
});
