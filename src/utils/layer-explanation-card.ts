import {
  layerExplanationCopyPrefix,
  type LayerExplanation,
} from '@/config/map-layer-definitions';
import { escapeHtml } from '@/utils/sanitize';

export type LayerExplanationLookup = (key: string) => unknown;

const LABEL_KEYS = {
  source: 'layerExplanation.labels.source',
  freshness: 'layerExplanation.labels.freshness',
  confidence: 'layerExplanation.labels.confidence',
  limitations: 'layerExplanation.labels.limitations',
  related: 'layerExplanation.labels.related',
  groundedIn: 'layerExplanation.labels.groundedIn',
  curated: 'layerExplanation.labels.curated',
  fallback: 'layerExplanation.labels.fallback',
  layerGuide: 'layerExplanation.labels.layerGuide',
  close: 'common.close',
} as const;

export function layerExplanationList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => (value as Record<string, unknown>)[key])
    .filter((item): item is string => typeof item === 'string');
}

function isResolvedCopy(value: unknown, key: string): boolean {
  if (typeof value === 'string') return value.trim() !== '' && value !== key;
  return layerExplanationList(value).length > 0;
}

export function layerExplanationLookup(
  translate: (key: string, options?: Record<string, unknown>) => unknown,
): LayerExplanationLookup {
  return (key) => {
    const primary = translate(key, { returnObjects: true });
    if (isResolvedCopy(primary, key)) return primary;
    const english = translate(key, { lng: 'en', returnObjects: true });
    if (isResolvedCopy(english, key)) return english;
    return key;
  };
}

function text(lookup: LayerExplanationLookup, key: string): string {
  const value = lookup(key);
  return typeof value === 'string' && value !== key ? value : '';
}

function lines(lookup: LayerExplanationLookup, key: string): string[] {
  return layerExplanationList(lookup(key));
}

function list(items: string[]): string {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

export function renderLayerExplanationCard(
  layerLabel: string,
  explanation: LayerExplanation,
  lookup: LayerExplanationLookup,
): string {
  const prefix = layerExplanationCopyPrefix(explanation.key, explanation.coverage);
  const related = lines(lookup, `${prefix}.related`);
  const relatedHtml = related.length > 0
    ? related.map((item) => `<span>${escapeHtml(item)}</span>`).join('')
    : `<span>${escapeHtml(text(lookup, LABEL_KEYS.layerGuide))}</span>`;
  const evidence = explanation.evidence.length > 0
    ? `<div class="layer-explanation-grounding"><span>${escapeHtml(text(lookup, LABEL_KEYS.groundedIn))}</span>${explanation.evidence.map((item) => `<code>${escapeHtml(item)}</code>`).join('')}</div>`
    : '';
  const coverageLabel = explanation.coverage === 'curated'
    ? text(lookup, LABEL_KEYS.curated)
    : text(lookup, LABEL_KEYS.fallback);

  return `
    <div class="layer-explanation-header">
      <div>
        <span class="layer-explanation-kicker">${escapeHtml(text(lookup, `${prefix}.category`))}</span>
        <strong>${escapeHtml(layerLabel)}</strong>
      </div>
      <button class="layer-explanation-close" aria-label="${escapeHtml(text(lookup, LABEL_KEYS.close))}">×</button>
    </div>
    <div class="layer-explanation-content">
      <div class="layer-explanation-status ${explanation.coverage}">${escapeHtml(coverageLabel)}</div>
      <p class="layer-explanation-purpose">${escapeHtml(text(lookup, `${prefix}.purpose`))}</p>
      <div class="layer-explanation-grid">
        <section>
          <span>${escapeHtml(text(lookup, LABEL_KEYS.source))}</span>
          <p>${escapeHtml(text(lookup, `${prefix}.source`))}</p>
        </section>
        <section>
          <span>${escapeHtml(text(lookup, LABEL_KEYS.freshness))}</span>
          <p>${escapeHtml(text(lookup, `${prefix}.freshness`))}</p>
        </section>
        <section>
          <span>${escapeHtml(text(lookup, LABEL_KEYS.confidence))}</span>
          <p>${escapeHtml(text(lookup, `${prefix}.confidence`))}</p>
        </section>
      </div>
      <div class="layer-explanation-section">
        <span>${escapeHtml(text(lookup, LABEL_KEYS.limitations))}</span>
        <ul>${list(lines(lookup, `${prefix}.limitations`))}</ul>
      </div>
      <div class="layer-explanation-section">
        <span>${escapeHtml(text(lookup, LABEL_KEYS.related))}</span>
        <div class="layer-explanation-related">${relatedHtml}</div>
      </div>
      ${evidence}
    </div>
  `;
}
