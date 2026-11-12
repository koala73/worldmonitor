import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Clicks the quote-row arrows (`VoiceCards` in pro-test/src/components/Voices.tsx)
// against a row with a fixed layout, in LTR and in RTL. In RTL (ar, fa) browsers
// report scrollLeft from 0 down to negative values, so an LTR-only
// implementation leaves "next" unable to move the row.

vi.mock('../../pro-test/src/i18n', () => ({ t: (key: string) => key }));

// Variable specifiers keep tsconfig.dom-tests.json (no `jsx` setting) from
// type-checking pro-test's TSX graph, and load pro-test's own React copy.
const VOICES = '../../pro-test/src/components/Voices.tsx';
const proRequire = createRequire(resolve('pro-test/package.json'));
const REACT = proRequire.resolve('react');
const REACT_DOM_CLIENT = proRequire.resolve('react-dom/client');

const CLIENT_WIDTH = 300;
const SCROLL_WIDTH = 1000;
const MAX_SCROLL = SCROLL_WIDTH - CLIENT_WIDTH;

/** Gives the row a layout and an instant, clamped scrollBy like a browser's. */
function layOut(row: HTMLElement, direction: 'ltr' | 'rtl'): void {
  let position = 0;
  Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => CLIENT_WIDTH });
  Object.defineProperty(row, 'scrollWidth', { configurable: true, get: () => SCROLL_WIDTH });
  Object.defineProperty(row, 'scrollLeft', {
    configurable: true,
    get: () => position,
    set: (value: number) => {
      position = direction === 'rtl' ? Math.min(0, Math.max(-MAX_SCROLL, value)) : Math.max(0, Math.min(MAX_SCROLL, value));
      row.dispatchEvent(new Event('scroll'));
    },
  });
  row.scrollBy = ((options: ScrollToOptions) => { row.scrollLeft = position + (options.left ?? 0); }) as typeof row.scrollBy;
}

let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  document.body.replaceChildren();
  document.documentElement.removeAttribute('dir');
});

async function renderRow(direction: 'ltr' | 'rtl') {
  document.documentElement.setAttribute('dir', direction);
  const { act, createElement } = await import(/* @vite-ignore */ REACT);
  const { createRoot } = await import(/* @vite-ignore */ REACT_DOM_CLIENT);
  const { VoiceCards } = await import(/* @vite-ignore */ VOICES);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const host = document.createElement('div');
  host.setAttribute('dir', direction);
  host.style.direction = direction;
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(VoiceCards)));
  unmount = () => act(() => root.unmount());

  const row = host.querySelector('ul') as HTMLUListElement;
  const buttons = [...host.querySelectorAll('button')];
  expect(buttons).toHaveLength(2);
  const prev = buttons[0] as HTMLButtonElement;
  const next = buttons[1] as HTMLButtonElement;
  layOut(row, direction);
  await act(async () => { row.dispatchEvent(new Event('scroll')); });
  const click = (button: HTMLButtonElement) => act(async () => { button.click(); });
  return { row, prev, next, click };
}

describe('quote row arrows', () => {
  it.each(['ltr', 'rtl'] as const)('page to the end and back in %s', async (direction) => {
    const { row, prev, next, click } = await renderRow(direction);
    expect(prev.disabled, 'previous starts disabled').toBe(true);
    expect(next.disabled, 'next starts enabled').toBe(false);

    for (let i = 0; i < 5 && !next.disabled; i++) await click(next);
    expect(Math.abs(row.scrollLeft), 'next reaches the end').toBe(MAX_SCROLL);
    expect(next.disabled, 'next disables at the end').toBe(true);
    expect(prev.disabled).toBe(false);

    for (let i = 0; i < 5 && !prev.disabled; i++) await click(prev);
    expect(row.scrollLeft === 0, 'previous returns to the start').toBe(true);
    expect(prev.disabled, 'previous disables at the start').toBe(true);
    expect(next.disabled).toBe(false);
  });

  it('updates both arrows when the row is swiped instead of clicked', async () => {
    const { row, prev, next } = await renderRow('rtl');
    const { act } = await import(/* @vite-ignore */ REACT);
    await act(async () => { row.scrollLeft = -MAX_SCROLL; });
    expect(next.disabled).toBe(true);
    expect(prev.disabled).toBe(false);
  });
});
