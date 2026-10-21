import '../styles/main.css';
import { ChinaActivityNowcastPanel } from '@/components/ChinaActivityNowcastPanel';
import {
  CHINA_ACTIVITY_PROXY_REGISTRY,
  evaluateChinaActivityNowcast,
  type ChinaActivityOfficialObservation,
  type ChinaActivityProxyObservation,
} from '../../shared/china-activity-nowcast';

declare global {
  interface Window {
    __chinaActivityNowcastHarness?: { ready: boolean };
  }
}

const evaluatedAt = '2026-07-25T12:00:00.000Z';
const official: ChinaActivityOfficialObservation = {
  seriesId: 'nbs_industrial_value_added_yoy',
  label: '<script>unsafe official label</script>',
  vintageId: 'nbs_industrial_value_added_yoy:2026-06:r1',
  observationPeriod: '2026-06',
  periodEnd: '2026-06-30T23:59:59.000Z',
  releaseTime: '2026-07-17T02:00:00.000Z',
  retrievalTime: '2026-07-17T02:05:00.000Z',
  direction: 'strengthening',
  value: 6.8,
  unit: '%',
  available: true,
  stale: false,
  provenance: { signalId: 'signal:official' },
};
const proxy = (
  seriesId: string,
  value: number,
): ChinaActivityProxyObservation => ({
  seriesId,
  observationId: `${seriesId}:current`,
  observedAt: '2026-07-25T10:00:00.000Z',
  releasedAt: '2026-07-25T10:30:00.000Z',
  retrievedAt: '2026-07-25T10:35:00.000Z',
  value,
  priorValue: null,
  available: true,
  stale: false,
  structuralBreak: false,
  provenance: { source: seriesId },
});
const response = evaluateChinaActivityNowcast({
  evaluatedAt,
  officialObservations: [official],
  proxyObservations: [
    proxy(CHINA_ACTIVITY_PROXY_REGISTRY[0]!.id, 1),
    proxy(CHINA_ACTIVITY_PROXY_REGISTRY[1]!.id, 1),
    proxy(CHINA_ACTIVITY_PROXY_REGISTRY[2]!.id, 1),
    proxy(CHINA_ACTIVITY_PROXY_REGISTRY[4]!.id, 1),
  ],
});
response.limitations[0] = '<img src=x onerror=alert(1)> unsafe limitation';

const app = document.getElementById('app');
if (!app) throw new Error('Missing #app');
window.__chinaActivityNowcastHarness = { ready: false };
const panel = new ChinaActivityNowcastPanel();
app.appendChild(panel.getElement());
panel.notifyConnected();
panel.setData(response);
window.__chinaActivityNowcastHarness.ready = true;
