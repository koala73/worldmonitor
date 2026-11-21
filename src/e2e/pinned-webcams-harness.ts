import '../styles/main.css';
import { initI18n } from '@/services/i18n';
import { PinnedWebcamsPanel } from '@/components/PinnedWebcamsPanel';
import { pinWebcam } from '@/services/webcams/pinned-store';
import { importSettings } from '@/utils/settings-persistence';

declare global {
  interface Window {
    __pinnedWebcamsHarness?: { ready: boolean };
  }
}

// page.goto waits for the load event, which does not wait for the top-level await
// below. On a slow locale fetch a spec could pick a file before the import listener
// existed, and the import was lost. Specs wait for `ready`, set after every listener.
window.__pinnedWebcamsHarness = { ready: false };
await initI18n({ waitForFullTranslation: true });
const panel = new PinnedWebcamsPanel();
Object.assign(panel.getElement().style, { width: '100%', height: '620px', marginTop: '16px' });
document.getElementById('webcam-fixture')!.appendChild(panel.getElement());
panel.notifyConnected();
document.getElementById('pin')!.addEventListener('click', () => {
  pinWebcam({ webcamId: '789', title: 'Provider fallback camera', lat: 25, lng: 55, country: 'AE', category: 'city', playerUrl: 'https://example.org/canary' });
});
document.getElementById('import')!.addEventListener('change', async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await importSettings(file);
  requestAnimationFrame(() => { panel.refresh(); document.getElementById('status')!.textContent = 'Imported and read'; });
});
window.addEventListener('pagehide', () => panel.destroy(), { once: true });
window.__pinnedWebcamsHarness.ready = true;
