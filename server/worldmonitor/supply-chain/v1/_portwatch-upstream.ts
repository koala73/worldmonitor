export interface TransitDayCount {
  date: string;
  container: number;
  dryBulk: number;
  generalCargo: number;
  roro: number;
  tanker: number;
  cargo: number;
  other: number;
  total: number;
  capContainer: number;
  capDryBulk: number;
  capGeneralCargo: number;
  capRoro: number;
  capTanker: number;
}

export interface PortWatchChokepointData {
  history: TransitDayCount[];
  wowChangePct: number;
}

export interface PortWatchData {
  [chokepointId: string]: PortWatchChokepointData;
}
