import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';
import { TeamDashboardsStore } from '@/services/team-dashboards-store';
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
import { Panel } from '@/components/Panel';
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
  manager.deferredPanelMounts = new Map();
  manager.staticallyLockedPanels = new Set();
  manager.team = new TeamDashboardsStore({ load: async () => null, onChange: () => {} });
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
  // A panel registered with lockedFeatures loads locked outside the gating
  // pass; its shell must reserve the same one-row footprint, or the panels
  // below it move up when it mounts.
  it('marks the shell of a statically locked lazy panel as locked', () => {
    const manager = layout();
    const grid = document.createElement('div');
    manager.ctx.panelSettings = { 'x-intel': { name: 'X Intel', enabled: true } };
    manager.insertByOrder = (g: HTMLElement, el: HTMLElement) => g.append(el);
    manager.observeDeferredPanelShell = () => {};
    manager.lazyPanel('x-intel', async () => null, undefined, ['feature']);
    manager.deferPanelMount('x-intel', null, grid, true);
    const shell = grid.querySelector('[data-panel="x-intel"]')!;
    expect(shell.classList.contains('panel-is-locked')).toBe(true);
    manager.updatePanelGating({ user: null });
    expect(shell.classList.contains('panel-is-locked')).toBe(true);
  });
  // x-intel is not a gated panel, so its gate verdict is NONE. A gating pass
  // must not lift its static lock: that would unlock it for a non-premium
  // desktop user and leave its shell and panel in different lock states.
  it('keeps a statically locked lazy panel locked through a gating pass', async () => {
    const manager = layout();
    const p = new Panel({ id: 'x-intel', title: 'X Intel' });
    manager.lazyPanel('x-intel', async () => p, undefined, ['feature']);
    await manager.lazyPanelRegistrations.get('x-intel').load();
    expect(p.getElement().classList.contains('panel-is-locked')).toBe(true);
    manager.updatePanelGating({ user: null });
    expect(p.getElement().classList.contains('panel-is-locked')).toBe(true);
    p.destroy();
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
