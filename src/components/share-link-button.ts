import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

const SHARE_ICON = trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>', 'Static share icon SVG defined in source');
const COPIED_ICON = trustedHtml('<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>', 'Static check icon SVG defined in source');
export const SHARE_COPIED_MS = 1500;

const pending = new WeakMap<HTMLElement, { timer: ReturnType<typeof setTimeout>; label: string }>();

/** The dashboard's share-link button: a share icon, named by its label for screen readers and on hover. */
export function createShareLinkButton(label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cdp-action-btn cdp-share-btn';
  resetShareLinkButton(button, label);
  return button;
}

/** Puts the share icon and label back, ending any copied confirmation. */
export function resetShareLinkButton(button: HTMLElement, label: string): void {
  const shown = pending.get(button);
  if (shown) clearTimeout(shown.timer);
  pending.delete(button);
  button.setAttribute('aria-label', label);
  button.title = label;
  setTrustedHtml(button, SHARE_ICON);
}

/** Shows a check in place of the share icon for a moment once the link is on the clipboard. */
export function confirmShareLinkCopied(button: HTMLElement, copiedLabel?: string): void {
  const label = pending.get(button)?.label ?? button.getAttribute('aria-label') ?? '';
  const shown = pending.get(button);
  if (shown) clearTimeout(shown.timer);
  pending.set(button, { label, timer: setTimeout(() => resetShareLinkButton(button, label), SHARE_COPIED_MS) });
  if (copiedLabel) {
    button.setAttribute('aria-label', copiedLabel);
    button.title = copiedLabel;
  }
  setTrustedHtml(button, COPIED_ICON);
}
