export type ChinaCorporateDisclosureExchange = 'SSE' | 'SZSE' | 'HKEX';
export type ChinaCorporateDisclosureType =
  | 'halt'
  | 'resumption'
  | 'earnings_warning'
  | 'restructuring'
  | 'share_pledge'
  | 'investigation'
  | 'exchange_risk_alert';

export const CHINA_CORPORATE_DISCLOSURE_TYPES: readonly ChinaCorporateDisclosureType[];

export const CHINA_DISCLOSURE_DOCUMENT_HOSTS: Readonly<
  Record<ChinaCorporateDisclosureExchange, readonly string[]>
>;
