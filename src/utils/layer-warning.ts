import { t } from '@/services/i18n';
import { getDismissed, setDismissed } from '@/utils/cross-domain-storage';

const DISMISS_KEY = 'wm-layer-warning-dismissed';
let activeDialog: HTMLElement | null = null;

export function showLayerWarning(threshold: number): void {
  if (getDismissed(DISMISS_KEY)) return;
  if (activeDialog) return;
  if (window.self !== window.top) return;
  if (new URLSearchParams(window.location.search).get('alert') === 'false') return;

  const overlay = document.createElement('div');
  overlay.className = 'layer-warn-overlay';
  overlay.innerHTML = `
    <div class="layer-warn-dialog">
      <div class="layer-warn-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <div class="layer-warn-text">
        <strong>${t('components.deckgl.layerWarningTitle')}</strong>
        <p>${t('components.deckgl.layerWarningBody', { threshold })}</p>
      </div>
      <label class="layer-warn-dismiss">
        <input type="checkbox" />
        <span>${t('components.deckgl.layerWarningDismiss')}</span>
      </label>
      <button class="layer-warn-ok">${t('components.deckgl.layerWarningOk')}</button>
    </div>`;

  const close = () => {
    const cb = overlay.querySelector<HTMLInputElement>('.layer-warn-dismiss input');
    if (cb?.checked) setDismissed(DISMISS_KEY);
    overlay.classList.add('layer-warn-out');
    setTimeout(() => { overlay.remove(); activeDialog = null; }, 200);
  };

  overlay.querySelector('.layer-warn-ok')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);
  activeDialog = overlay;
  requestAnimationFrame(() => overlay.classList.add('layer-warn-in'));
}
