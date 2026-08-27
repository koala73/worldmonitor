/**
 * WorldClockPanel keyboard reorder — ArrowUp/ArrowDown on the drag handle.
 *
 * The first implementation rebuilt rows through renderClocks() (150ms
 * setSafeContent debounce) and focused the outgoing handle. Repeated arrows
 * then missed the handle. These tests pin in-place move + focus identity.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorldClockPanel } from '@/components/WorldClockPanel';

import { initTestI18n } from './helpers/i18n.mts';

beforeAll(async () => {
  await initTestI18n();
});

const CONTENT_DEBOUNCE_MS = 150;
const STORAGE_KEY = 'worldmonitor-world-clock-cities';
const SEEDED_CITIES = ['london', 'tokyo', 'sydney'] as const;

let panel: WorldClockPanel;

function content(): HTMLElement {
  return (panel as unknown as { content: HTMLElement }).content;
}

function rows(): HTMLElement[] {
  return Array.from(content().querySelectorAll<HTMLElement>('.wc-row'));
}

function cityIds(): string[] {
  return rows().map((row) => row.dataset.cityId ?? '');
}

function handleFor(cityId: string): HTMLElement | null {
  return content().querySelector<HTMLElement>(`.wc-row[data-city-id="${cityId}"] .wc-drag-handle`);
}

function dispatchArrow(target: HTMLElement, key: 'ArrowUp' | 'ArrowDown'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-05T14:30:00.000Z'));
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...SEEDED_CITIES]));
  panel = new WorldClockPanel();
  document.body.appendChild((panel as unknown as { element: HTMLElement }).element);
  vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
});

afterEach(() => {
  panel.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('WorldClockPanel keyboard reorder', () => {
  it('moves the focused city one slot down and keeps handle focus on the same node', () => {
    const londonHandle = handleFor('london');
    expect(londonHandle).not.toBeNull();
    londonHandle?.focus();
    const beforeHandle = londonHandle as HTMLElement;

    dispatchArrow(beforeHandle, 'ArrowDown');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(cityIds()).toEqual(['tokyo', 'london', 'sydney']);
    expect(handleFor('london')).toBe(beforeHandle);
    expect(document.activeElement).toBe(beforeHandle);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([
      'tokyo',
      'london',
      'sydney',
    ]);
  });

  it('keeps moving the same city on a second ArrowDown without re-tabbing', () => {
    const londonHandle = handleFor('london');
    expect(londonHandle).not.toBeNull();
    londonHandle?.focus();

    dispatchArrow(londonHandle as HTMLElement, 'ArrowDown');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);
    expect(document.activeElement).toBe(londonHandle);

    dispatchArrow(document.activeElement as HTMLElement, 'ArrowDown');
    vi.advanceTimersByTime(CONTENT_DEBOUNCE_MS);

    expect(cityIds()).toEqual(['tokyo', 'sydney', 'london']);
    expect(document.activeElement).toBe(londonHandle);
  });

  it('leaves order unchanged on ArrowDown at the last city and does not preventDefault', () => {
    const sydneyHandle = handleFor('sydney');
    expect(sydneyHandle).not.toBeNull();
    sydneyHandle?.focus();

    const event = dispatchArrow(sydneyHandle as HTMLElement, 'ArrowDown');

    expect(cityIds()).toEqual([...SEEDED_CITIES]);
    expect(event.defaultPrevented).toBe(false);
  });

  it('moves the focused city one slot up', () => {
    const tokyoHandle = handleFor('tokyo');
    expect(tokyoHandle).not.toBeNull();
    tokyoHandle?.focus();

    dispatchArrow(tokyoHandle as HTMLElement, 'ArrowUp');

    expect(cityIds()).toEqual(['tokyo', 'london', 'sydney']);
    expect(document.activeElement).toBe(tokyoHandle);
  });
});
