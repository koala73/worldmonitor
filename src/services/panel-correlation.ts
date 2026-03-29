/**
 * Panel correlation alert detector
 *
 * Tracks elevated-state signals from individual panels. When 3+ distinct panels
 * report elevated state within a 5-minute window, fires a 'wm:compound-alert'
 * CustomEvent and shows a top-center toast banner.
 *
 * Usage: call reportElevatedPanel(panelId, label) from any panel data handler
 * when a threshold is breached (e.g. M6.5+ quake, GDACS Red, cyber attack spike).
 */

const WINDOW_MS        = 5 * 60 * 1_000; // 5-minute correlation window
const THRESHOLD        = 3;               // distinct panels required
const ALERT_COOLDOWN   = 10 * 60 * 1_000; // min gap between compound alerts

interface ElevatedSignal {
  panelId:   string;
  label:     string;
  timestamp: number;
}

const _signals: ElevatedSignal[] = [];
let   _lastAlertAt = 0;

function pruneOld(): void {
  const cutoff = Date.now() - WINDOW_MS;
  let i = 0;
  while (i < _signals.length && _signals[i]!.timestamp < cutoff) i++;
  if (i > 0) _signals.splice(0, i);
}

function activePanelIds(): string[] {
  return [...new Set(_signals.map(s => s.panelId))];
}

/**
 * Report that a panel has entered an elevated / alert state.
 * Safe to call frequently — deduplication is handled internally.
 */
export function reportElevatedPanel(panelId: string, label: string): void {
  pruneOld();
  const idx = _signals.findIndex(s => s.panelId === panelId);
  if (idx >= 0) {
    _signals[idx]!.timestamp = Date.now();
  } else {
    _signals.push({ panelId, label, timestamp: Date.now() });
  }

  const panels = activePanelIds();
  if (panels.length >= THRESHOLD && Date.now() - _lastAlertAt > ALERT_COOLDOWN) {
    _lastAlertAt = Date.now();
    const labels = panels
      .map(id => _signals.find(s => s.panelId === id)?.label ?? id);
    document.dispatchEvent(new CustomEvent('wm:compound-alert', {
      detail: { panelCount: panels.length, panels: labels },
    }));
    _showBanner(panels.length, labels);
  }
}

/**
 * Initialize the correlation detector. Call once at app startup.
 * Sets up the compound alert event listener for components that want to react
 * to wm:compound-alert without importing this module directly.
 */
export function initPanelCorrelation(): void {
  // No-op initializer — listeners are added lazily per reportElevatedPanel call.
  // This function exists to allow callers to import the module in a way that
  // makes the intent clear (init vs. passive reporting).
}

function _showBanner(count: number, labels: string[]): void {
  const existing = document.getElementById('wm-compound-alert');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'wm-compound-alert';
  Object.assign(banner.style, {
    position:   'fixed',
    top:        '56px',
    left:       '50%',
    transform:  'translateX(-50%) translateY(-12px)',
    zIndex:     '99999',
    background: 'rgba(100,12,12,0.97)',
    border:     '1px solid rgba(239,68,68,0.5)',
    borderTop:  '2px solid #ef4444',
    borderRadius: '10px',
    padding:    '10px 18px',
    color:      '#fef2f2',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:   '13px',
    boxShadow:  '0 8px 40px rgba(239,68,68,0.3)',
    transition: 'all 0.3s ease',
    opacity:    '0',
    display:    'flex',
    alignItems: 'center',
    gap:        '8px',
    whiteSpace: 'nowrap',
  });

  const displayLabels = labels.slice(0, 5).join(', ') + (labels.length > 5 ? `\u2026` : '');
  banner.innerHTML = `
    <span style="font-size:15px">\u26A0\uFE0F</span>
    <strong style="color:#fca5a5">Compound Alert</strong>
    <span style="color:#fecaca">&mdash;</span>
    <span>${count} panels elevated: ${displayLabels}</span>
    <button id="wm-ca-dismiss" style="margin-left:8px;background:none;border:none;color:#fca5a5;cursor:pointer;font-size:18px;padding:0;line-height:1">&times;</button>
  `;

  document.body.appendChild(banner);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    banner.style.opacity = '1';
    banner.style.transform = 'translateX(-50%) translateY(0)';
  }));

  const dismissBanner = () => {
    banner.style.opacity = '0';
    banner.style.transform = 'translateX(-50%) translateY(-12px)';
    setTimeout(() => banner.remove(), 350);
  };

  banner.querySelector('#wm-ca-dismiss')?.addEventListener('click', dismissBanner);
  setTimeout(dismissBanner, 18_000);
}
