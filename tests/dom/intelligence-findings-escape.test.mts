/**
 * Escape closes the Intelligence Findings dropdown, as it closes every other
 * header popover. Dogfood found it stayed open until a click elsewhere.
 */
import { afterEach, beforeAll, expect, it } from 'vitest';
import { IntelligenceFindingsBadge } from '@/components/IntelligenceGapBadge';
import { initTestI18n } from './helpers/i18n.mts';

let findings: IntelligenceFindingsBadge | null = null;

beforeAll(initTestI18n);
afterEach(() => {
  findings?.destroy();
  findings = null;
  document.body.replaceChildren();
});

function openFindings() {
  const headerRight = document.createElement('div');
  headerRight.className = 'header-right';
  document.body.append(headerRight);
  findings = new IntelligenceFindingsBadge();
  const badge = headerRight.querySelector<HTMLButtonElement>('.intel-findings-badge')!;
  const dropdown = badge.querySelector('.intel-findings-dropdown')!;
  badge.click();
  expect(dropdown.classList.contains('open')).toBe(true);
  return { badge, dropdown };
}

const escapeKey = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

it('closes the open findings dropdown on Escape and returns focus to the badge', () => {
  const { badge, dropdown } = openFindings();

  document.dispatchEvent(escapeKey());
  expect(dropdown.classList.contains('open')).toBe(false);
  expect(document.activeElement).toBe(badge);

  // A later Escape, with the dropdown closed, is left to whoever owns it.
  const later = escapeKey();
  document.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});

it('leaves an Escape that another control already handled, such as Search', () => {
  const { dropdown } = openFindings();
  const handled = escapeKey();
  handled.preventDefault();
  document.dispatchEvent(handled);
  expect(dropdown.classList.contains('open')).toBe(true);
});

it('removes its Escape listener when destroyed while open', () => {
  openFindings();
  findings!.destroy();
  findings = null;
  const later = escapeKey();
  document.dispatchEvent(later);
  expect(later.defaultPrevented).toBe(false);
});
