export interface TransitDayCount {
  date: string;
  tanker: number;
  cargo: number;
  other: number;
  total: number;
}

export interface PortWatchChokepointData {
  history: TransitDayCount[];
  wowChangePct: number;
}

export interface PortWatchData {
  [chokepointId: string]: PortWatchChokepointData;
}
