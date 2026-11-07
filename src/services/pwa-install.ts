import { isDesktopRuntime } from '@/services/desktop-runtime';
import { track } from '@/services/analytics';
import { t } from '@/services/i18n';
import { declareOverlay } from '@/utils/open-modal';

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
  const opener = document.activeElement as HTMLElement | null;
  const sheet = document.createElement('dialog');
  declareOverlay(sheet, { reload: 'safe' });
  sheet.id = 'pwa-install-sheet';
  sheet.className = 'pwa-install-sheet';
  sheet.setAttribute('aria-labelledby', 'pwa-install-title');
  const title = document.createElement('h2');
  title.id = 'pwa-install-title';
  title.textContent = t('pwaInstall.title');
  const steps = document.createElement('ol');
  for (const key of ['share', 'add', 'confirm']) {
    const step = document.createElement('li');
    step.textContent = t(`pwaInstall.${key}`);
    steps.append(step);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-secondary';
  close.textContent = t('pwaInstall.close');
  const dismiss = () => {
    sheet.close();
    sheet.remove();
    if (opener?.isConnected) opener.focus();
  };
  close.addEventListener('click', dismiss);
  sheet.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  sheet.addEventListener('keydown', event => event.stopPropagation());
  sheet.append(title, steps, close);
  document.body.append(sheet);
  sheet.showModal();
  track('pwa-ios-sheet-opened');
}

export function mountInstallEntry(container: HTMLElement): () => void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-secondary pwa-install-entry';
  button.textContent = t('pwaInstall.title');
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
