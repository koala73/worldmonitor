import type { CivilVessel } from '../types';

export interface MaritimeProvider {
  name: 'marinetraffic' | 'aisstream' | 'vesselfinder' | 'aishub';
  listVessels(): Promise<CivilVessel[]>;
}
