export interface UcdpPartyMonth {
  country: string;
  sideA: string;
  sideB: string;
  month: string;
  deaths: number;
  events: number;
}
export declare const UNKNOWN_PARTY: '[unknown]';
export declare function withoutHistoricalName(name: unknown): string;
export declare function actorName(side: unknown): string;
export declare function statePartyIso2(side: unknown): string | null;
export declare function parsePartyMonths(value: unknown): UcdpPartyMonth[] | null;
