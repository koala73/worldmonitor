import { CorrelationPanel } from './CorrelationPanel';
import { t } from '@/services/i18n';
import { ensureHydrated, getHydratedData, waitForBootstrapSlowTier } from '@/services/bootstrap';
import { getGeoHubById } from '@/services/geo-hub-index';
import { h } from '@/utils/dom-utils';
import type { CrossStraitActivitySnapshot } from '@/types/cross-strait-activity';
import {
  crossStraitSourceHealthHeading,
  isCrossStraitActivitySnapshot,
  tryBuildCrossStraitActivityPanelModel,
} from './cross-strait-activity-summary';

function officialSourceLabel(label: string, sourceUrl: string): HTMLElement {
  if (!sourceUrl) return h('span', {}, label);
  return h('a', {
    href: sourceUrl,
    target: '_blank',
    rel: 'noopener noreferrer',
    style: 'color:inherit;text-decoration:underline;',
  }, label);
}

export class MilitaryCorrelationPanel extends CorrelationPanel {
  private officialActivity: CrossStraitActivitySnapshot | null;
  private officialActivitySupplement: HTMLElement | null | undefined;
  private officialActivityDestroyed = false;

  constructor() {
    super('military-correlation', 'Force Posture', 'military', t('components.militaryCorrelation.infoTooltip'));
    const hydrated = getHydratedData('crossStraitActivity');
    this.officialActivity = isCrossStraitActivitySnapshot(hydrated) ? hydrated : null;
    if (this.officialActivity) this.requestRender();
    else void this.hydrateOfficialActivity();
  }

  override destroy(): void {
    this.officialActivityDestroyed = true;
    super.destroy();
  }

  protected override renderSupplement(): HTMLElement | null {
    if (this.officialActivitySupplement !== undefined) {
      return this.officialActivitySupplement;
    }
    this.officialActivitySupplement = this.buildOfficialActivitySupplement();
    return this.officialActivitySupplement;
  }

  private buildOfficialActivitySupplement(): HTMLElement | null {
    if (!this.officialActivity) return null;
    const model = tryBuildCrossStraitActivityPanelModel(this.officialActivity);
    if (!model) return null;
    const children: HTMLElement[] = [
      h('div', { style: 'display:flex;justify-content:space-between;gap:8px;align-items:baseline;' },
        h('strong', { style: 'font-size:11px;' }, model.heading),
        h('span', { style: 'font-size:9px;opacity:0.6;text-align:right;' }, model.coverageLabel),
      ),
      h('div', {
        style: 'font-size:9px;line-height:1.35;opacity:0.72;margin:4px 0 8px;',
      }, model.disclaimer),
    ];

    if (model.sourceHealth) {
      children.push(h('div', {
        role: 'status',
        style: 'font-size:8px;line-height:1.35;margin:0 0 7px;padding:5px;border-left:2px solid #ff9800;background:rgba(255,152,0,0.10);',
      },
      h('strong', {}, crossStraitSourceHealthHeading(model.sourceHealth.state)),
      h('div', { style: 'opacity:0.82;' }, model.sourceHealth.summary),
      ...model.sourceHealth.sources.map((source) => h('div', { style: 'margin-top:2px;' },
        `${source.publisher}: ${source.transportStatus}; errors: ${source.errorCodes.join(', ') || 'none'}; last success: ${source.lastSuccessAt ?? 'not recorded'}`,
      ))));
    }

    if (model.mnd) {
      children.push(
        h('div', { style: 'font-size:10px;margin-bottom:5px;' },
          officialSourceLabel(model.mnd.publisher, model.mnd.sourceUrl),
          h('div', { style: 'font-size:9px;opacity:0.65;' }, model.mnd.reportingLabel),
        ),
      );
      children.push(h('div', {
        style: 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-bottom:8px;',
      }, ...model.mnd.categories.map((category) =>
        h('div', {
          style: 'padding:5px;border:1px solid rgba(255,255,255,0.08);border-radius:4px;',
        },
        h('div', { style: 'font-size:9px;opacity:0.7;' }, category.label),
        h('div', { style: 'font-size:13px;font-weight:700;' }, category.current),
        ...category.comparisons.map((comparison) =>
          h('div', {
            style: `font-size:8px;opacity:${comparison.state === 'sufficient' ? '0.72' : '0.5'};`,
          }, `${comparison.label} · ${comparison.coverage}`),
        )),
      )));
    }

    if (model.japan.length > 0) {
      children.push(h('div', {
        style: 'font-size:9px;font-weight:700;margin:5px 0 3px;',
      }, 'Reviewed Japan MOD regional augmentation'));
      for (const record of model.japan) {
        children.push(h('div', {
          style: 'font-size:9px;line-height:1.35;margin-bottom:4px;opacity:0.75;',
        },
        officialSourceLabel(record.label, record.sourceUrl),
        h('span', {}, ` · ${record.reportingLabel} · ${record.summary}`)));
      }
    }

    const mapButton = h('button', {
      type: 'button',
      style: 'margin-top:5px;padding:3px 8px;font-size:9px;border:1px solid rgba(255,255,255,0.15);border-radius:3px;background:transparent;color:inherit;cursor:pointer;',
    }, 'View Taiwan Strait');
    mapButton.addEventListener('click', () => {
      const hub = getGeoHubById('taiwan-strait');
      if (hub) this.navigateToMap(hub.lat, hub.lon);
    });
    children.push(mapButton);

    return h('section', {
      className: 'cross-strait-official-activity',
      style: 'padding:8px;margin-bottom:8px;border:1px solid rgba(100,150,255,0.2);border-radius:6px;background:rgba(100,150,255,0.05);',
    }, ...children);
  }

  private async hydrateOfficialActivity(): Promise<void> {
    await waitForBootstrapSlowTier();
    if (this.officialActivityDestroyed) return;

    const tierSnapshot = getHydratedData('crossStraitActivity');
    const snapshot = tierSnapshot ?? await ensureHydrated('crossStraitActivity');
    if (this.officialActivityDestroyed || !isCrossStraitActivitySnapshot(snapshot)) return;

    this.officialActivity = snapshot;
    this.officialActivitySupplement = undefined;
    this.requestRender();
  }
}
