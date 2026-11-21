import { scheduleAfterFirstPaint } from '../../src/utils/after-paint';

export function registerWelcomeServiceWorker(): void {
  try {
    if (!navigator.serviceWorker) return;
  } catch {
    return;
  }

  scheduleAfterFirstPaint(async () => {
    try {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (error) {
      console.warn('[PWA] Service worker registration failed:', error);
    }
  });
}
