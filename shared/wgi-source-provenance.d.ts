export interface WgiObservationSource {
  providerName: 'World Bank Open Data';
  sourceUrl: string;
}

export function wgiUpstreamIndicatorId(storedKey: string): string;
export function wgiObservationSource(storedKey: string): WgiObservationSource;
