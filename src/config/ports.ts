export type { PortType, Port } from '@/types';
import type { Port, PortType } from '@/types';
import { PORTS as PORTS_DATA } from '../../shared/ports-data';

// The table itself lives in shared/ so server-side analysis can import it
// without pulling in the src/ alias graph.
export const PORTS: Port[] = PORTS_DATA;

export function getPortsByType(type: PortType): Port[] {
  return PORTS.filter(p => p.type === type);
}

export function getTopContainerPorts(limit = 20): Port[] {
  return PORTS.filter(p => p.rank != null).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999)).slice(0, limit);
}
