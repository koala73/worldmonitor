import type { Pipeline } from '@/types';
import { getCSSColor } from '@/utils';
import { PIPELINES as PIPELINES_DATA } from '../../shared/pipelines-data';

// The table itself lives in shared/ so server-side analysis can import it
// without pulling in the src/ alias graph.
export const PIPELINES: Pipeline[] = PIPELINES_DATA;

// Pipeline colors by type — fixed category colors (not theme-dependent)
export const PIPELINE_COLORS: Record<string, string> = {
  oil: '#ff6b35',
  gas: '#00b4d8',
  products: '#ffd166',
};

/** Get pipeline status color using semantic CSS variables */
export function getPipelineStatusColor(status: string): string {
  switch (status) {
    case 'operating': return getCSSColor('--status-live');
    case 'construction': return getCSSColor('--semantic-elevated');
    default: return getCSSColor('--text-dim');
  }
}

// Pipeline status colors — kept for backward compatibility (DeckGL RGB conversion)
export const PIPELINE_STATUS_COLORS: Record<string, string> = {
  operating: '#44ff88',
  construction: '#ffaa00',
};
