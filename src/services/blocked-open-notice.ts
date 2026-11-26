/**
 * Shown when the browser refused a new tab for a caller that must not leave
 * the page (`openExternalUrl(..., { sameTabFallback: false })`). Without it
 * the click did nothing (Sentry WORLDMONITOR-1ED).
 *
 * The URL is offered as a real link. An anchor click is a fresh navigation
 * the user chose, which popup blockers allow, and on a browser with no tabs
 * at all (a games console) it is the only way to the page.
 *
 * Kept apart from `external-navigation.ts`, which loads it on demand: that
 * module runs under the plain tsx test runner, and `./i18n` needs Vite.
 */

import { t } from './i18n';

const NOTICE_MS = 8000;

let hideTimer: ReturnType<typeof setTimeout> | undefined;

function siteName(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function showBlockedOpenNotice(url: string): void {
  const host = siteName(url);
  if (!host || !document.body) return;

  // One notice at a time, shared with showToast: a second blocked click
  // replaces the first instead of stacking.
  document.querySelector('.toast-notification')?.remove();
  clearTimeout(hideTimer);

  const el = document.createElement('div');
  el.className = 'toast-notification toast-notification--action';
  el.setAttribute('role', 'status');

  const text = document.createElement('span');
  text.textContent = t('components.externalNavigation.blocked');

  const link = document.createElement('a');
  link.className = 'toast-notification-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  // The UTM interceptor (src/utils/utm.ts) turns external `_blank` clicks
  // into `window.open`, the call the browser just refused. An anchor with a
  // referrer policy is left to the browser's own navigation.
  link.referrerPolicy = 'no-referrer';
  link.textContent = t('components.externalNavigation.openLink', { host });
  // Removed on the next task, not inside the listener: an anchor taken out
  // of the document during its own click no longer navigates.
  link.addEventListener('click', () => {
    clearTimeout(hideTimer);
    setTimeout(() => el.remove(), 0);
  });

  el.append(text, ' ', link);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  hideTimer = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, NOTICE_MS);
}
