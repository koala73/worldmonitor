export type { PortType, Port } from '@/types';
import type { Port } from '@/types';
import { PORTS as PORTS_DATA } from '../../shared/ports-data';

// The table itself lives in shared/ so server-side analysis can import it
// without pulling in the src/ alias graph.
export const PORTS: Port[] = PORTS_DATA;
