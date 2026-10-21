import { escapeHtml } from '@/utils/sanitize';
import {
  CHINA_DISCLOSURE_DOCUMENT_HOSTS,
  type ChinaCorporateDisclosureExchange,
  type ChinaCorporateDisclosureType,
} from '../../shared/china-corporate-disclosure-policy.js';

export type ChinaDisclosureExchange = ChinaCorporateDisclosureExchange;
export type ChinaDisclosureType = ChinaCorporateDisclosureType;

export interface ChinaCorporateDisclosureEvent {
  id: string;
  exchange: ChinaDisclosureExchange;
  issuer: {
    id: string;
    exchange: ChinaDisclosureExchange;
    securityCode: string;
    symbol: string;
    name: string;
    nameOriginal: string;
    mappingConfidence: number;
  };
  announcementId: string;
  disclosureType: ChinaDisclosureType;
  titleOriginal: string;
  originalLanguage: string;
  translation: { state: 'unavailable' | 'not_translated' | 'machine_assisted' | 'human_reviewed' };
  documentUrl: string;
  publicationTime: { value: string; precision: 'day' | 'instant' };
  retrievalTime: string;
  effectiveTime: string | null;
  status: 'current' | 'corrected' | 'cancelled';
  confidence: { issuer: number; classification: number; extraction: number };
  history: unknown[];
  provenance: unknown;
}

export interface ChinaCorporateDisclosureSnapshot {
  schemaVersion: number;
  generatedAt: string;
  status: 'healthy' | 'degraded' | 'unavailable';
  sources: unknown[];
  events: ChinaCorporateDisclosureEvent[];
}

const TYPE_LABELS: Record<ChinaDisclosureType, string> = {
  halt: 'Halt',
  resumption: 'Resumption',
  earnings_warning: 'Earnings warning',
  restructuring: 'Restructuring',
  share_pledge: 'Share pledge',
  investigation: 'Investigation',
  exchange_risk_alert: 'Exchange risk alert',
};

const STATUS_LABELS: Record<ChinaCorporateDisclosureEvent['status'], string> = {
  current: 'Current',
  corrected: 'Corrected',
  cancelled: 'Cancelled',
};

function safeDocumentUrl(event: ChinaCorporateDisclosureEvent): string | null {
  try {
    const parsed = new URL(event.documentUrl);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const allowedHosts = CHINA_DISCLOSURE_DOCUMENT_HOSTS[event.exchange];
    if (!allowedHosts?.includes(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function translationLabel(event: ChinaCorporateDisclosureEvent): string {
  if (event.translation.state === 'human_reviewed') return 'Human-reviewed translation';
  if (event.translation.state === 'machine_assisted') return 'Machine-assisted translation';
  if (event.translation.state === 'unavailable') return 'Translation unavailable';
  return event.originalLanguage.toLowerCase().startsWith('zh') ? 'Original Chinese' : 'Original language';
}

export function renderChinaCorporateDisclosureSignals(
  snapshot: ChinaCorporateDisclosureSnapshot | null | undefined,
): string {
  if (!snapshot?.events?.length) return '';
  const rows = snapshot.events.slice(0, 8).map((event) => {
    const documentUrl = safeDocumentUrl(event);
    const originalLink = documentUrl
      ? `<a class="market-disclosure-link" href="${escapeHtml(documentUrl)}" target="_blank" rel="noopener noreferrer">View original</a>`
      : '';
    return `<article class="market-disclosure-item" data-exchange="${escapeHtml(event.exchange)}">
      <div class="market-disclosure-meta">
        <span class="market-disclosure-source">${escapeHtml(event.exchange)} official</span>
        <span>${escapeHtml(event.issuer.symbol)}</span>
        <span>${escapeHtml(TYPE_LABELS[event.disclosureType])}</span>
        <span>${escapeHtml(STATUS_LABELS[event.status])}</span>
        <time datetime="${escapeHtml(event.publicationTime.value)}">${escapeHtml(event.publicationTime.value)}</time>
      </div>
      <div class="market-disclosure-title">${escapeHtml(event.titleOriginal)}</div>
      <div class="market-disclosure-footer">
        <span>${escapeHtml(event.issuer.name)} · ${escapeHtml(event.issuer.nameOriginal)}</span>
        <span>${escapeHtml(translationLabel(event))}</span>
        ${originalLink}
      </div>
    </article>`;
  }).join('');
  const status = snapshot.status === 'healthy' ? 'Live' : snapshot.status === 'degraded' ? 'Degraded' : 'Unavailable';
  return `<section class="market-disclosures" aria-label="Official exchange disclosures">
    <div class="market-disclosure-heading">
      <strong>Official exchange disclosures</strong>
      <span>${escapeHtml(status)}</span>
    </div>
    ${rows}
  </section>`;
}
