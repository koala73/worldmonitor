import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFocusTrap } from '../src/utils/focus-trap.ts';
import { createBrowserEnvironment, MiniElement, MiniNode } from './helpers/mini-dom.mts';

// The trap reads document.activeElement, moves focus, and listens on document in
// the capture phase. mini-dom models all three; jsdom cannot be used here because
// it reports offsetParent === null for every element, which would make the
// focusable filter return an empty list and pass every assertion vacuously.
function withBrowserDom(fn: () => void): void {
  const saved = (['document', 'Node', 'HTMLElement'] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const browser = createBrowserEnvironment();
  const values: Record<string, unknown> = {
    document: browser.document,
    Node: MiniNode,
    HTMLElement: MiniElement,
  };

  for (const [name] of saved) {
    Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  }

  try {
    fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

type AnyElement = ReturnType<typeof document.createElement>;

function button(label: string): AnyElement {
  const element = document.createElement('button');
  element.textContent = label;
  return element;
}

/** An overlay with three focusable children, appended to the document by default. */
function overlay(options: { connected?: boolean } = {}): {
  container: AnyElement;
  first: AnyElement;
  middle: AnyElement;
  last: AnyElement;
} {
  const container = document.createElement('div');
  const first = button('first');
  const middle = button('middle');
  const last = button('last');
  container.append(first, middle, last);
  if (options.connected !== false) document.body.appendChild(container);
  return { container, first, middle, last };
}

function press(key: string, init: { shiftKey?: boolean } = {}): Event & { defaultPrevented: boolean } {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key,
    shiftKey: init.shiftKey ?? false,
  });
  document.dispatchEvent(event);
  return event as Event & { defaultPrevented: boolean };
}

describe('focus-trap activate', () => {
  it('focuses the requested element, resolving a callback', () => {
    withBrowserDom(() => {
      const { container, middle } = overlay();
      createFocusTrap(container, { initialFocus: () => middle }).activate();

      assert.equal(document.activeElement, middle);
    });
  });

  it('falls back to the first focusable child when no initial focus is requested', () => {
    withBrowserDom(() => {
      const { container, first } = overlay();
      createFocusTrap(container).activate();

      assert.equal(document.activeElement, first);
    });
  });

  it('falls back to the container when it holds nothing focusable', () => {
    withBrowserDom(() => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      createFocusTrap(container).activate();

      assert.equal(document.activeElement, container);
    });
  });

  it('is idempotent, so a re-entrant open does not overwrite the recorded opener', () => {
    withBrowserDom(() => {
      const opener = button('opener');
      document.body.appendChild(opener);
      opener.focus();
      const { container } = overlay();

      const trap = createFocusTrap(container);
      trap.activate();
      trap.activate();
      trap.deactivate();

      assert.equal(document.activeElement, opener);
    });
  });

  it('includes form controls in the cycle', () => {
    withBrowserDom(() => {
      const container = document.createElement('div');
      const input = document.createElement('input');
      const trailing = button('trailing');
      container.append(input, trailing);
      document.body.appendChild(container);

      createFocusTrap(container).activate();

      assert.equal(document.activeElement, input);
    });
  });
});

describe('focus-trap Tab containment', () => {
  it('wraps from the last focusable to the first', () => {
    withBrowserDom(() => {
      const { container, first, last } = overlay();
      createFocusTrap(container, { initialFocus: () => last }).activate();

      const event = press('Tab');

      assert.equal(document.activeElement, first);
      assert.equal(event.defaultPrevented, true);
    });
  });

  it('wraps backwards from the first focusable to the last', () => {
    withBrowserDom(() => {
      const { container, first, last } = overlay();
      createFocusTrap(container, { initialFocus: () => first }).activate();

      const event = press('Tab', { shiftKey: true });

      assert.equal(document.activeElement, last);
      assert.equal(event.defaultPrevented, true);
    });
  });

  it('leaves Tab alone in the middle of the cycle so the browser advances normally', () => {
    withBrowserDom(() => {
      const { container, middle } = overlay();
      createFocusTrap(container, { initialFocus: () => middle }).activate();

      const event = press('Tab');

      assert.equal(document.activeElement, middle);
      assert.equal(event.defaultPrevented, false);
    });
  });

  it('pulls focus back in when it has fallen to the body', () => {
    withBrowserDom(() => {
      const { container, first } = overlay();
      createFocusTrap(container).activate();
      document.body.focus();

      press('Tab');

      assert.equal(document.activeElement, first);
    });
  });

  it('leaves Tab alone when a container it does not manage holds focus', () => {
    withBrowserDom(() => {
      const { container } = overlay();
      const foreign = overlay();
      createFocusTrap(container).activate();
      foreign.middle.focus();

      const event = press('Tab');

      assert.equal(document.activeElement, foreign.middle);
      assert.equal(event.defaultPrevented, false);
    });
  });

  it('leaves Tab alone when its container has nothing focusable left', () => {
    withBrowserDom(() => {
      // Detached from the document, so every child reports offsetParent === null --
      // the shape a teardown path leaves behind. Swallowing Tab here would strand
      // the whole page with no reachable focus target.
      const { container } = overlay({ connected: false });
      createFocusTrap(container).activate();
      document.body.focus();

      const event = press('Tab');

      assert.equal(document.activeElement, document.body);
      assert.equal(event.defaultPrevented, false);
    });
  });
});

describe('focus-trap Escape', () => {
  it('calls onEscape and stops the event', () => {
    withBrowserDom(() => {
      const { container } = overlay();
      let closed = 0;
      createFocusTrap(container, { onEscape: () => { closed += 1; } }).activate();

      const event = press('Escape');

      assert.equal(closed, 1);
      assert.equal(event.defaultPrevented, true);
    });
  });

  it('leaves Escape alone when no handler was supplied', () => {
    withBrowserDom(() => {
      const { container } = overlay();
      createFocusTrap(container).activate();

      const event = press('Escape');

      assert.equal(event.defaultPrevented, false);
    });
  });
});

describe('focus-trap stacking', () => {
  it('gives Tab to the most recently activated trap', () => {
    withBrowserDom(() => {
      const lower = overlay();
      const upper = overlay();
      createFocusTrap(lower.container).activate();
      createFocusTrap(upper.container).activate();
      document.body.focus();

      press('Tab');

      assert.equal(document.activeElement, upper.first);
    });
  });

  it('gives Escape to the most recently activated trap only', () => {
    withBrowserDom(() => {
      const lower = overlay();
      const upper = overlay();
      let lowerClosed = 0;
      let upperClosed = 0;
      createFocusTrap(lower.container, { onEscape: () => { lowerClosed += 1; } }).activate();
      createFocusTrap(upper.container, { onEscape: () => { upperClosed += 1; } }).activate();
      document.body.focus();

      press('Escape');

      assert.equal(upperClosed, 1);
      assert.equal(lowerClosed, 0);
    });
  });

  it('hands the keyboard back to the trap underneath once the top one closes', () => {
    withBrowserDom(() => {
      const lower = overlay();
      const upper = overlay();
      const lowerTrap = createFocusTrap(lower.container);
      const upperTrap = createFocusTrap(upper.container);
      lowerTrap.activate();
      upperTrap.activate();
      upperTrap.deactivate({ restoreFocus: false });
      document.body.focus();

      press('Tab');

      assert.equal(document.activeElement, lower.first);
    });
  });
});

describe('focus-trap deactivate', () => {
  it('restores focus to the element that was focused on activate', () => {
    withBrowserDom(() => {
      const opener = button('opener');
      document.body.appendChild(opener);
      opener.focus();
      const { container } = overlay();

      const trap = createFocusTrap(container);
      trap.activate();
      trap.deactivate();

      assert.equal(document.activeElement, opener);
    });
  });

  it('skips the restore when asked to leave focus alone', () => {
    withBrowserDom(() => {
      const opener = button('opener');
      document.body.appendChild(opener);
      opener.focus();
      const { container, first } = overlay();

      const trap = createFocusTrap(container);
      trap.activate();
      trap.deactivate({ restoreFocus: false });

      assert.equal(document.activeElement, first);
    });
  });

  it('skips the restore when the opener has left the document', () => {
    withBrowserDom(() => {
      const opener = button('opener');
      document.body.appendChild(opener);
      opener.focus();
      const { container, first } = overlay();

      const trap = createFocusTrap(container);
      trap.activate();
      opener.remove();
      trap.deactivate();

      assert.equal(document.activeElement, first);
    });
  });

  it('releases the document listener so Tab is no longer contained', () => {
    withBrowserDom(() => {
      const { container, last } = overlay();
      const trap = createFocusTrap(container);
      trap.activate();
      trap.deactivate({ restoreFocus: false });
      last.focus();

      const event = press('Tab');

      assert.equal(document.activeElement, last);
      assert.equal(event.defaultPrevented, false);
    });
  });

  it('is a no-op when called twice', () => {
    withBrowserDom(() => {
      const opener = button('opener');
      document.body.appendChild(opener);
      opener.focus();
      const { container, first } = overlay();

      const trap = createFocusTrap(container);
      trap.activate();
      trap.deactivate();
      first.focus();
      trap.deactivate();

      assert.equal(document.activeElement, first);
    });
  });
});
