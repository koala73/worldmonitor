import i18next from 'i18next';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PipelineEntry } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import enShell from '@/locales/en.shell.json';
import { pipelineCoverageWarning } from '@/services/supply-chain/pipeline-coverage';

// English first paint loads only en.shell.json; the full catalogue arrives later.
beforeAll(async () => {
  await i18next.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: enShell as Record<string, unknown> } },
    interpolation: { escapeValue: false },
  });
});

const row = (commodityType: string) => ({ id: `p-${commodityType}`, commodityType }) as PipelineEntry;

describe('pipeline coverage banner before the full English catalogue loads', () => {
  it('names oil when only gas rows arrived', () => {
    expect(pipelineCoverageWarning({ pipelines: [row('gas')], upstreamUnavailable: true }))
      .toBe('Oil pipeline data unavailable');
  });

  it('names gas when only oil rows arrived', () => {
    expect(pipelineCoverageWarning({ pipelines: [row('oil')], upstreamUnavailable: true }))
      .toBe('Gas pipeline data unavailable');
  });
});
