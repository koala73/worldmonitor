// Re-export shim. The 210-row table itself lives in `shared/military-bases-data.ts`
// so Edge/esbuild server handlers can read it without the `@/` alias; the
// annotation below is what proves MilitaryBaseRecord still satisfies MilitaryBase.
//
// Keep this module's path stable: vite.config.ts co-chunks it as
// 'military-bases-data' to keep the table off the eager boot graph (#4478).

import type { MilitaryBase } from '@/types';
import { MILITARY_BASES_EXPANDED as SHARED_MILITARY_BASES_EXPANDED } from '../../shared/military-bases-data';

export const MILITARY_BASES_EXPANDED: MilitaryBase[] = SHARED_MILITARY_BASES_EXPANDED;
