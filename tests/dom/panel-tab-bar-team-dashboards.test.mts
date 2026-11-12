import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PanelTabBar, tabCapGateCopy, type TeamDashboardCallbacks, type TeamDashboardsView } from '@/components/PanelTabBar';
import { PanelGateReason } from '@/services/panel-gating';
import type { PanelTab, TabsState } from '@/services/tab-store';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

function tab(id: string, name: string): PanelTab {
  return { id, name, panelSettings: {}, panelOrder: [], bottomSet: [] };
}

let state: TabsState;
let view: TeamDashboardsView | null;
let bar: PanelTabBar;
let team: { [K in keyof TeamDashboardCallbacks]: Mock<TeamDashboardCallbacks[K]> };

const teamBtn = () => bar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-team');
const popover = () => document.getElementById('dashboard-team-dashboards');
const texts = () => Array.from(popover()?.querySelectorAll('p') ?? []).map((p) => p.textContent);
const openButtons = () => Array.from(popover()?.querySelectorAll<HTMLButtonElement>('.team-dashboards-open') ?? []);
const stopButtons = () => Array.from(popover()?.querySelectorAll<HTMLButtonElement>('.team-dashboards-stop') ?? []);
const actions = () => Array.from(popover()?.querySelectorAll<HTMLButtonElement>('.tab-cap-notice-action') ?? []);

const GULF = { id: 'd1', name: 'Gulf watch' };
const MARKETS = { id: 'd2', name: 'Markets desk' };

beforeEach(() => {
  document.body.replaceChildren();
  state = { activeTabId: 'a', tabs: [tab('a', 'Main')] };
  view = { dashboards: [GULF, MARKETS], active: null, busy: false };
  team = {
    view: vi.fn(() => view),
    onOpenMenu: vi.fn(),
    onOpen: vi.fn(),
    onShareTab: vi.fn(),
    onUpdateTab: vi.fn(),
    onStopSharing: vi.fn(),
  };
  bar = new PanelTabBar(() => state, {
    onSelect: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    hasNewTabPanels: () => false,
    onSaveNewTabPanels: vi.fn(),
    onClearNewTabPanels: vi.fn(),
    team,
  });
  document.body.appendChild(bar.getElement());
});

afterEach(() => {
  bar.destroy();
  document.body.replaceChildren();
});

describe('PanelTabBar team button', () => {
  it('shows only while the user has a team, beside the other bar actions and outside the tablist', () => {
    const btn = teamBtn()!;
    expect(btn.getAttribute('aria-label')).toBe('Team dashboards');
    expect(btn.textContent).toBe('Team');
    expect(btn.closest('[role="tablist"]')).toBeNull();
    expect(btn.previousElementSibling?.classList.contains('dashboard-tab-options')).toBe(true);

    view = null;
    bar.refresh();
    expect(teamBtn()).toBeNull();
  });

  it('keeps keyboard focus on the bar buttons when the bar re-renders', () => {
    teamBtn()!.focus();
    bar.refresh();
    expect(document.activeElement).toBe(teamBtn());

    const options = bar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-options')!;
    options.focus();
    bar.refresh();
    expect(document.activeElement).toBe(options);
  });

  it('is absent for a bar built without team callbacks', () => {
    bar.destroy();
    bar = new PanelTabBar(() => state, {
      onSelect: vi.fn(), onAdd: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
      hasNewTabPanels: () => false, onSaveNewTabPanels: vi.fn(), onClearNewTabPanels: vi.fn(),
    });
    document.body.appendChild(bar.getElement());
    expect(teamBtn()).toBeNull();
  });
});

describe('PanelTabBar team menu', () => {
  it('lists the team dashboards, asks for a fresh list and offers to share this tab', () => {
    teamBtn()!.click();

    expect(popover()!.parentElement).toBe(document.body);
    expect(team.onOpenMenu).toHaveBeenCalledTimes(1);
    expect(teamBtn()!.getAttribute('aria-expanded')).toBe('true');
    expect(teamBtn()!.getAttribute('aria-controls')).toBe('dashboard-team-dashboards');
    expect(openButtons().map((b) => b.textContent)).toEqual(['Gulf watch', 'Markets desk']);
    expect(openButtons()[0]!.getAttribute('aria-label')).toBe('Open Gulf watch as a new tab');
    expect(stopButtons()[1]!.getAttribute('aria-label')).toBe('Stop sharing Markets desk');
    expect(actions().map((b) => b.textContent)).toEqual(['Share this tab with your team']);
    expect(document.activeElement).toBe(openButtons()[0]);
  });

  it('opens a dashboard and closes, returning focus to the button', () => {
    teamBtn()!.click();
    openButtons()[1]!.click();

    expect(team.onOpen).toHaveBeenCalledWith('d2');
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(teamBtn());
  });

  it('keeps the tab limit notice when opening a dashboard runs into the cap', () => {
    bar.setAddLock({ copy: tabCapGateCopy(PanelGateReason.FREE_TIER, 3), onAction: vi.fn() });
    team.onOpen.mockImplementation(() => bar.showAddLockNotice());
    teamBtn()!.click();
    openButtons()[0]!.click();

    expect(popover()).toBeNull();
    const notice = document.querySelector('.tab-cap-notice');
    expect(notice).not.toBeNull();
    expect(document.activeElement).toBe(notice!.querySelector('.tab-cap-notice-cta'));
  });

  it('shares the tab and stops sharing a dashboard', () => {
    teamBtn()!.click();
    actions()[0]!.click();
    stopButtons()[0]!.click();

    expect(team.onShareTab).toHaveBeenCalledTimes(1);
    expect(team.onStopSharing).toHaveBeenCalledWith('d1');
  });

  it('explains an empty team and still offers to share', () => {
    view = { dashboards: [], active: null, busy: false };
    teamBtn()!.click();

    expect(texts()[0]).toMatch(/hasn't shared a dashboard yet/);
    expect(popover()!.querySelector('.team-dashboards-list')).toBeNull();
    expect(document.activeElement).toBe(actions()[0]);
  });

  it('marks the dashboard the active tab came from and offers to share its changes', () => {
    view = { dashboards: [GULF, MARKETS], active: { id: 'd1', behind: false }, busy: false };
    teamBtn()!.click();

    expect(openButtons()[0]!.getAttribute('aria-current')).toBe('true');
    expect(openButtons()[1]!.hasAttribute('aria-current')).toBe(false);
    expect(actions().map((b) => b.textContent)).toEqual(["Share this tab's changes with your team"]);
  });

  it('offers the latest version when the team changed the dashboard since this tab opened it', () => {
    view = { dashboards: [GULF], active: { id: 'd1', behind: true }, busy: false };
    teamBtn()!.click();

    expect(texts()).toContain('Your team changed this dashboard after you opened it.');
    const latest = actions().find((b) => b.textContent === 'Get the latest version')!;
    latest.click();
    expect(team.onUpdateTab).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
  });

  it('disables sharing and removal while a call is in flight, and follows the list as it changes', () => {
    teamBtn()!.click();
    actions()[0]!.focus();

    view = { dashboards: [GULF, MARKETS], active: null, busy: true };
    bar.refresh();
    expect(actions()[0]!.disabled).toBe(true);
    expect(stopButtons().every((b) => b.disabled)).toBe(true);
    // Focus left the disabled button for the first control still usable.
    expect(document.activeElement).toBe(openButtons()[0]);

    view = { dashboards: [GULF, MARKETS, { id: 'd3', name: 'Africa' }], active: null, busy: false };
    bar.refresh();
    expect(openButtons().map((b) => b.textContent)).toEqual(['Gulf watch', 'Markets desk', 'Africa']);
    expect(popover()).not.toBeNull();
  });

  it('closes when the team goes away while it is open', () => {
    teamBtn()!.click();

    view = null;
    bar.refresh();

    expect(popover()).toBeNull();
    expect(teamBtn()).toBeNull();
  });

  it('closes on Escape and on a second click, and gives way to the new tab options', () => {
    teamBtn()!.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(teamBtn());

    teamBtn()!.click();
    teamBtn()!.click();
    expect(popover()).toBeNull();

    teamBtn()!.click();
    bar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-options')!.click();
    expect(popover()).toBeNull();
    expect(document.getElementById('dashboard-tab-options')).not.toBeNull();
    expect(teamBtn()!.getAttribute('aria-expanded')).toBe('false');
  });
});
