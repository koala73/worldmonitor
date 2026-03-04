import type { PanelConfig } from '@/types';

export const SENTINEL_PANELS: Record<string, PanelConfig> = {
  'social-feed': { name: 'Social Intelligence', enabled: true, priority: 2 },
  analyst: { name: 'JP 3-60 Analyst', enabled: true, priority: 1 },
  'notam-tfr': { name: 'NOTAM / TFR', enabled: true, priority: 2 },
  'flight-history': { name: 'Flight History', enabled: true, priority: 2 },
};
