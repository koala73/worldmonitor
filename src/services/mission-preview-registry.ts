import type { MissionPresetId } from './mission-presets';
import { h } from '@/utils/dom-utils';

/**
 * Release 1 of the mission conversion funnel: one contextual Pro preview per
 * treated mission, placed inside the panel that already holds that mission's
 * gated depth. This registry is the rollback switch — removing an entry
 * removes that mission's preview and nothing else (plan KTD3/R15; no
 * feature-flag infrastructure exists, so a code entry plus the normal deploy
 * pipeline is the honest rollback mechanism).
 *
 * crisis-desk is deliberately absent: its preview is the ResilienceWidget
 * locked state that already ships inside `cii` (KTD7 — instrumentation only).
 * The untouched comparison missions (tech-ai-watch, good-news-explorer) and
 * Country Watcher (whose conversion moment is the follow cap) must never gain
 * entries in Release 1 — the before/after read depends on it.
 */
export interface MissionPreviewSpec {
  /** Panel that hosts the preview, rendered after its free content (R6). */
  panelKey: string;
  /** Stable id: dismissal persistence key + analytics preview identity. */
  previewId: string;
  /** One line stating what unlocks (R7). */
  unlockCopy: string;
  /** Static, shape-only sample — never live premium data (KTD2). */
  renderSample: () => HTMLElement;
}
const sampleRow = (label: string, value: string, tone?: 'up' | 'down'): HTMLElement =>
  h(
    'div',
    { className: 'pro-preview__row' },
    h('span', { className: 'pro-preview__row-label' }, label),
    h('span', { className: `pro-preview__row-value${tone ? ` pro-preview__row-value--${tone}` : ''}` }, value),
  );

const sample = (...rows: HTMLElement[]): HTMLElement =>
  h('div', { className: 'pro-preview__sample', 'aria-hidden': 'true' }, ...rows);

export const MISSION_PREVIEW_REGISTRY: Partial<Record<MissionPresetId, MissionPreviewSpec>> = {
  'supply-chain-risk': {
    panelKey: 'supply-chain',
    previewId: 'supply-chain-depth',
    unlockCopy: 'Pro unlocks chokepoint stress modelling and country-level cost-shock scenarios.',
    renderSample: () =>
      sample(
        sampleRow('Hormuz chokepoint index', '72 · elevated', 'down'),
        sampleRow('Cost shock · electronics, TW→US', '+4.8% landed cost'),
        sampleRow('Bypass option', 'Cape reroute +11 days'),
      ),
  },
  'energy-security': {
    panelKey: 'pipeline-status',
    previewId: 'energy-supply-depth',
    unlockCopy: 'Pro unlocks supply-chain stress reads behind pipeline and grid status.',
    renderSample: () =>
      sample(
        sampleRow('TurkStream utilization', '81% · 7d trend', 'up'),
        sampleRow('LNG substitution headroom', 'moderate'),
        sampleRow('Cascade exposure', '3 dependent corridors'),
      ),
  },
  'osint-newsroom': {
    panelKey: 'gdelt-intel',
    previewId: 'intel-memory',
    unlockCopy: 'Pro unlocks intel memory — historical search, timelines, and similar-event lookup.',
    renderSample: () =>
      sample(
        sampleRow('Similar event · 2024-06', 'Port strike, 78% signature match'),
        sampleRow('Similar event · 2022-11', 'Grid failure, 64% match'),
        sampleRow('Timeline depth', '36 months of context'),
      ),
  },
  'macro-market-watch': {
    panelKey: 'macro-signals',
    previewId: 'macro-depth',
    unlockCopy: 'Pro unlocks sovereign debt series and deeper macro cross-signals.',
    renderSample: () =>
      sample(
        sampleRow('Debt / GDP · sample', '112% · rising', 'up'),
        sampleRow('Refinancing wall', '2027 Q2 cluster'),
        sampleRow('Cross-signal', 'FX stress + CDS widening'),
      ),
  },
};

/**
 * The single lookup the wiring seam uses: a preview exists only when the
 * ACTIVE mission's registry entry targets exactly this panel. Everything else
 * — no mission, an untreated mission, the wrong panel — resolves to null,
 * which is what keeps R8's one-invitation rule structural.
 */
export function resolveMissionPreview(
  activeMissionId: string | null,
  panelKey: string,
): (MissionPreviewSpec & { missionId: string }) | null {
  if (!activeMissionId) return null;
  const spec = MISSION_PREVIEW_REGISTRY[activeMissionId as MissionPresetId];
  if (!spec || spec.panelKey !== panelKey) return null;
  return { ...spec, missionId: activeMissionId };
}

/** The surface panel-layout needs from a live preview instance. */
export interface MissionPreviewHandle {
  getElement(): HTMLElement;
  getPreviewId(): string;
  destroy(): void;
}

/**
 * The sync core, extracted so the lifecycle (create / no-op / replace on a
 * mismatched preview / destroy when no longer targeted) is unit-testable and
 * the component construction stays injected — services must not import
 * components (boundary rule), and panel-layout supplies the factory.
 */
export function syncPanelPreview(
  previews: Map<string, MissionPreviewHandle>,
  key: string,
  host: HTMLElement,
  activeMissionId: string | null,
  create: (spec: MissionPreviewSpec & { missionId: string }) => MissionPreviewHandle,
): void {
  const spec = resolveMissionPreview(activeMissionId, key);
  const existing = previews.get(key);
  if (!spec) {
    if (existing) {
      existing.destroy();
      previews.delete(key);
    }
    return;
  }
  if (existing) {
    if (existing.getPreviewId() === spec.previewId) return;
    existing.destroy();
    previews.delete(key);
  }
  const preview = create(spec);
  host.appendChild(preview.getElement());
  previews.set(key, preview);
}
