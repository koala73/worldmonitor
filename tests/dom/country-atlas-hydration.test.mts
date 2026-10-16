import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountryDeepDivePanel } from '@/components/CountryDeepDivePanel';
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
let requests: string[];

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
  expect(network.attempted).toEqual([]);
  resetPipelines(); resetStorage(); resetShortages();
});

describe('country Energy Atlas hydration', () => {
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
