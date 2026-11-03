/**
 * Clerk's modal renders internal steps as real anchors whose href is a
 * virtual-router path (`/CLERK-ROUTER/VIRTUAL/sign-in/factor-one`). Clerk's
 * React handler cancels the click and routes inside the modal. When an
 * extension (1Password's passkey prompt) stops the click before it reaches
 * React, the browser follows the href to a 404. The guard cancels only the
 * default navigation and leaves propagation alone, so Clerk still routes
 * whenever it receives the click.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { installClerkVirtualLinkGuard } from '@/services/clerk';

const VIRTUAL_HREF = 'https://www.worldmonitor.app/CLERK-ROUTER/VIRTUAL/sign-in/factor-one';

let uninstall: (() => void) | undefined;
const cleanups: Array<() => void> = [];

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
  document.body.replaceChildren();
});

function link(href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = href;
  const span = document.createElement('span');
  span.textContent = 'Use another method';
  a.appendChild(span);
  document.body.appendChild(a);
  return a;
}

function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe('installClerkVirtualLinkGuard', () => {
  it('cancels the navigation when something stops the click before Clerk sees it', () => {
    uninstall = installClerkVirtualLinkGuard(window);
    const swallow = (e: Event) => e.stopPropagation();
    document.addEventListener('click', swallow, true);
    cleanups.push(() => document.removeEventListener('click', swallow, true));

    const event = click(link(VIRTUAL_HREF).firstElementChild!);

    expect(event.defaultPrevented).toBe(true);
  });

  it('still delivers the click to Clerk’s own handler', () => {
    uninstall = installClerkVirtualLinkGuard(window);
    const a = link(VIRTUAL_HREF);
    let clerkHandled = false;
    a.addEventListener('click', () => { clerkHandled = true; });

    click(a);

    expect(clerkHandled).toBe(true);
  });

  it('leaves ordinary links alone', () => {
    uninstall = installClerkVirtualLinkGuard(window);

    const event = click(link('https://www.worldmonitor.app/pro'));

    expect(event.defaultPrevented).toBe(false);
  });
});
