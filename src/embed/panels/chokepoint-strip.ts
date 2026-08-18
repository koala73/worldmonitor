import { t } from '@/services/i18n';
import { SupplyChainServiceClient } from '@/services/generated-rpc-clients';
import type { ChokepointInfo } from '@/generated/client/worldmonitor/supply_chain/v1/service_client';
import { buildWorldMonitorAttributionUrl } from '@/embed/embed-url';
import { createKeyedEmbedFetch } from '@/embed/embed-fetch';

const STRIP_ORDER = [
  'hormuz_strait',
  'malacca_strait',
  'suez',
  'bab_el_mandeb',
  'bosphorus',
  'dover_strait',
  'panama',
];

function shortName(id: string): string {
  switch (id) {
    case 'hormuz_strait': return t('components.chokepointStrip.shortName.hormuzStrait');
    case 'malacca_strait': return t('components.chokepointStrip.shortName.malaccaStrait');
    case 'suez': return t('components.chokepointStrip.shortName.suez');
    case 'bab_el_mandeb': return t('components.chokepointStrip.shortName.babElMandeb');
    case 'bosphorus': return t('components.chokepointStrip.shortName.bosphorus');
    case 'dover_strait': return t('components.chokepointStrip.shortName.danishStraits');
    case 'panama': return t('components.chokepointStrip.shortName.panama');
    default: return '';
  }
}

function statusColor(status: string): string {
  const s = (status || '').toLowerCase();
  if (s.includes('closed') || s.includes('critical')) return '#e74c3c';
  if (s.includes('disrupted') || s.includes('high')) return '#e67e22';
  if (s.includes('restricted') || s.includes('elevated') || s.includes('medium')) return '#f39c12';
  return '#2ecc71';
}

function formatFlow(cp: ChokepointInfo): string {
  const est = cp.flowEstimate;
  if (!est || typeof est.currentMbd !== 'number' || typeof est.baselineMbd !== 'number') return '—';
  const pct = est.baselineMbd > 0 ? Math.round((est.currentMbd / est.baselineMbd) * 100) : null;
  if (pct == null) return t('components.chokepointStrip.flow.mbd', { value: est.currentMbd.toFixed(1) });
  return t('components.chokepointStrip.flow.pctOfBaseline', { pct });
}

function getReferrerHost(): string | null {
  if (!document.referrer) return null;
  try {
    return new URL(document.referrer).host || null;
  } catch {
    return null;
  }
}

export async function mountEmbedChokepointStrip(root: HTMLElement, apiKey: string): Promise<void> {
  const client = new SupplyChainServiceClient('', { fetch: createKeyedEmbedFetch(apiKey) });
  const data = await client.getChokepointStatus({});
  if (!data.chokepoints?.length) {
    throw new Error('chokepoint_unavailable');
  }

  const byId = new Map(data.chokepoints.map((cp) => [cp.id, cp]));
  const ordered = STRIP_ORDER
    .map((id) => byId.get(id))
    .filter((cp): cp is ChokepointInfo => !!cp);

  const wrap = document.createElement('div');
  wrap.className = 'wm-embed-chokepoints';

  const heading = document.createElement('h2');
  heading.className = 'wm-embed-panel-title';
  heading.textContent = t('components.chokepointStrip.title');
  wrap.appendChild(heading);

  const strip = document.createElement('div');
  strip.className = 'wm-embed-cp-strip';
  for (const cp of ordered) {
    const chip = document.createElement('div');
    chip.className = 'wm-embed-cp-chip';
    chip.dataset.cp = cp.id;
    chip.title = `${cp.name} - ${cp.status || t('components.chokepointStrip.unknown')}`;

    const dot = document.createElement('div');
    dot.className = 'wm-embed-cp-dot';
    dot.style.background = statusColor(cp.status);
    chip.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'wm-embed-cp-body';
    const name = document.createElement('div');
    name.className = 'wm-embed-cp-name';
    name.textContent = shortName(cp.id) || cp.name;
    if (cp.activeWarnings > 0) {
      const warn = document.createElement('span');
      warn.className = 'wm-embed-cp-warn';
      warn.textContent = String(cp.activeWarnings);
      name.appendChild(warn);
    }
    const flow = document.createElement('div');
    flow.className = 'wm-embed-cp-flow';
    flow.textContent = formatFlow(cp);
    body.appendChild(name);
    body.appendChild(flow);
    chip.appendChild(body);
    strip.appendChild(chip);
  }
  wrap.appendChild(strip);

  const attribution = document.createElement('a');
  attribution.className = 'wm-embed-attribution';
  attribution.href = buildWorldMonitorAttributionUrl(new URL('/dashboard', window.location.origin).toString(), getReferrerHost());
  attribution.target = '_blank';
  attribution.rel = 'noopener noreferrer';
  attribution.textContent = 'Chokepoint Monitor by World Monitor';
  wrap.appendChild(attribution);

  root.appendChild(wrap);
}
