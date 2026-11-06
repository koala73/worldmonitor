import { scheduleAfterFirstPaint } from '../../src/utils/after-paint';

export function registerWelcomeServiceWorker(): void {
  let container: ServiceWorkerContainer | undefined;
  try {
    container = navigator.serviceWorker;
  } catch {
    return;
  }
  if (!container) return;

  scheduleAfterFirstPaint(async () => {
    try {
      await container.register('/sw.js', { scope: '/' });
    } catch (error) {
      console.warn('[PWA] Service worker registration failed:', error);
    }
  });
}
