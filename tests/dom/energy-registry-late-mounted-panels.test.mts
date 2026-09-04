import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

const fixtures = vi.hoisted(() => {
  const pipelineEvidence = {
    physicalState: 'flowing',
    physicalStateSource: 'operator',
    commercialState: 'active',
    sanctionRefs: [],
    lastEvidenceUpdate: '2026-08-20T12:00:00Z',
    classifierVersion: 'v2',
    classifierConfidence: 0.98,
  };
  const storageEvidence = {
    physicalState: 'operational',
    physicalStateSource: 'operator',
    commercialState: 'active',
    sanctionRefs: [],
    fillDisclosed: true,
    fillSource: 'operator',
    lastEvidenceUpdate: '2026-08-20T12:00:00Z',
    classifierVersion: 'v2',
    classifierConfidence: 0.98,
  };
  const rawGas = {
    pipelines: {
      'detached-gas': {
        id: 'detached-gas',
        name: 'Detached Gas Link',
        operator: 'Gas Operator',
        commodityType: 'gas',
        fromCountry: 'NO',
        toCountry: 'DE',
        capacityBcmYr: 55,
        startPoint: { lat: 58, lon: 6 },
        endPoint: { lat: 53, lon: 8 },
        evidence: pipelineEvidence,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  };
  const rawOil = {
    pipelines: {
      'detached-oil': {
        id: 'detached-oil',
        name: 'Detached Oil Link',
        operator: 'Oil Operator',
        commodityType: 'oil',
        fromCountry: 'PL',
        toCountry: 'DE',
        capacityMbd: 1.4,
        startPoint: { lat: 52, lon: 19 },
        endPoint: { lat: 52, lon: 13 },
        evidence: pipelineEvidence,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  };
  const rawStorage = {
    facilities: {
      'detached-storage': {
        id: 'detached-storage',
        name: 'Detached Storage Hub',
        operator: 'Storage Operator',
        facilityType: 'ugs',
        country: 'DE',
        location: { lat: 52.6, lon: 8.4 },
        capacityTwh: 42.5,
        evidence: storageEvidence,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  };
  const livePipelines = {
    pipelines: [
      {
        id: 'rpc-gas',
        name: 'RPC Gas Link',
        operator: 'RPC Gas Operator',
        commodityType: 'gas',
        fromCountry: 'NO',
        toCountry: 'DE',
        transitCountries: [],
        capacityBcmYr: 60,
        capacityMbd: 0,
        lengthKm: 900,
        inService: 2024,
        startPoint: { lat: 58, lon: 6 },
        endPoint: { lat: 53, lon: 8 },
        waypoints: [],
        evidence: pipelineEvidence,
        publicBadge: 'flowing',
      },
      {
        id: 'rpc-oil',
        name: 'RPC Oil Link',
        operator: 'RPC Oil Operator',
        commodityType: 'oil',
        fromCountry: 'PL',
        toCountry: 'DE',
        transitCountries: [],
        capacityBcmYr: 0,
        capacityMbd: 1.5,
        lengthKm: 700,
        inService: 2023,
        startPoint: { lat: 52, lon: 19 },
        endPoint: { lat: 52, lon: 13 },
        waypoints: [],
        evidence: pipelineEvidence,
        publicBadge: 'flowing',
      },
    ],
    fetchedAt: '2026-08-21T00:00:00Z',
    classifierVersion: 'v3',
    upstreamUnavailable: false,
  };
  const liveStorage = {
    facilities: [
      {
        id: 'rpc-storage',
        name: 'RPC Storage Hub',
        operator: 'RPC Storage Operator',
        facilityType: 'ugs',
        country: 'DE',
        location: { lat: 52.6, lon: 8.4 },
        capacityTwh: 45,
        capacityMb: 0,
        capacityMtpa: 0,
        workingCapacityUnit: 'TWh',
        inService: 2010,
        evidence: storageEvidence,
        publicBadge: 'operational',
      },
    ],
    fetchedAt: '2026-08-21T00:00:00Z',
    classifierVersion: 'v3',
    upstreamUnavailable: false,
  };

  return {
    rawGas,
    rawOil,
    rawStorage,
    livePipelines,
    liveStorage,
    rpcCalls: { pipelines: 0, storage: 0 },
  };
});

vi.mock('@/services/generated-rpc-clients', () => ({
  SupplyChainServiceClient: class {
    async listPipelines() {
      fixtures.rpcCalls.pipelines += 1;
      return fixtures.livePipelines;
    }

    async listStorageFacilities() {
      fixtures.rpcCalls.storage += 1;
      return fixtures.liveStorage;
    }
  },
}));

import { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';
import {
  __resetPipelineRegistryStoreForTests,
  __setBootstrapReaderForTests as setPipelineBootstrapReader,
  __setOnDemandLoaderForTests as setPipelineOnDemandLoader,
  getCachedPipelineRegistries,
} from '@/shared/pipeline-registry-store';
import {
  __resetStorageFacilityRegistryStoreForTests,
  __setBootstrapReaderForTests as setStorageBootstrapReader,
  __setOnDemandLoaderForTests as setStorageOnDemandLoader,
  getCachedStorageFacilityRegistry,
} from '@/shared/storage-facility-registry-store';

type EnergyPanel = PipelineStatusPanel | StorageFacilityMapPanel;
const panels: EnergyPanel[] = [];

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  __resetPipelineRegistryStoreForTests();
  __resetStorageFacilityRegistryStoreForTests();
  fixtures.rpcCalls.pipelines = 0;
  fixtures.rpcCalls.storage = 0;
  document.body.replaceChildren();
});

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});

async function waitForText(element: HTMLElement, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (element.textContent?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for panel content to contain: ${text}`);
}

function track<T extends EnergyPanel>(panel: T): T {
  panels.push(panel);
  return panel;
}

describe('energy registry panels across deferred mount and fallback transitions', () => {
  it('renders complete on-demand data that arrives before either panel is connected', async () => {
    const pipelineKeys: string[] = [];
    const storageKeys: string[] = [];
    setPipelineBootstrapReader(() => undefined);
    setStorageBootstrapReader(() => undefined);
    setPipelineOnDemandLoader(async (key) => {
      pipelineKeys.push(key);
      return key === 'pipelinesGas' ? fixtures.rawGas : fixtures.rawOil;
    });
    setStorageOnDemandLoader(async (key) => {
      storageKeys.push(key);
      return fixtures.rawStorage;
    });

    const pipelinePanel = track(new PipelineStatusPanel());
    const storagePanel = track(new StorageFacilityMapPanel());
    await Promise.all([pipelinePanel.fetchData(), storagePanel.fetchData()]);

    expect(pipelinePanel.getElement().querySelectorAll('.pp-row')).toHaveLength(0);
    expect(storagePanel.getElement().querySelectorAll('.sf-row')).toHaveLength(0);

    document.body.append(pipelinePanel.getElement(), storagePanel.getElement());
    pipelinePanel.notifyConnected();
    storagePanel.notifyConnected();
    await Promise.all([
      waitForText(pipelinePanel.getElement(), 'Detached Gas Link'),
      waitForText(storagePanel.getElement(), 'Detached Storage Hub'),
    ]);

    expect(pipelinePanel.getElement().querySelectorAll('.pp-row')).toHaveLength(2);
    expect(pipelinePanel.getElement().textContent).toContain('Detached Oil Link');
    expect(storagePanel.getElement().querySelectorAll('.sf-row')).toHaveLength(1);
    expect(pipelineKeys).toEqual(['pipelinesGas', 'pipelinesOil']);
    expect(storageKeys).toEqual(['storageFacilities']);
    expect(fixtures.rpcCalls).toEqual({ pipelines: 0, storage: 0 });
  });

  it('completes a partial rolling-deploy pipeline payload through the combined RPC', async () => {
    const requestedKeys: string[] = [];
    setPipelineBootstrapReader((key) => key === 'pipelinesGas' ? fixtures.rawGas : undefined);
    setPipelineOnDemandLoader(async (key) => {
      requestedKeys.push(key);
      return undefined;
    });

    const panel = track(new PipelineStatusPanel());
    document.body.append(panel.getElement());
    panel.notifyConnected();
    await panel.fetchData();
    await waitForText(panel.getElement(), 'RPC Oil Link');

    expect(requestedKeys).toEqual(['pipelinesOil']);
    expect(fixtures.rpcCalls.pipelines).toBe(1);
    expect(panel.getElement().querySelectorAll('.pp-row')).toHaveLength(2);
    expect(panel.getElement().textContent).toContain('RPC Gas Link');
    expect(panel.getElement().textContent).not.toContain('Detached Gas Link');
    expect(getCachedPipelineRegistries().source).toBe('rpc');
  });

  it('recovers from failed on-demand attempts and renders the RPC fallback on retry', async () => {
    const pipelineKeys: string[] = [];
    const storageKeys: string[] = [];
    let hydrationFails = true;
    setPipelineBootstrapReader(() => undefined);
    setStorageBootstrapReader(() => undefined);
    setPipelineOnDemandLoader(async (key) => {
      pipelineKeys.push(key);
      if (hydrationFails) throw new Error(`temporary ${key} failure`);
      return undefined;
    });
    setStorageOnDemandLoader(async (key) => {
      storageKeys.push(key);
      if (hydrationFails) throw new Error('temporary storage failure');
      return undefined;
    });

    const pipelinePanel = track(new PipelineStatusPanel());
    const storagePanel = track(new StorageFacilityMapPanel());
    document.body.append(pipelinePanel.getElement(), storagePanel.getElement());
    pipelinePanel.notifyConnected();
    storagePanel.notifyConnected();

    await Promise.all([pipelinePanel.fetchData(), storagePanel.fetchData()]);
    await Promise.all([
      waitForText(pipelinePanel.getElement(), 'Pipeline registry error'),
      waitForText(storagePanel.getElement(), 'Storage registry error'),
    ]);

    hydrationFails = false;
    await Promise.all([pipelinePanel.fetchData(), storagePanel.fetchData()]);
    await Promise.all([
      waitForText(pipelinePanel.getElement(), 'RPC Gas Link'),
      waitForText(storagePanel.getElement(), 'RPC Storage Hub'),
    ]);

    expect(pipelineKeys).toEqual([
      'pipelinesGas',
      'pipelinesOil',
      'pipelinesGas',
      'pipelinesOil',
    ]);
    expect(storageKeys).toEqual(['storageFacilities', 'storageFacilities']);
    expect(fixtures.rpcCalls).toEqual({ pipelines: 1, storage: 1 });
    expect(pipelinePanel.getElement().querySelectorAll('.pp-row')).toHaveLength(2);
    expect(storagePanel.getElement().querySelectorAll('.sf-row')).toHaveLength(1);
    expect(getCachedPipelineRegistries().source).toBe('rpc');
    expect(getCachedStorageFacilityRegistry().source).toBe('rpc');
  });

  it('refreshes on demand after a cold miss was recovered through RPC', async () => {
    const pipelineKeys: string[] = [];
    const storageKeys: string[] = [];
    setPipelineBootstrapReader(() => undefined);
    setStorageBootstrapReader(() => undefined);
    setPipelineOnDemandLoader(async (key) => {
      pipelineKeys.push(key);
      return undefined;
    });
    setStorageOnDemandLoader(async (key) => {
      storageKeys.push(key);
      return undefined;
    });

    const pipelinePanel = track(new PipelineStatusPanel());
    const storagePanel = track(new StorageFacilityMapPanel());
    document.body.append(pipelinePanel.getElement(), storagePanel.getElement());
    pipelinePanel.notifyConnected();
    storagePanel.notifyConnected();

    // Cold on-demand misses fall through to one successful combined RPC each.
    await Promise.all([pipelinePanel.fetchData(), storagePanel.fetchData()]);
    await Promise.all([
      waitForText(pipelinePanel.getElement(), 'RPC Gas Link'),
      waitForText(storagePanel.getElement(), 'RPC Storage Hub'),
    ]);
    expect(pipelineKeys).toEqual(['pipelinesGas', 'pipelinesOil']);
    expect(storageKeys).toEqual(['storageFacilities']);
    expect(fixtures.rpcCalls).toEqual({ pipelines: 1, storage: 1 });

    // The RPC-success paint must mark the first hydration cycle as consumed.
    // A later scheduler tick therefore asks the on-demand CDN path to refresh
    // every registry instead of treating the RPC-populated memo as terminal.
    await Promise.all([pipelinePanel.fetchData(), storagePanel.fetchData()]);
    expect(pipelineKeys).toEqual([
      'pipelinesGas',
      'pipelinesOil',
      'pipelinesGas',
      'pipelinesOil',
    ]);
    expect(storageKeys).toEqual(['storageFacilities', 'storageFacilities']);
    expect(fixtures.rpcCalls).toEqual({ pipelines: 1, storage: 1 });
  });
});
