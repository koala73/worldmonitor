import { isDesktopRuntime } from '@/services/desktop-runtime';
import { track } from '@/services/analytics';
import { t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';
import { createFocusTrap } from '@/utils/focus-trap';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type InstallOffer = { kind: 'hidden' } | { kind: 'ios' } | { kind: 'native'; event: InstallPromptEvent };
let deferredPrompt: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function isStandalone(): boolean {
  return installed || window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isEmbeddedBrowser(): boolean {
  return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|Twitter|TikTok|Snapchat|; wv\)|\bwv\b|WebView/i.test(navigator.userAgent)
    || window.self !== window.top;
}

function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function needsIosInstall(): boolean {
  return !isDesktopRuntime() && !isStandalone() && !isEmbeddedBrowser() && isIos()
    && /Version\/.*Safari\//.test(navigator.userAgent)
    && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
}

function getOffer(): InstallOffer {
  if (isDesktopRuntime() || isStandalone() || isEmbeddedBrowser()) return { kind: 'hidden' };
  if (needsIosInstall()) return { kind: 'ios' };
  if (!isIos() && deferredPrompt) return { kind: 'native', event: deferredPrompt };
  return { kind: 'hidden' };
}

function notify(): void {
  listeners.forEach(listener => listener());
}

function installIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(name, value);
  const shape = document.createElementNS(svg.namespaceURI, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

export function initPwaInstall(): () => void {
  const onPrompt = (event: Event) => {
    if (isDesktopRuntime() || isStandalone() || isEmbeddedBrowser() || isIos()) return;
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    notify();
  };
  const onInstalled = () => {
    installed = true;
    deferredPrompt = null;
    notify();
    track('pwa-installed');
  };
  const displayMode = window.matchMedia('(display-mode: standalone)');
  window.addEventListener('beforeinstallprompt', onPrompt);
  window.addEventListener('appinstalled', onInstalled);
  displayMode.addEventListener('change', notify);
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt);
    window.removeEventListener('appinstalled', onInstalled);
    displayMode.removeEventListener('change', notify);
    deferredPrompt = null;
    installed = false;
  };
}

export function openIosInstallSheet(): void {
  if (!needsIosInstall() || document.getElementById('pwa-install-sheet')) return;
  const sheet = document.createElement('dialog');
  declareOverlay(sheet, { reload: 'safe' });
  sheet.id = 'pwa-install-sheet';
  sheet.className = 'pwa-install-sheet';
  sheet.setAttribute('aria-labelledby', 'pwa-install-title');
  const header = document.createElement('div');
  header.className = 'pwa-install-header';
  const heading = document.createElement('div');
  const brand = document.createElement('div');
  brand.className = 'pwa-install-brand';
  brand.textContent = 'World Monitor';
  const title = document.createElement('h2');
  title.id = 'pwa-install-title';
  title.textContent = t('pwaInstall.title');
  heading.append(brand, title);
  const dismissButton = document.createElement('button');
  dismissButton.type = 'button';
  dismissButton.className = 'pwa-install-dismiss';
  dismissButton.setAttribute('aria-label', t('pwaInstall.close'));
  dismissButton.append(installIcon('M6 6l12 12M18 6 6 18'));
  header.append(heading, dismissButton);
  const steps = document.createElement('ol');
  steps.className = 'pwa-install-steps';
  steps.setAttribute('role', 'list');
  const stepIcons = [
    ['share', 'M12 15V3m-4 4 4-4 4 4M8 10H5v11h14V10h-3'],
    ['add', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 4v10m-5-5h10'],
    ['confirm', 'm3 10 9-7 9 7M5 9v12h14V9m-10 12v-7h6v7'],
  ] as const;
  for (const [index, [key, path]] of stepIcons.entries()) {
    const step = document.createElement('li');
    const number = document.createElement('span');
    number.className = 'pwa-install-step-number';
    number.setAttribute('aria-hidden', 'true');
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.textContent = t(`pwaInstall.${key}`);
    step.append(number, copy, installIcon(path));
    steps.append(step);
  }
  const footer = document.createElement('div');
  footer.className = 'pwa-install-footer';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pwa-install-done';
  close.autofocus = true;
  close.textContent = t('pwaInstall.close');
  const focusTrap = createFocusTrap(sheet, { initialFocus: close });
  const dismiss = () => {
    sheet.close();
    sheet.remove();
    focusTrap.deactivate();
  };
  dismissButton.addEventListener('click', dismiss);
  close.addEventListener('click', dismiss);
  sheet.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  sheet.addEventListener('keydown', event => event.stopPropagation());
  footer.append(close);
  sheet.append(header, steps, footer);
  document.body.append(sheet);
  focusTrap.activate();
  sheet.showModal();
  track('pwa-ios-sheet-opened');
}

export function mountInstallEntry(container: HTMLElement): () => void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pwa-install-entry';
  const label = document.createElement('span');
  label.textContent = t('pwaInstall.title');
  button.append(installIcon('M12 3v12m-4-4 4 4 4-4M5 17v4h14v-4'), label, installIcon('m9 6 6 6-6 6'));
  let shown = false;
  const recordShown = () => {
    const offer = getOffer();
    if (!shown && offer.kind !== 'hidden') {
      shown = true;
      track('pwa-install-entry-shown', { platform: offer.kind });
    }
  };
  const observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) recordShown();
  });
  const render = () => {
    const offer = getOffer();
    if (offer.kind === 'hidden') {
      button.remove();
      return;
    }
    if (!button.isConnected) {
      container.append(button);
      observer.observe(button);
    }
  };
  const onClick = async () => {
    const offer = getOffer();
    if (offer.kind === 'hidden') return;
    track('pwa-install-clicked', { platform: offer.kind });
    if (offer.kind === 'ios') {
      openIosInstallSheet();
      return;
    }
    // The prompt is single-use, so the entry disappears. Park focus on its
    // container first so a keyboard user does not land on <body>.
    if (document.activeElement === button) {
      container.tabIndex = -1;
      container.focus({ preventScroll: true });
    }
    deferredPrompt = null;
    notify();
    try {
      await offer.event.prompt();
      const { outcome } = await offer.event.userChoice;
      track('pwa-install-outcome', { outcome });
    } catch {
      track('pwa-install-outcome', { outcome: 'error' });
    }
  };
  button.addEventListener('click', onClick);
  listeners.add(render);
  render();
  return () => {
    observer.disconnect();
    listeners.delete(render);
    button.removeEventListener('click', onClick);
    button.remove();
  };
}
