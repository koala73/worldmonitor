// This is an intentionally narrow, market-moving event taxonomy. Routine
// governance/system-rule revisions remain visible in unclassifiedRevisions
// unless they can inherit a unique owned-category lineage; they are not events.
export const CHINA_CORPORATE_DISCLOSURE_TYPES = Object.freeze([
  'halt',
  'resumption',
  'earnings_warning',
  'restructuring',
  'share_pledge',
  'investigation',
  'exchange_risk_alert',
]);

export const CHINA_DISCLOSURE_DOCUMENT_HOSTS = Object.freeze({
  SSE: Object.freeze(['www.sse.com.cn', 'static.sse.com.cn']),
  SZSE: Object.freeze(['disc.static.szse.cn']),
  HKEX: Object.freeze([]),
});
