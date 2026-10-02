export const CORRELATION_DOMAINS = ['military', 'escalation', 'economic', 'disaster'] as const;
export type CorrelationDomain = typeof CORRELATION_DOMAINS[number];
