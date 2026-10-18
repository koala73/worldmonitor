import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
import { CountrySectionError } from '@/services/country-brief-error';
import { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';
import { initTestI18n } from './helpers/i18n.mts';
import {
  __resetPipelineRegistryStoreForTests as resetPipelines,
  __setBootstrapReaderForTests as setPipelineBootstrap,
  __setOnDemandLoaderForTests as setPipelineLoader,
  ensurePipelineRegistriesHydrated,
} from '@/shared/pipeline-registry-store';
import {
  __resetStorageFacilityRegistryStoreForTests as resetStorage,
  __setBootstrapReaderForTests as setStorageBootstrap,
  __setOnDemandLoaderForTests as setStorageLoader,
  ensureStorageFacilityRegistryHydrated,
} from '@/shared/storage-facility-registry-store';
import {
  __resetFuelShortageRegistryStoreForTests as resetShortages,
  __setBootstrapReaderForTests as setShortageBootstrap,
} from '@/shared/fuel-shortage-registry-store';

const network = vi.hoisted(() => {
  const attempted: string[] = [];
  globalThis.fetch = async input => {
    attempted.push(String(input));
    throw new Error('Country Atlas fixtures forbid network reads');
  };
  return { attempted };
});
const gas = { pipelines: {
  gasCn: { id: 'gasCn', name: 'CN gas endpoint', fromCountry: 'RU', toCountry: 'CN', transitCountries: [] },
} };
const oil = { pipelines: {
  oilCn: { id: 'oilCn', name: 'CN oil transit', fromCountry: 'AA', toCountry: 'BB', transitCountries: ['CN'] },
  other: { id: 'other', name: 'Other oil', fromCountry: 'AA', toCountry: 'BB', transitCountries: [] },
} };
const storage = { facilities: {
  cn: { id: 'cn', name: 'CN storage', country: 'CN' },
  other: { id: 'other', name: 'Other storage', country: 'AA' },
} };
const unavailableEnergy = { mixAvailable: false, jodiOilAvailable: false, ieaStocksAvailable: false,
  jodiGasAvailable: false, gasStorageAvailable: false, electricityAvailable: false,
  emberAvailable: false, sprAvailable: false, importShareAvailable: false };
let requests: string[];
const cleanups: Array<() => void> = [];

function fixture() {
  const panel = Object.create(CountryDeepDivePanel.prototype) as CountryDeepDivePanel;
  const body = document.createElement('div');
  const controller = new AbortController();
  Reflect.set(panel, 'energyBody', body);
  Reflect.set(panel, 'currentCode', 'CN');
  Reflect.set(panel, 'abortController', controller);
  Reflect.set(panel, 'atlasRevision', 0);
  Reflect.set(panel, 'source', { mode: 'website', supply: { listEnergyDisruptions: async () => ({ events: [] }) } });
  return { panel, body, controller, render: () => Reflect.get(panel, 'renderAtlasExposure').call(panel) };
}
async function settle() {
  await vi.dynamicImportSettled();
  await new Promise(resolve => setTimeout(resolve, 0));
}
function expectAssets(body: HTMLElement) {
  expect(body.textContent).toContain('Pipelines touching CN');
  expect(body.textContent).toContain('2 pipelines');
  expect(body.textContent).toContain('Storage in CN');
  expect(body.textContent).toContain('1 facility');
  expect([...body.querySelectorAll('button')].map(button => button.textContent).sort()).toEqual(['CN gas endpoint', 'CN oil transit', 'CN storage']);
}
function deferHydration() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  setPipelineLoader(async key => { requests.push(key); await pending; return key === 'pipelinesGas' ? gas : oil; });
  setStorageLoader(async key => { requests.push(key); await pending; return storage; });
  return release;
}

beforeAll(() => initTestI18n());
beforeEach(() => {
  requests = [];
  network.attempted.length = 0;
  resetPipelines(); resetStorage(); resetShortages();
  setPipelineBootstrap(() => undefined);
  setStorageBootstrap(() => undefined);
  setShortageBootstrap(() => undefined);
  setPipelineLoader(async key => { requests.push(key); return key === 'pipelinesGas' ? gas : oil; });
  setStorageLoader(async key => { requests.push(key); return storage; });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(network.attempted).toEqual([]);
  resetPipelines(); resetStorage(); resetShortages();
});

describe('country Energy Atlas hydration', () => {
  it('keeps country assets visible when all Energy measurements are unavailable', async () => {
    const { panel, body } = fixture();
    Reflect.get(panel, 'renderEnergyProfile').call(panel, unavailableEnergy);
    await settle();
    expect(body.textContent).toContain('Energy data unavailable for this country.');
    expectAssets(body);
    Reflect.get(panel, 'renderEnergyProfile').call(panel, unavailableEnergy);
    await settle();
    expectAssets(body);
    expect(requests.sort()).toEqual(['pipelinesGas', 'pipelinesOil', 'storageFacilities']);
  });

  it.each(['switch', 'abort'])('discards late assets after country %s when Energy measurements are unavailable', async action => {
    const release = deferHydration();
    const { panel, body, controller } = fixture();
    Reflect.get(panel, 'renderEnergyProfile').call(panel, unavailableEnergy);
    await settle();
    expect(requests).toHaveLength(3);
    if (action === 'switch') Reflect.set(panel, 'currentCode', 'DE');
    else controller.abort();
    release(); await settle();
    expect(body.textContent).toBe('Energy data unavailable for this country.'
      + 'JODI oil data not supplied in this profile.'
      + 'JODI gas data not supplied in this profile.'
      + 'IEA oil stocks data not supplied in this profile.');
    expect(body.querySelectorAll('button')).toHaveLength(0);
  });

  it('retains cached gas when the production loader handles an oil fetch rejection', async () => {
    resetPipelines();
    setPipelineBootstrap(key => key === 'pipelinesGas' ? gas : undefined);
    const { body, render } = fixture();
    render(); await settle();
    expect(body.textContent).toContain('CN gas endpoint');
    expect(body.textContent).toContain('1 pipeline');
    expect(body.textContent).toContain('CN storage');
    expect(network.attempted).toHaveLength(1);
    expect(network.attempted[0]).toContain('keys=pipelinesOil&public=1');
    network.attempted.length = 0;
  });
  it('loads cold registries and renders country assets without a map or Atlas panel', async () => {
    const { body, render } = fixture();
    render(); await settle();
    expectAssets(body);
    expect(requests.sort()).toEqual(['pipelinesGas', 'pipelinesOil', 'storageFacilities']);
  });

  it('reuses warm registries without duplicate loads', async () => {
    await Promise.all([ensurePipelineRegistriesHydrated(), ensureStorageFacilityRegistryHydrated()]);
    const initial = [...requests];
    const { body, render } = fixture();
    render(); await settle(); expectAssets(body);
    body.replaceChildren();
    render(); await settle(); expectAssets(body);
    expect(requests).toEqual(initial);
  });

  it.each(['switch', 'abort'])('ignores data arriving after country %s', async action => {
    const release = deferHydration();
    const { panel, body, controller, render } = fixture();
    render(); await settle();
    expect(requests).toHaveLength(3);
    if (action === 'switch') Reflect.set(panel, 'currentCode', 'DE');
    else controller.abort();
    release(); await settle();
    expect(body.textContent).toBe('');
  });

  it('coalesces concurrent cold loads and renders only the latest Energy view', async () => {
    const release = deferHydration();
    const { body, render } = fixture();
    render(); await settle();
    render(); await settle();
    expect(requests).toHaveLength(3);
    release(); await settle();
    expectAssets(body);
    expect([...body.querySelectorAll('.cdp-subtitle')].map(subtitle => subtitle.textContent).sort()).toEqual(['Pipelines touching CN', 'Storage in CN']);
  });

  it('retains storage on a pipeline failure and permits a later pipeline retry', async () => {
    setPipelineLoader(async () => { throw new Error('Synthetic pipeline miss'); });
    const { body, render } = fixture();
    render(); await settle();
    expect(body.textContent).toContain('CN storage');
    expect(body.textContent).not.toContain('Pipelines touching CN');
    setPipelineLoader(async key => { requests.push(key); return key === 'pipelinesGas' ? gas : oil; });
    body.replaceChildren(); render(); await settle();
    expectAssets(body);
    expect(requests.filter(key => key === 'storageFacilities')).toHaveLength(1);
  });
});

function detailFixture() {
  const result = fixture();
  const content = document.createElement('div');
  const shell = document.createElement('div');
  shell.className = 'cdp-shell';
  shell.append(result.body); content.append(shell); document.body.append(content);
  Reflect.set(result.panel, 'content', content);
  const client = {
    getPipelineDetail: vi.fn(async () => ({ pipeline: { ...gas.pipelines.gasCn, operator: 'Synthetic operator', commodityType: 'gas', publicBadge: 'operational' } })),
    getStorageFacilityDetail: vi.fn(async () => ({ facility: { ...storage.facilities.cn, operator: 'Synthetic operator', facilityType: 'ugs', publicBadge: 'operational' } })),
    listEnergyDisruptions: vi.fn(async () => ({ events: [] })),
  };
  const atlas = vi.fn((_code: string, _signal: AbortSignal) => client);
  Reflect.set(result.panel, 'source', { mode: 'website', atlas, supply: { listEnergyDisruptions: async () => ({ events: [] }) } });
  cleanups.push(() => { Reflect.get(result.panel, 'outputClose')?.(); content.remove(); });
  return { ...result, content, shell, client, atlas };
}

describe('country-owned Atlas details', () => {
  it('keeps hosted detail reads country scoped through the real source', async () => {
    const { createHostCountryBriefSource } = await import('@/services/country-brief-source');
    const call = vi.fn(async () => ({
      state: 'ready', section: 'pipelineDetail', retrievedAt: '2026-10-16T00:00:00Z',
      value: { pipeline: { ...gas.pipelines.gasCn, operator: 'Synthetic operator', commodityType: 'gas', publicBadge: 'flowing' } },
    }));
    const source = await createHostCountryBriefSource(call);
    const controller = new AbortController();
    await expect(source.atlas('CN', controller.signal).getPipelineDetail({ pipelineId: 'gasCn' }))
      .resolves.toMatchObject({ pipeline: { name: 'CN gas endpoint' } });
    expect(call).toHaveBeenCalledWith('get_country_brief_section', {
      section: 'pipelineDetail', arguments: { country_code: 'CN', pipelineId: 'gasCn' },
    }, expect.any(AbortSignal));
    controller.abort();
    await expect(source.atlas('CN', controller.signal).getPipelineDetail({ pipelineId: 'gasCn' }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(call).toHaveBeenCalledOnce();
  });

  it('uses the website detail path when no source was injected', async () => {
    const { panel, render } = detailFixture(); render(); await settle();
    Reflect.set(panel, 'source', undefined);
    await expect(panel.openAtlasDetail('pipeline', 'absent')).rejects.toThrow('Pipeline is not in this country');
  });

  it('loads a named detail through the real default website source on a relative API base', async () => {
    const { panel, render, content } = detailFixture(); render(); await settle();
    Reflect.set(panel, 'source', undefined);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input);
      if (url.includes('/get-pipeline-detail?pipelineId=gasCn')) return new Response(JSON.stringify({ pipeline: { ...gas.pipelines.gasCn, operator: 'Synthetic operator', commodityType: 'gas', publicBadge: 'flowing' } }));
      if (url.includes('/list-energy-disruptions?')) return new Response(JSON.stringify({ events: [] }));
      throw new Error(`Unexpected controlled detail read: ${url}`);
    });
    const { createWebsiteCountryBriefSource } = await import('@/services/country-brief-source');
    await expect(createWebsiteCountryBriefSource().atlas('CN', new AbortController().signal).getPipelineDetail({ pipelineId: 'gasCn' })).resolves.toMatchObject({ pipeline: { name: 'CN gas endpoint' } });
    await panel.openAtlasDetail('pipeline', 'gasCn'); await settle();
    expect(fetch).toHaveBeenCalled();
    expect(content.querySelector('.pp-drawer h3')?.textContent).toContain('CN gas endpoint');
  });

  it.each(['pipeline', 'storage'] as const)('ignores global %s events in the country-owned drawer', async type => {
    const { panel, render, client, content } = detailFixture(); render(); await settle();
    await panel.openAtlasDetail(type, type === 'pipeline' ? 'gasCn' : 'cn');
    const detailRead = type === 'pipeline' ? client.getPipelineDetail : client.getStorageFacilityDetail;
    expect(detailRead).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new CustomEvent(type === 'pipeline' ? 'energy:open-pipeline-detail' : 'energy:open-storage-facility-detail', {
      detail: type === 'pipeline' ? { pipelineId: 'other' } : { facilityId: 'other' },
    }));
    await settle();
    expect(detailRead).toHaveBeenCalledTimes(1);
    expect(content.querySelector(type === 'pipeline' ? '.pp-drawer h3' : '.sf-drawer h3')?.textContent).toContain(type === 'pipeline' ? 'CN gas endpoint' : 'CN storage');
  });

  it.each(['pipeline', 'storage'] as const)('retains ordinary dashboard %s event handling', async type => {
    const dashboard = type === 'pipeline' ? new PipelineStatusPanel() : new StorageFacilityMapPanel();
    cleanups.push(() => dashboard.destroy()); document.body.append(dashboard.getElement());
    const load = vi.spyOn(dashboard as unknown as { loadDetail(id: string): Promise<void> }, 'loadDetail').mockResolvedValue(undefined);
    window.dispatchEvent(new CustomEvent(type === 'pipeline' ? 'energy:open-pipeline-detail' : 'energy:open-storage-facility-detail', {
      detail: type === 'pipeline' ? { pipelineId: 'other' } : { facilityId: 'other' },
    }));
    expect(load).toHaveBeenCalledWith('other');
  });

  it.each([
    ['pipeline', 'gasCn', '.pp-drawer', 'CN gas endpoint'],
    ['storage', 'cn', '.sf-drawer', 'CN storage'],
  ] as const)('opens a cold %s drawer and restores Energy with Back', async (type, id, selector, label) => {
    const { panel, body, render, content, shell, atlas } = detailFixture();
    render(); await settle();
    const button = [...body.querySelectorAll('button')].find(button => button.textContent === label)!;
    button.click(); await settle();
    expect(content.querySelector(selector)?.textContent).toContain(label);
    expect(panel.getAtlasSelection()).toMatchObject({ type, id });
    expect(shell.hidden).toBe(true);
    expect(atlas).toHaveBeenCalledWith('CN', expect.any(AbortSignal));
    const back = content.querySelector<HTMLButtonElement>('.cdp-atlas-output > button')!;
    back.click();
    expect(shell.hidden).toBe(false);
    expect(content.querySelector('.cdp-atlas-output')).toBeNull();
    expect(atlas.mock.calls[0]![1].aborted).toBe(true);
    expectAssets(body);
    expect(panel.getAtlasSelection()).toBeNull();
    expect(requests).toHaveLength(3);
  });

  it.each([['pipeline', 'absent'], ['pipeline', 'other'], ['storage', 'absent'], ['storage', 'other']] as const)(
    'rejects %s ID %s before detail network reads', async (type, id) => {
      const { panel, render, client } = detailFixture(); render(); await settle();
      await expect(panel.openAtlasDetail(type, id)).rejects.toThrow(/not in this country/);
      expect(client.getPipelineDetail).not.toHaveBeenCalled();
      expect(client.getStorageFacilityDetail).not.toHaveBeenCalled();
      expect(client.listEnergyDisruptions).not.toHaveBeenCalled();
    },
  );

  it.each(['switch', 'close'] as const)('discards late detail after country %s', async action => {
    const { panel, render, client, content, controller, atlas } = detailFixture();
    render(); await settle();
    let release!: (value: Awaited<ReturnType<typeof client.getPipelineDetail>>) => void;
    const response = new Promise<Awaited<ReturnType<typeof client.getPipelineDetail>>>(resolve => { release = resolve; });
    client.getPipelineDetail.mockImplementationOnce(() => response);
    const opening = panel.openAtlasDetail('pipeline', 'gasCn'); await settle();
    expect(content.querySelector('.pp-drawer')?.textContent).toContain('Loading');
    controller.abort();
    if (action === 'switch') Reflect.set(panel, 'currentCode', 'DE');
    Reflect.get(panel, 'outputClose')?.();
    expect(atlas.mock.calls[0]![1].aborted).toBe(true);
    release({ pipeline: { ...gas.pipelines.gasCn, operator: 'Synthetic operator', commodityType: 'gas', publicBadge: 'operational' } });
    await opening; await settle();
    expect(content.querySelector('.cdp-atlas-output')).toBeNull();
    expect(panel.getAtlasSelection()).toBeNull();
  });

  it.each(['locked', 'unavailable'] as const)('keeps %s detail errors visible', async state => {
    const { panel, render, client, content } = detailFixture(); render(); await settle();
    client.getStorageFacilityDetail.mockRejectedValueOnce(new CountrySectionError(state, `Synthetic ${state} detail`));
    await panel.openAtlasDetail('storage', 'cn'); await settle();
    expect(content.querySelector('.sf-drawer')?.textContent).toContain(`Synthetic ${state} detail`);
  });

  it('preserves host membership and signal checks', async () => {
    const { panel, client } = detailFixture();
    Reflect.set(panel, 'source', { mode: 'host', atlas: () => client });
    await expect(panel.openAtlasDetail('pipeline', 'gasCn')).rejects.toThrow('Country Atlas data is not ready');
    Reflect.set(panel, 'hostedAtlas', { code: 'DE', signal: Reflect.get(panel, 'signal') });
    await expect(panel.openAtlasDetail('pipeline', 'gasCn')).rejects.toThrow('Country Atlas data is not ready');
    Reflect.set(panel, 'hostedAtlas', { code: 'CN', signal: new AbortController().signal });
    await expect(panel.openAtlasDetail('pipeline', 'gasCn')).rejects.toThrow('Country Atlas data is not ready');
    Reflect.set(panel, 'hostedAtlas', { code: 'CN', signal: Reflect.get(panel, 'signal'), pipelines: { pipelines: [] } });
    await expect(panel.openAtlasDetail('pipeline', 'gasCn')).rejects.toThrow('Pipeline is not in this country');
    expect(client.getPipelineDetail).not.toHaveBeenCalled();
  });
});
