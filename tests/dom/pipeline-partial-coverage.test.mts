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
  const gasRow = {
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
  };
  return {
    gasRow,
    livePipelines: {
      pipelines: [gasRow],
      fetchedAt: '2026-08-21T00:00:00Z',
      classifierVersion: 'v3',
      upstreamUnavailable: true,
    },
  };
});

vi.mock('@/services/generated-rpc-clients', () => ({
  SupplyChainServiceClient: class {
    async listPipelines() {
      return fixtures.livePipelines;
    }
  },
}));

import { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import {
  __resetPipelineRegistryStoreForTests,
  __setBootstrapReaderForTests as setPipelineBootstrapReader,
  __setOnDemandLoaderForTests as setPipelineOnDemandLoader,
  getCachedPipelineRegistries,
} from '@/shared/pipeline-registry-store';

const panels: PipelineStatusPanel[] = [];

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  __resetPipelineRegistryStoreForTests();
  document.body.replaceChildren();
  fixtures.livePipelines = {
    pipelines: [fixtures.gasRow],
    fetchedAt: '2026-08-21T00:00:00Z',
    classifierVersion: 'v3',
    upstreamUnavailable: true,
  };
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

function track(panel: PipelineStatusPanel): PipelineStatusPanel {
  panels.push(panel);
  return panel;
}

describe('pipeline panel partial coverage', () => {
  it('renders retained rows and a coverage warning when one registry is missing', async () => {
    setPipelineBootstrapReader(() => undefined);
    setPipelineOnDemandLoader(async () => undefined);

    const panel = track(new PipelineStatusPanel());
    document.body.append(panel.getElement());
    panel.notifyConnected();
    await panel.fetchData();
    await waitForText(panel.getElement(), 'RPC Gas Link');

    expect(panel.getElement().querySelectorAll('.pp-row')).toHaveLength(1);
    expect(panel.getElement().querySelector('.economic-warning')?.textContent)
      .toContain('Supply chain data temporarily unavailable');
    expect(panel.getElement().textContent).not.toContain('Pipeline registry unavailable');
    expect(getCachedPipelineRegistries().source).toBe('none');
  });

  it('shows an error only when the live registry is empty and unavailable', async () => {
    fixtures.livePipelines = {
      ...fixtures.livePipelines,
      pipelines: [],
      upstreamUnavailable: true,
    };
    setPipelineBootstrapReader(() => undefined);
    setPipelineOnDemandLoader(async () => undefined);

    const panel = track(new PipelineStatusPanel());
    document.body.append(panel.getElement());
    panel.notifyConnected();
    await panel.fetchData();
    await waitForText(panel.getElement(), 'Pipeline registry unavailable');

    expect(panel.getElement().querySelectorAll('.pp-row')).toHaveLength(0);
    expect(panel.getElement().querySelector('.economic-warning')).toBeNull();
    expect(getCachedPipelineRegistries().source).toBe('none');
  });
});
