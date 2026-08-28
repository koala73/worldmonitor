import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dismissMapContextMenu, showMapContextMenu } from '../src/components/MapContextMenu.ts';
import { createBrowserEnvironment, MiniElement, MiniNode } from './helpers/mini-dom.mts';

function withBrowserDom(fn: (rafQueue: FrameRequestCallback[]) => void): void {
  const saved = (['document', 'window', 'Node', 'HTMLElement', 'requestAnimationFrame'] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const browser = createBrowserEnvironment();
  const rafQueue: FrameRequestCallback[] = [];
  const values: Record<string, unknown> = {
    document: browser.document,
    window: browser.window,
    Node: MiniNode,
    HTMLElement: MiniElement,
    requestAnimationFrame(callback: FrameRequestCallback) {
      rafQueue.push(callback);
      return rafQueue.length;
    },
  };

  for (const [name] of saved) {
    Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  }

  try {
    fn(rafQueue);
  } finally {
    dismissMapContextMenu();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

function press(key: string): Event & { defaultPrevented: boolean } {
  const event = Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key });
  document.dispatchEvent(event);
  return event as Event & { defaultPrevented: boolean };
}

function openTwoItemMenu(): { first: HTMLElement; invoker: HTMLElement } {
  const invoker = document.createElement('button');
  invoker.textContent = 'map';
  document.body.appendChild(invoker);
  invoker.focus();
  showMapContextMenu(10, 10, [
    { label: 'Country brief', action() {} },
    { label: 'Copy coordinates', action() {} },
  ]);
  const items = document.querySelectorAll('.map-context-menu-item');
  return {
    first: items[0] as HTMLElement,
    invoker,
  };
}

describe('MapContextMenu keyboard ownership', () => {
  it('does not steal ArrowDown after focus leaves the menu', () => {
    withBrowserDom(() => {
      const { first } = openTwoItemMenu();
      assert.equal(document.activeElement, first);

      const outsider = document.createElement('input');
      document.body.appendChild(outsider);
      outsider.focus();
      assert.equal(document.activeElement, outsider);

      const event = press('ArrowDown');
      assert.equal(event.defaultPrevented, false);
      assert.equal(document.activeElement, outsider);
      assert.ok(document.querySelector('.map-context-menu'));
    });
  });

  it('dismisses on Tab so the document listener does not linger', () => {
    withBrowserDom(() => {
      openTwoItemMenu();
      assert.ok(document.querySelector('.map-context-menu'));

      const event = press('Tab');
      assert.equal(event.defaultPrevented, false);
      assert.equal(document.querySelector('.map-context-menu'), null);

      const outsider = document.createElement('input');
      document.body.appendChild(outsider);
      outsider.focus();
      const later = press('ArrowDown');
      assert.equal(later.defaultPrevented, false);
    });
  });

  it('does not let an Escape-before-rAF click listener dismiss the next menu', () => {
    withBrowserDom((rafQueue) => {
      openTwoItemMenu();
      press('Escape');
      assert.equal(document.querySelector('.map-context-menu'), null);

      while (rafQueue.length > 0) rafQueue.shift()?.(0);

      openTwoItemMenu();
      assert.ok(document.querySelector('.map-context-menu'));
      document.dispatchEvent(new Event('click', { bubbles: true }));
      assert.ok(
        document.querySelector('.map-context-menu'),
        'orphan click listener from the aborted open must not dismiss the new menu before its own rAF listener is armed',
      );
    });
  });
});
