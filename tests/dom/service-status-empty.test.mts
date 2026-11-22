import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import { fetchServiceStatuses } from '@/services/infrastructure';
import { initTestI18n, tt } from './helpers/i18n.mts';
vi.mock('@/services/infrastructure', () => ({ fetchServiceStatuses: vi.fn() }));
beforeAll(initTestI18n);
let panel: ServiceStatusPanel;
afterEach(() => { panel?.destroy(); document.body.replaceChildren(); });
it('shows unavailable, then observed operational status, retains last-good, then neutral empty category', async () => {
  panel = new ServiceStatusPanel(); document.body.append(panel.getElement());
  vi.mocked(fetchServiceStatuses).mockResolvedValue({success:true,timestamp:'',summary:{operational:0,degraded:0,outage:0,unknown:0},services:[]});
  await panel.fetchStatus();
  expect(document.body.textContent).toContain(tt('common.failedToLoad'));
  expect(document.querySelector('.all-operational')).toBeNull();
  vi.mocked(fetchServiceStatuses).mockResolvedValue({success:true,timestamp:'',summary:{operational:1,degraded:0,outage:0,unknown:0},services:[{id:'aws',name:'AWS',category:'cloud',status:'operational',description:''}]});
  await panel.fetchStatus();
  expect(document.querySelector('.all-operational')).not.toBeNull();
  vi.mocked(fetchServiceStatuses).mockResolvedValue({success:true,timestamp:'',summary:{operational:0,degraded:0,outage:0,unknown:0},services:[]});
  await panel.fetchStatus();
  expect(document.querySelector('.all-operational')).not.toBeNull();
  expect(document.body.textContent).toContain('AWS');
  (document.querySelector('[data-filter="ai"]') as HTMLButtonElement).click();
  expect(document.querySelector('.all-operational')).toBeNull();
  expect(document.body.textContent).toContain(tt('common.noDataAvailable'));
});

it('leaves rendered services untouched and logs nothing when a refresh signal aborts', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    panel = new ServiceStatusPanel(); document.body.append(panel.getElement());
    vi.mocked(fetchServiceStatuses).mockResolvedValueOnce({
      success: true, timestamp: '', summary: { operational: 1, degraded: 0, outage: 0, unknown: 0 },
      services: [{ id: 'aws', name: 'AWS', category: 'cloud', status: 'operational', description: '' }],
    });
    await panel.fetchStatus();
    expect(document.body.textContent).toContain('AWS');

    const controller = new AbortController();
    vi.mocked(fetchServiceStatuses).mockImplementationOnce((sig?: AbortSignal) => new Promise((_resolve, reject) => {
      sig?.addEventListener('abort', () => reject(sig.reason ?? new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const pending = panel.fetchStatus(controller.signal);
    controller.abort(new DOMException('Refresh lane lease expired', 'AbortError'));
    const changed = await pending;

    expect(changed).toBe(false);
    expect(document.body.textContent).toContain('AWS');
    expect(document.body.textContent).not.toContain(tt('common.failedToLoad'));
    expect(errorSpy).not.toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});
