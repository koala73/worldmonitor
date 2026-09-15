import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DiseaseOutbreaksPanel } from '@/components/DiseaseOutbreaksPanel';
import { MapPopup } from '@/components/MapPopup';
import { fetchDiseaseOutbreaks } from '@/services/disease-outbreaks';
import { getCableHealthRecord } from '@/services/cable-health';
import { initTestI18n, tt } from './helpers/i18n.mts';

vi.mock('@/services/disease-outbreaks', () => ({ fetchDiseaseOutbreaks: vi.fn() }));
vi.mock('@/services/cable-health', () => ({ getCableHealthRecord: vi.fn() }));
beforeAll(initTestI18n);
let panel: DiseaseOutbreaksPanel | undefined;
let popup: MapPopup | undefined;
afterEach(() => { panel?.destroy(); popup?.hide(); document.body.replaceChildren(); });

describe('failure-state displays', () => {
  it('distinguishes unavailable outbreaks from confirmed empty and clears old rows', async () => {
    panel = new DiseaseOutbreaksPanel();
    document.body.append(panel.getElement());
    vi.mocked(fetchDiseaseOutbreaks).mockResolvedValue({ outbreaks: [], fetchedAt: 0, alertLevelMethodologyVersion: 'v1' });
    expect(await panel.fetchData()).toBe(false);
    expect(document.body.textContent).toContain(tt('components.diseaseOutbreaks.errors.noData'));
    panel.updateData([{ id: 'test', disease: 'Test cholera', location: 'Test region', countryCode: 'US', alertLevel: 'alert', publishedAt: 1, summary: '', sourceUrl: '', sourceName: 'Test', lat: 0, lng: 0, cases: 0 }]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Test cholera'));
    expect(await panel.fetchData()).toBe(false);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Test cholera'));
    vi.mocked(fetchDiseaseOutbreaks).mockResolvedValue({ outbreaks: [], fetchedAt: Date.now(), alertLevelMethodologyVersion: 'v1' });
    expect(await panel.fetchData()).toBe(true);
    await vi.waitFor(() => expect(document.body.textContent).not.toContain('Test cholera'));
    await vi.waitFor(() => expect(document.body.textContent).toContain(tt('components.diseaseOutbreaks.empty')));
    expect(document.body.textContent).not.toContain(tt('components.diseaseOutbreaks.errors.noData'));
  });

  it('does not label a cable active without a health record', () => {
    const container = document.createElement('div');
    document.body.append(container);
    popup = new MapPopup(container);
    vi.mocked(getCableHealthRecord).mockReturnValue(undefined);
    popup.show({ type: 'cable', data: { id: 'test-cable', name: 'Test cable', points: [[0, 0], [1, 1]], major: true }, x: 100, y: 100 });
    expect(document.querySelector('.map-popup')?.textContent).toContain(tt('popups.unknown'));
    expect(document.querySelector('.map-popup')?.textContent).not.toContain(tt('popups.cable.active'));
  });
});
