export interface OperationalDelivery {
  date: string;
  quantity: number;
  unit: string;
  costUsd: number | null;
}

export interface OperationalInput {
  operation: string;
  basis: 'example' | 'user';
  unit: string;
  startDate: string;
  horizonDays: number;
  startingStock: number;
  dailyDemand: number;
  deliveries: OperationalDelivery[];
  alternativeDeliveries: OperationalDelivery[];
  alternativeDailyDemand: number | null;
}

export interface OperationalDay {
  day: number;
  date: string;
  arrivals: number;
  demand: number;
  closingStock: number;
  unmetDemand: number;
}

export interface OperationalBalance {
  days: OperationalDay[];
  firstGapDay: number | null;
  totalUnmetDemand: number;
}

export interface OperationalSnapshot {
  schema: 'worldmonitor-operational-worksheet/v1';
  input: OperationalInput;
  baseline: OperationalBalance;
  alternative: OperationalBalance;
  avoidedUnmetDemand: number;
  additionalDeliveryCostUsd: number | null;
}
