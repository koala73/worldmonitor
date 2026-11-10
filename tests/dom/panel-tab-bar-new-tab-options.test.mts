import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { PanelTabBar, tabCapGateCopy, type TabAddLock } from '@/components/PanelTabBar';
import { PanelGateReason } from '@/services/panel-gating';
import type { PanelTab, TabsState } from '@/services/tab-store';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

function tab(id: string, name: string): PanelTab {
  return { id, name, panelSettings: {}, panelOrder: [], bottomSet: [] };
}

function lockFor(reason: PanelGateReason): TabAddLock {
  return { copy: tabCapGateCopy(reason, 3), onAction: vi.fn<() => void>() };
}

let state: TabsState;
let saved: boolean;
let bar: PanelTabBar;
let callbacks: {
  onSelect: Mock<(tabId: string) => void>;
  onAdd: Mock<() => void>;
  onRename: Mock<(tabId: string, name: string) => void>;
  onDelete: Mock<(tabId: string) => void>;
  hasNewTabPanels: Mock<() => boolean>;
  onSaveNewTabPanels: Mock<() => void>;
  onClearNewTabPanels: Mock<() => void>;
};

const optionsBtn = () => bar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-options')!;
const addBtn = () => bar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-add')!;
const popover = () => document.getElementById('dashboard-tab-options');
const popoverText = () => Array.from(popover()?.querySelectorAll('p') ?? []).map((p) => p.textContent);
const actions = () => Array.from(popover()?.querySelectorAll<HTMLButtonElement>('button') ?? []);
const action = (label: string) => actions().find((b) => b.textContent === label)!;

beforeEach(() => {
  document.body.replaceChildren();
  state = { activeTabId: 'a', tabs: [tab('a', 'Main'), tab('b', 'Markets')] };
  saved = false;
  callbacks = {
    onSelect: vi.fn<(tabId: string) => void>(),
    onAdd: vi.fn<() => void>(),
    onRename: vi.fn<(tabId: string, name: string) => void>(),
    onDelete: vi.fn<(tabId: string) => void>(),
    hasNewTabPanels: vi.fn<() => boolean>(() => saved),
    onSaveNewTabPanels: vi.fn<() => void>(),
    onClearNewTabPanels: vi.fn<() => void>(),
  };
  bar = new PanelTabBar(() => state, callbacks);
  document.body.appendChild(bar.getElement());
});

afterEach(() => {
  bar.destroy();
  document.body.replaceChildren();
});

describe('PanelTabBar new tab options button', () => {
  it('sits in the bar beside "+", outside the tablist, named "New tab options"', () => {
    const btn = optionsBtn();
    expect(btn.parentElement).toBe(bar.getElement());
    expect(btn.closest('[role="tablist"]')).toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('New tab options');
    expect(btn.previousElementSibling).toBe(addBtn());
    expect(bar.getElement().querySelectorAll(':scope > .dashboard-tab-add')).toHaveLength(1);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('titles "+" by whether saved panels are in use', () => {
    expect(addBtn().title).toBe('New tab (starts with the default panels)');
    saved = true;
    bar.refresh();
    expect(addBtn().title).toBe('New tab (starts with the panels you saved)');
  });
});

describe('PanelTabBar new tab options popover', () => {
  it('offers to save the current tab when nothing is saved', () => {
    optionsBtn().click();

    expect(popover()!.parentElement).toBe(document.body);
    expect(popoverText()).toEqual(['New tabs start with the default panels.', "Tabs you already have don't change."]);
    expect(actions().map((b) => b.textContent)).toEqual(["Use this tab's panels"]);
    expect(document.activeElement).toBe(action("Use this tab's panels"));

    action("Use this tab's panels").click();

    expect(callbacks.onSaveNewTabPanels).toHaveBeenCalledTimes(1);
    expect(callbacks.onClearNewTabPanels).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('offers to go back to the default panels once panels are saved', () => {
    saved = true;
    optionsBtn().click();

    expect(popoverText()[0]).toBe('New tabs start with the panels you saved.');
    expect(actions().map((b) => b.textContent)).toEqual(["Use this tab's panels", 'Use the default panels']);

    action('Use the default panels').click();

    expect(callbacks.onClearNewTabPanels).toHaveBeenCalledTimes(1);
    expect(callbacks.onSaveNewTabPanels).not.toHaveBeenCalled();
    expect(popover()).toBeNull();
  });

  it('closes on Escape and returns focus to the options button', () => {
    optionsBtn().click();
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(optionsBtn());
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('points aria-controls at the popover only while the popover exists', () => {
    expect(optionsBtn().hasAttribute('aria-controls')).toBe(false);

    optionsBtn().click();
    const controlled = document.getElementById(optionsBtn().getAttribute('aria-controls') ?? '');
    expect(controlled).toBe(popover());

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(optionsBtn().hasAttribute('aria-controls')).toBe(false);
  });

  it('closes on an outside mousedown but not on one inside it or on its button', () => {
    optionsBtn().click();

    popover()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    optionsBtn().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popover()).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(popover()).toBeNull();
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a second click of its button', () => {
    optionsBtn().click();
    optionsBtn().click();

    expect(popover()).toBeNull();
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open and anchored across a re-render of the bar', () => {
    optionsBtn().click();
    const btn = optionsBtn();

    bar.refresh();

    expect(optionsBtn()).toBe(btn);
    expect(popover()).not.toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('is removed by destroy()', () => {
    optionsBtn().click();

    bar.destroy();

    expect(popover()).toBeNull();
  });
});

describe('PanelTabBar new tab options with the tab cap', () => {
  it('still opens while "+" is cap-locked', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));

    optionsBtn().click();

    expect(popover()).not.toBeNull();
  });

  it('gives way to the lock notice when the locked "+" is clicked', () => {
    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    callbacks.onAdd.mockImplementation(() => bar.showAddLockNotice());
    optionsBtn().click();

    addBtn().click();

    expect(popover()).toBeNull();
    expect(document.querySelectorAll('.tab-cap-notice')).toHaveLength(1);
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('false');
  });

  it('a lock change closes the cap notice but not the options popover', () => {
    bar.setAddLock(lockFor(PanelGateReason.ANONYMOUS));
    optionsBtn().click();

    bar.setAddLock(lockFor(PanelGateReason.FREE_TIER));
    expect(popover()).not.toBeNull();

    bar.setAddLock(null);
    expect(popover()).not.toBeNull();
    expect(optionsBtn().getAttribute('aria-expanded')).toBe('true');
  });
});
