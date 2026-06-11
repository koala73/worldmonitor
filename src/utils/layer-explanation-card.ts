import type { LayerExplanation } from '@/config/map-layer-definitions';
import { escapeHtml } from '@/utils/sanitize';

export function renderLayerExplanationCard(layerLabel: string, explanation: LayerExplanation): string {
  const list = (items: string[]): string => items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const related = explanation.related.length > 0
    ? explanation.related.map(item => `<span>${escapeHtml(item)}</span>`).join('')
    : '<span>Layer guide</span>';
  const evidence = explanation.evidence.length > 0
    ? `<div class="layer-explanation-grounding"><span>Grounded in</span>${explanation.evidence.map(item => `<code>${escapeHtml(item)}</code>`).join('')}</div>`
    : '';
  const coverageLabel = explanation.coverage === 'curated' ? 'Curated v1' : 'Fallback';

  return `
    <div class="layer-explanation-header">
      <div>
        <span class="layer-explanation-kicker">${escapeHtml(explanation.category)}</span>
        <strong>${escapeHtml(layerLabel)}</strong>
      </div>
      <button class="layer-explanation-close" aria-label="Close">×</button>
    </div>
    <div class="layer-explanation-content">
      <div class="layer-explanation-status ${explanation.coverage}">${coverageLabel}</div>
      <p class="layer-explanation-purpose">${escapeHtml(explanation.purpose)}</p>
      <div class="layer-explanation-grid">
        <section>
          <span>Source</span>
          <p>${escapeHtml(explanation.source)}</p>
        </section>
        <section>
          <span>Freshness</span>
          <p>${escapeHtml(explanation.freshness)}</p>
        </section>
        <section>
          <span>Confidence</span>
          <p>${escapeHtml(explanation.confidence)}</p>
        </section>
      </div>
      <div class="layer-explanation-section">
        <span>Limitations</span>
        <ul>${list(explanation.limitations)}</ul>
      </div>
      <div class="layer-explanation-section">
        <span>Related</span>
        <div class="layer-explanation-related">${related}</div>
      </div>
      ${evidence}
    </div>
  `;
}
