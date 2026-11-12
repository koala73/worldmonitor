/**
 * Dashboard focus (#10453): the focus bar on a focused tab, and the editor
 * dialog that sets a focus.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import i18next from 'i18next';

import { FocusBar, type FocusBarCallbacks } from '@/components/FocusBar';
import { focusCountryName, focusGateCopy, focusWindowText } from '@/components/focus-format';
import { openFocusEditor, validateFocusDraft, type FocusEditorHandle } from '@/components/FocusEditor';
import { PanelTabBar } from '@/components/PanelTabBar';
import { PanelGateReason } from '@/services/panel-gating';
import type { ResolvedScope } from '@/services/tab-focus';
import type { TabsState } from '@/services/tab-store';
import { RELOAD_POLICY_ATTR } from '@/utils/open-modal';
import type { TabScope } from '../../shared/tab-scope';
import { resolveScope } from '../../shared/tab-scope-resolve';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

function resolved(scope: TabScope): ResolvedScope {
  return { scope, ...resolveScope(scope) };
}

const SEA: TabScope = { countries: ['TH', 'VN', 'ID'], neighbours: true, start: '2026-11-14', end: '2026-11-18' };
const DURING = new Date('2026-11-15T12:00:00Z');
const AFTER = new Date('2026-11-20T12:00:00Z');
const BEFORE = new Date('2026-11-01T12:00:00Z');

let now: Date;
let bar: FocusBar;
let callbacks: { [K in 'onEdit' | 'onClear']: Mock<FocusBarCallbacks[K]> };

const root = () => bar.getElement();
const q = <T extends HTMLElement = HTMLElement>(sel: string) => root().querySelector<T>(sel);

beforeEach(() => {
  document.body.replaceChildren();
  now = DURING;
  callbacks = { onEdit: vi.fn(), onClear: vi.fn() };
  bar = new FocusBar(callbacks, () => now);
  document.body.appendChild(bar.getElement());
});

afterEach(() => {
  bar.destroy();
  document.body.replaceChildren();
});

describe('FocusBar', () => {
  it('is hidden without a focus', () => {
    bar.render(null);
    expect(root().hidden).toBe(true);
  });

  it('names the chosen countries and summarises the neighbours', () => {
    const r = resolved(SEA);
    bar.render(r);
    expect(root().hidden).toBe(false);
    expect(root().getAttribute('aria-label')).toBe('Focus');
    expect(q('.focus-bar-summary')?.textContent).toBe('Focused on Thailand, Vietnam, Indonesia');
    const toggle = q<HTMLButtonElement>('.focus-bar-neighbours-toggle')!;
    expect(toggle.textContent).toBe(`+ ${r.neighbours.length} neighbours`);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands to a list that keeps chosen countries and neighbours apart', () => {
    const r = resolved(SEA);
    bar.render(r);
    const toggle = q<HTMLButtonElement>('.focus-bar-neighbours-toggle')!;
    const details = q('.focus-bar-details')!;
    expect(details.hidden).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(details.id);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.hidden).toBe(false);
    const chosen = Array.from(details.querySelectorAll('.focus-bar-country.chosen')).map((el) => el.textContent);
    const neighbours = Array.from(details.querySelectorAll('.focus-bar-country.neighbour')).map((el) => el.textContent);
    expect(chosen).toEqual(['Thailand', 'Vietnam', 'Indonesia']);
    expect(neighbours).toHaveLength(r.neighbours.length);
    expect(neighbours).toContain('Laos');
    expect(details.querySelector('.focus-bar-country.neighbour')?.getAttribute('aria-label')).toMatch(/^Neighbour: /);

    toggle.click();
    expect(details.hidden).toBe(true);
  });

  it('keeps the list open across a re-render of the same tab', () => {
    bar.render(resolved(SEA));
    q<HTMLButtonElement>('.focus-bar-neighbours-toggle')!.click();
    bar.render(resolved(SEA));
    expect(q('.focus-bar-details')!.hidden).toBe(false);
  });

  it('singular neighbour, and says when neighbours are switched off', () => {
    bar.render(resolved({ countries: ['PT'], neighbours: true }));
    expect(q('.focus-bar-neighbours-toggle')?.textContent).toBe('+ 1 neighbour');

    bar.render(resolved({ countries: ['TH'], neighbours: false }));
    expect(q('.focus-bar-neighbours-toggle')).toBeNull();
    expect(q('.focus-bar-neighbours-off')?.textContent).toBe('Neighbours not included');
  });

  it('shows the date window while it is open', () => {
    bar.render(resolved(SEA));
    const win = q('.focus-bar-window')!;
    expect(win.textContent).toMatch(/14/);
    expect(win.textContent).toMatch(/18/);
    expect(win.classList.contains('ended')).toBe(false);
  });

  it.each([
    [{ start: '2027-11-14' }, /Starts.*2027/],
    [{ end: '2025-11-14' }, /Window ended.*2025/],
    [{ start: '2025-11-14' }, /From.*2025/],
    [{ end: '2027-11-14' }, /Until.*2027/],
    [{ start: '2026-01-01', end: '2027-01-01' }, /2026.*2027/],
  ])('includes years outside the current year and on both sides of a cross-year range: %j', (dates, expected) => {
    expect(focusWindowText({ countries: ['TH'], neighbours: false, ...dates }, DURING)?.text).toMatch(expected);
  });

  it('keeps a same-year window concise and uses the supplied UTC year', () => {
    expect(focusWindowText(SEA, DURING)?.text).not.toMatch(/2026/);
    expect(focusWindowText({ countries: ['TH'], neighbours: false, end: '2026-01-01' },
      new Date('2025-12-31T23:30:00-02:00'))?.text).not.toMatch(/2026/);
  });

  it('keeps both years in the range fallback', () => {
    const prototype = Intl.DateTimeFormat.prototype as Intl.DateTimeFormat & { formatRange(start: Date, end: Date): string };
    vi.spyOn(prototype, 'formatRange').mockImplementation(() => { throw new Error('unsupported'); });
    expect(focusWindowText({ countries: ['TH'], neighbours: false, start: '2026-01-01', end: '2027-01-01' }, DURING)?.text)
      .toMatch(/2026.*2027/);
  });

  it('says the window ended without hiding anything', () => {
    now = AFTER;
    bar.render(resolved(SEA));
    const win = q('.focus-bar-window')!;
    expect(win.textContent).toMatch(/^Window ended .*18/);
    expect(win.classList.contains('ended')).toBe(true);
    expect(root().hidden).toBe(false);
    expect(q('.focus-bar-summary')?.textContent).toBe('Focused on Thailand, Vietnam, Indonesia');
  });

  it('redraws the window status at the next UTC midnight and when the page becomes visible again', () => {
    vi.useFakeTimers();
    try {
      now = new Date('2026-11-18T23:59:00Z');
      bar.render(resolved(SEA));
      expect(q('.focus-bar-window')?.textContent).not.toMatch(/ended/);
      now = new Date('2026-11-19T00:00:30Z');
      vi.advanceTimersByTime(61_000);
      expect(q('.focus-bar-window')?.textContent).toMatch(/^Window ended/);

      now = BEFORE; // tab left open, clock moved: a visibility change re-reads it
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(q('.focus-bar-window')?.textContent).toMatch(/^Starts/);

      bar.destroy();
      now = AFTER;
      vi.advanceTimersByTime(48 * 3600_000);
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('says when an upcoming window starts', () => {
    now = BEFORE;
    bar.render(resolved(SEA));
    expect(q('.focus-bar-window')?.textContent).toMatch(/^Starts .*14/);
  });

  it('shows no window for a focus without dates', () => {
    bar.render(resolved({ countries: ['TH'], neighbours: true }));
    expect(q('.focus-bar-window')).toBeNull();
  });

  it('calls back on edit and clear', () => {
    bar.render(resolved(SEA));
    q<HTMLButtonElement>('.focus-bar-edit')!.click();
    q<HTMLButtonElement>('.focus-bar-clear')!.click();
    expect(callbacks.onEdit).toHaveBeenCalledTimes(1);
    expect(callbacks.onClear).toHaveBeenCalledTimes(1);
  });

  describe('keyboard focus across a redraw', () => {
    function barWith(onDraft: () => void): FocusBar {
      bar.destroy();
      document.body.replaceChildren();
      bar = new FocusBar({ onEdit: vi.fn(), onClear: vi.fn(), canDraftAssessment: () => true, onDraftAssessment: onDraft }, () => now);
      document.body.appendChild(bar.getElement());
      return bar;
    }

    it.each([['focus-bar-edit'], ['focus-bar-clear'], ['focus-bar-draft']])('keeps focus on %s when the bar redraws', (cls) => {
      barWith(vi.fn()).render(resolved(SEA));
      q<HTMLButtonElement>(`.${cls}`)!.focus();
      expect(document.activeElement?.classList.contains(cls)).toBe(true);
      bar.render(resolved(SEA));
      expect(document.activeElement).toBe(q(`.${cls}`));
    });

    it('leaves focus alone when no action had it', () => {
      barWith(vi.fn()).render(resolved(SEA));
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      outside.focus();
      bar.render(resolved(SEA));
      expect(document.activeElement).toBe(outside);
    });
  });

  describe('draft assessment action (#10451 hand-off)', () => {
    const draft = () => q<HTMLButtonElement>('.focus-bar-draft');

    function barWith(canDraft: (() => boolean) | undefined, onDraft: () => void): FocusBar {
      bar.destroy();
      document.body.replaceChildren();
      bar = new FocusBar({ onEdit: vi.fn(), onClear: vi.fn(), canDraftAssessment: canDraft, onDraftAssessment: onDraft }, () => now);
      document.body.appendChild(bar.getElement());
      return bar;
    }

    it('is absent when the bar was given no hand-off', () => {
      bar.render(resolved(SEA));
      expect(draft()).toBeNull();
    });

    it('is absent for an account that may not draft', () => {
      barWith(() => false, vi.fn()).render(resolved(SEA));
      expect(draft()).toBeNull();
    });

    it('is a labelled button for an account that may, and calls back once per click', () => {
      const onDraft = vi.fn();
      barWith(() => true, onDraft).render(resolved(SEA));
      expect(draft()!.textContent).toBe('Draft assessment');
      expect(draft()!.getAttribute('aria-label')).toBe('Open the trip assessment, prefilled with this focus');
      draft()!.click();
      expect(onDraft).toHaveBeenCalledTimes(1);
    });

    it('sits before Edit so the report action leads the focus actions', () => {
      barWith(() => true, vi.fn()).render(resolved(SEA));
      const labels = [...root().querySelectorAll('.focus-bar-actions button')].map((b) => b.className);
      expect(labels[0]).toContain('focus-bar-draft');
      expect(labels[1]).toContain('focus-bar-edit');
    });

    it('follows the plan at the next render, so a lapsed grant removes it', () => {
      let allowed = true;
      barWith(() => allowed, vi.fn()).render(resolved(SEA));
      expect(draft()).not.toBeNull();
      allowed = false;
      bar.render(resolved(SEA));
      expect(draft()).toBeNull();
    });
  });

  it('shows the upgrade gate inline for an account without focus', () => {
    bar.render(resolved(SEA));
    const onAction = vi.fn();
    bar.showGate(focusGateCopy(PanelGateReason.FREE_TIER), onAction);
    const gate = q('.focus-bar-gate')!;
    expect(gate.textContent).toContain('Pro Business');
    const cta = gate.querySelector<HTMLButtonElement>('.focus-bar-gate-cta')!;
    expect(document.activeElement).toBe(cta);
    cta.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(q('.focus-bar-gate')).toBeNull();
  });
});

describe('focusGateCopy', () => {
  it('asks a signed-out visitor to sign in and a signed-in one to upgrade', () => {
    expect(focusGateCopy(PanelGateReason.ANONYMOUS).cta).toBe('Sign In to Unlock');
    const upgrade = focusGateCopy(PanelGateReason.FREE_TIER);
    expect(upgrade.desc).toContain('Pro Business');
    expect(upgrade.cta).not.toBe('');
  });

  it('never upsells a customer whose payment is on hold', () => {
    expect(focusGateCopy(PanelGateReason.PAYMENT_ON_HOLD).desc).not.toContain('Pro Business');
  });
});

describe('validateFocusDraft', () => {
  it('needs at least one country', () => {
    expect(validateFocusDraft({ countries: [], neighbours: true, start: '', end: '' })).toEqual({ error: 'focus.errorNoCountries' });
  });

  it('refuses more than 12 countries', () => {
    const countries = ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA', 'MM', 'BN', 'TL', 'CN', 'IN'];
    expect(validateFocusDraft({ countries, neighbours: true, start: '', end: '' })).toEqual({ error: 'focus.errorTooMany' });
  });

  it('refuses an end before the start', () => {
    expect(validateFocusDraft({ countries: ['TH'], neighbours: true, start: '2026-11-18', end: '2026-11-14' }))
      .toEqual({ error: 'focus.errorDates' });
  });

  it('returns a normalized scope with optional dates', () => {
    expect(validateFocusDraft({ countries: ['TH'], neighbours: false, start: '', end: '2026-11-18' }))
      .toEqual({ scope: { countries: ['TH'], neighbours: false, end: '2026-11-18' } });
  });
});

describe('openFocusEditor', () => {
  let editor: FocusEditorHandle | null = null;
  let onSave: Mock<(scope: TabScope) => void>;
  let onClear: Mock<() => void>;

  const dialog = () => document.querySelector<HTMLElement>('.focus-editor-overlay');
  const d = <T extends HTMLElement = HTMLElement>(sel: string) => dialog()!.querySelector<T>(sel);
  const search = (value: string) => {
    const input = d<HTMLInputElement>('.focus-editor-search')!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const results = () => Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('.focus-editor-result'));
  const chips = () => Array.from(dialog()!.querySelectorAll<HTMLElement>('.focus-editor-chip')).map((c) => c.dataset.code);

  beforeEach(() => {
    onSave = vi.fn();
    onClear = vi.fn();
  });

  afterEach(() => {
    editor?.close();
    editor = null;
  });

  it('is a labelled modal dialog that declares it blocks reloads', () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    const el = dialog()!;
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
    expect(el.getAttribute(RELOAD_POLICY_ATTR)).toBe('blocking');
    const labelledBy = el.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('Focus this tab');
    expect(document.activeElement).toBe(d('.focus-editor-search'));
  });

  it('searches countries by name and adds them', () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    search('thai');
    expect(results().map((b) => b.dataset.code)).toEqual(['TH']);
    results()[0]!.click();
    expect(chips()).toEqual(['TH']);
    expect(d('.focus-editor-count')?.textContent).toBe('1 of 12');
  });

  it('rebuilds search names after a language change even when Andorra stays the same', async () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    search('Germany');
    expect(results().map((r) => r.textContent).join(' ')).toContain('Germany');
    const firstName = focusCountryName('AD');
    try {
      await i18next.changeLanguage('es');
      expect(focusCountryName('AD')).toBe(firstName);
      editor.close();
      editor = openFocusEditor({ initial: null, onSave, onClear });
      search('Alemania');
      expect(results().map((r) => r.textContent).join(' ')).toContain('Alemania');
      search('Germany');
      expect(results().map((r) => r.textContent).join(' ')).toContain('Alemania');
    } finally {
      await i18next.changeLanguage('en');
    }
  });

  it('defaults to including neighbours and saves the scope', () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    search('vietnam');
    results()[0]!.click();
    expect(d<HTMLInputElement>('.focus-editor-neighbours')!.checked).toBe(true);
    d<HTMLButtonElement>('.focus-editor-save')!.click();
    expect(onSave).toHaveBeenCalledWith({ countries: ['VN'], neighbours: true });
    expect(dialog()).toBeNull();
  });

  it('shows a validation message instead of saving nothing', () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    d<HTMLButtonElement>('.focus-editor-save')!.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(d('.focus-editor-error')?.textContent).toBe('Choose at least one country.');
  });

  it('stops adding at 12 countries and says why', () => {
    const twelve = ['TH', 'VN', 'ID', 'MY', 'SG', 'PH', 'KH', 'LA', 'MM', 'BN', 'TL', 'CN'];
    editor = openFocusEditor({ initial: { countries: twelve, neighbours: true }, onSave, onClear });
    expect(d('.focus-editor-count')?.textContent).toBe('12 of 12');
    expect(d<HTMLInputElement>('.focus-editor-search')!.disabled).toBe(true);
    expect(d('.focus-editor-limit')?.hidden).toBe(false);
    d<HTMLButtonElement>('.focus-editor-chip-remove')!.click();
    expect(d('.focus-editor-count')?.textContent).toBe('11 of 12');
    expect(d<HTMLInputElement>('.focus-editor-search')!.disabled).toBe(false);
  });

  it('edits an existing focus, with Clear and Cancel', () => {
    editor = openFocusEditor({ initial: SEA, onSave, onClear });
    expect(document.getElementById(dialog()!.getAttribute('aria-labelledby')!)?.textContent).toBe('Edit focus');
    expect(chips()).toEqual(['TH', 'VN', 'ID']);
    expect(d<HTMLInputElement>('.focus-editor-start')!.value).toBe('2026-11-14');
    d<HTMLButtonElement>('.focus-editor-clear')!.click();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();

    editor = openFocusEditor({ initial: SEA, onSave, onClear });
    d<HTMLButtonElement>('.focus-editor-cancel')!.click();
    expect(onSave).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it('has no Clear button when starting a new focus', () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    expect(d('.focus-editor-clear')).toBeNull();
  });

  it('closes on Escape', () => {
    editor = openFocusEditor({ initial: null, onSave, onClear });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
  });
});

describe('PanelTabBar Focus button', () => {
  let tabBar: PanelTabBar;
  let focused: boolean;
  let onClick: Mock<() => void>;
  const state: TabsState = { activeTabId: 'a', tabs: [{ id: 'a', name: 'Main', panelSettings: {}, panelOrder: [], bottomSet: [] }] };
  const btn = () => tabBar.getElement().querySelector<HTMLButtonElement>('.dashboard-tab-focus');

  beforeEach(() => {
    focused = false;
    onClick = vi.fn();
    tabBar = new PanelTabBar(() => state, {
      onSelect: vi.fn(),
      onAdd: vi.fn(),
      onRename: vi.fn(),
      onDelete: vi.fn(),
      hasNewTabPanels: () => false,
      onSaveNewTabPanels: vi.fn(),
      onClearNewTabPanels: vi.fn(),
      focus: { isFocused: () => focused, onClick },
    });
    document.body.appendChild(tabBar.getElement());
  });

  afterEach(() => {
    tabBar.destroy();
  });

  it('starts a focus on an unfocused tab and edits it on a focused one', () => {
    expect(btn()?.textContent).toBe('Focus');
    expect(btn()?.getAttribute('aria-label')).toBe('Focus this tab on chosen countries');
    btn()!.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    focused = true;
    tabBar.refresh();
    expect(btn()?.classList.contains('active')).toBe(true);
    expect(btn()?.getAttribute('aria-label')).toBe("Edit this tab's focus");
  });

  it('shows the upgrade notice for an account without focus, and a second click closes it', () => {
    const onAction = vi.fn();
    tabBar.showFocusGateNotice(focusGateCopy(PanelGateReason.FREE_TIER), onAction);
    const notice = document.querySelector('.tab-cap-notice');
    expect(notice?.textContent).toContain('Pro Business');
    expect(document.activeElement).toBe(notice?.querySelector('.tab-cap-notice-cta'));

    btn()!.click();
    expect(document.querySelector('.tab-cap-notice')).toBeNull();
    expect(onClick).not.toHaveBeenCalled();

    tabBar.showFocusGateNotice(focusGateCopy(PanelGateReason.FREE_TIER), onAction);
    document.querySelector<HTMLButtonElement>('.tab-cap-notice-cta')!.click();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('has no Focus button without focus callbacks', () => {
    tabBar.destroy();
    tabBar = new PanelTabBar(() => state, {
      onSelect: vi.fn(), onAdd: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(),
      hasNewTabPanels: () => false, onSaveNewTabPanels: vi.fn(), onClearNewTabPanels: vi.fn(),
    });
    expect(btn()).toBeNull();
  });
});
