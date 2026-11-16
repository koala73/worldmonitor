import type { Pipeline } from '@/types';
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
