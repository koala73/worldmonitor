/**
 * The breaking-alerts switch in the Intelligence Findings dropdown tells the
 * reader when their change could not be saved. Without a message the switch
 * just stayed where it was after the click, which reads as a dead control.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

const SETTINGS_KEY = 'wm-breaking-alerts-v1';

/** Own the store: happy-dom's localStorage does not route through Storage.prototype. */
class MemoryStorage {
  readonly store = new Map<string, string>();
  failWritesFor: string | null = null;
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (key === this.failWritesFor) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.store.set(key, String(value));
  }
  removeItem(key: string): void { this.store.delete(key); }
  clear(): void { this.store.clear(); }
  key(index: number): string | null { return [...this.store.keys()][index] ?? null; }
  get length(): number { return this.store.size; }
}

const storage = new MemoryStorage();
let destroy: (() => void) | null = null;

beforeAll(initTestI18n);
beforeEach(() => {
  storage.store.clear();
  storage.failWritesFor = null;
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
});
afterEach(() => {
  destroy?.();
  destroy = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function openFindings() {
  const { IntelligenceFindingsBadge } = await import('@/components/IntelligenceGapBadge');
  const headerRight = document.createElement('div');
  headerRight.className = 'header-right';
  document.body.append(headerRight);
  const findings = new IntelligenceFindingsBadge();
  destroy = () => findings.destroy();
  const badge = headerRight.querySelector<HTMLButtonElement>('.intel-findings-badge')!;
  badge.click();
  const dropdown = badge.querySelector<HTMLElement>('.intel-findings-dropdown')!;
  // Opening runs an async update() that renders the toggle rows.
  await vi.waitFor(() => expect(breakingRow(dropdown)).not.toBeNull());
  return dropdown;
}

const breakingRow = (dropdown: HTMLElement) =>
  dropdown.querySelector<HTMLElement>('[data-toggle="breaking-alerts"]')!;
const breakingSwitchOn = (dropdown: HTMLElement) =>
  breakingRow(dropdown).querySelector('.popup-toggle-switch')!.classList.contains('on');
const saveError = (dropdown: HTMLElement) =>
  dropdown.querySelector<HTMLElement>('[data-breaking-alerts-save-error]');

it('says the change was not saved when storage rejects it, and keeps the switch on', async () => {
  storage.failWritesFor = SETTINGS_KEY;
  const dropdown = await openFindings();
  expect(breakingSwitchOn(dropdown)).toBe(true);

  breakingRow(dropdown).click();

  expect(breakingSwitchOn(dropdown)).toBe(true);
  const error = saveError(dropdown);
  expect(error).not.toBeNull();
  expect(error!.getAttribute('role')).toBe('alert');
  expect(error!.textContent).toContain("Couldn't save this change");
});

it('clears the message once a later change is saved', async () => {
  storage.failWritesFor = SETTINGS_KEY;
  const dropdown = await openFindings();
  breakingRow(dropdown).click();
  expect(saveError(dropdown)).not.toBeNull();

  storage.failWritesFor = null;
  breakingRow(dropdown).click();

  expect(breakingSwitchOn(dropdown)).toBe(false);
  expect(saveError(dropdown)).toBeNull();
  expect(JSON.parse(storage.store.get(SETTINGS_KEY)!).enabled).toBe(false);
});

it('shows no message when the change is saved', async () => {
  const dropdown = await openFindings();
  breakingRow(dropdown).click();
  expect(breakingSwitchOn(dropdown)).toBe(false);
  expect(saveError(dropdown)).toBeNull();
});
