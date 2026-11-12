import { fetchCyberNetworkInfo } from '@/services/cyber-network';
import { t } from '@/services/i18n';
import { escapeHtml } from '@/utils/sanitize';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import type { GetNetworkInfoResponse } from '@/generated/client/worldmonitor/cyber/v1/service_client';

const label = (key: string) => escapeHtml(t(`popups.cyberThreat.network.${key}`));
const copyButton = (value: string) => `<button type="button" class="cyber-copy" data-copy-network="${escapeHtml(value)}" aria-label="${label('copy')}: ${escapeHtml(value)}">${label('copy')}</button>`;
const row = (name: string, value: string, copy = false) => `<div class="popup-stat"><span class="stat-label">${label(name)}</span><span class="stat-value">${escapeHtml(value || t('popups.cyberThreat.network.unknown'))}${value && copy ? copyButton(value) : ''}</span></div>`;
const time = (value: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '';

export function renderCyberNetworkSection(): string {
  return `<p class="popup-description">${label('privacy')}</p>
    <details class="cyber-network-info"><summary>${label('title')}</summary>
    <p class="popup-description">${label('disclaimer')}</p>
    <div class="cyber-network-result" role="status" aria-live="polite"></div>
    <span class="cyber-copy-status" role="status" aria-live="polite"></span>
  </details>`;
}

function renderResult(info: GetNetworkInfoResponse): string {
  const states: Record<string, string> = {
    disabled: 'disabled', invalid: 'invalid', unavailable: 'unavailable', rate_limited: 'rateLimited', no_data: 'noData',
  };
  const state = states[info.status];
  if (state && info.status !== 'no_data') return `<p class="popup-description">${label(state)}</p>`;
  if (!state && info.status !== 'available' && info.status !== 'partial') return `<p>${label('unavailable')}</p>`;
  const sourceUrl = `https://stat.ripe.net/${encodeURIComponent(info.ip)}`;
  const origins = (info.asns || []).map(origin => row('asn', `AS${origin.asn}`, true) + row('operator', origin.holder)).join('');
  return `${state ? `<p class="popup-description">${label(state)}</p>` : ''}
    ${info.status === 'partial' ? `<p class="popup-description">${label('partial')}</p>` : ''}
    <div class="popup-stats">${row('ip', info.ip, true)}${origins || row('asn', '') + row('operator', '')}
      ${row('prefix', info.prefix, true)}${info.hostnames?.length ? info.hostnames.map(name => row('hostname', name, true)).join('') : row('hostname', '')}
      ${row('lookupAt', time(info.lookupAt))}${info.routingAt ? row('routingAt', time(info.routingAt)) : ''}
    </div>
    ${info.isLessSpecific ? `<p class="popup-description">${label('broaderPrefix')}</p>` : ''}
    <p class="popup-description">${label('rdnsNote')}</p>
    <a class="popup-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">RIPEstat / RIPE NCC · RIS / WHOIS ↗</a>`;
}

export function bindCyberNetworkSection(popup: HTMLElement, ip: string, onResize: () => void): void {
  const details = popup.querySelector<HTMLDetailsElement>('.cyber-network-info');
  const content = details?.querySelector<HTMLElement>('.cyber-network-result');
  if (!details || !content) return;
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!popup.isConnected) return;
    onResize();
    if (!details.open || loaded) return;
    loaded = true;
    content.textContent = t('popups.cyberThreat.network.loading');
    try {
      const info = await fetchCyberNetworkInfo(ip);
      if (!popup.isConnected) return;
      setTrustedHtml(content, trustedHtml(renderResult(info), 'escaped passive network lookup fields'));
    } catch {
      if (!popup.isConnected) return;
      content.textContent = t('popups.cyberThreat.network.unavailable');
    }
    onResize();
  });
  details.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-copy-network]');
    if (!button?.dataset.copyNetwork) return;
    const status = details.querySelector<HTMLElement>('.cyber-copy-status');
    try {
      await navigator.clipboard.writeText(button.dataset.copyNetwork);
      if (status) status.textContent = t('popups.cyberThreat.network.copied');
    } catch {
      if (status) status.textContent = t('popups.cyberThreat.network.copyFailed');
    }
  });
}
