/**
 * Mode transition "why" cards
 *
 * Displays a dismissible toast when the app auto-transitions between modes,
 * explaining the triggering conditions. Only fires for automatic transitions,
 * not manual user-initiated mode changes.
 */
import type { AppMode } from '@/services/mode-manager';

type ModeChangedDetail = { mode: AppMode; prev: AppMode; auto: boolean };

const CARD_DURATION_MS = 14_000;

const MODE_LABELS: Record<AppMode, string> = {
  peace:    'Peace Mode',
  finance:  'Finance Mode',
  war:      'War Mode',
  disaster: 'Disaster Mode',
  ghost:    'Ghost Mode',
};

const MODE_ICONS: Record<AppMode, string> = {
  peace:    '\u{1F54A}',
  finance:  '\u{1F4B0}',
  war:      '\u2694',
  disaster: '\u{1F30B}',
  ghost:    '\u{1F47B}',
};

const MODE_REASONS: Record<AppMode, string> = {
  war:      'Multiple conflict signals exceeded the escalation threshold (≥2 signals above 0.6 confidence).',
  finance:  'Significant market movement detected — S&P 500 ≥2.5%, BTC ≥5%, Oil ≥4%, or Gold ≥2%.',
  disaster: 'Major disaster event detected — GDACS Red alert, M6.5+ earthquake, or 3+ GDACS Orange events.',
  peace:    'All signals have normalized. Standard monitoring resumed.',
  ghost:    '',
};

const MODE_ACCENT: Record<AppMode, string> = {
  peace:    '#22c55e',
  finance:  '#f59e0b',
  war:      '#ef4444',
  disaster: '#f97316',
  ghost:    '#8b5cf6',
};

let _currentCard: HTMLElement | null = null;
let _dismissTimer: ReturnType<typeof setTimeout> | null = null;

function dismiss(): void {
  if (_dismissTimer) { clearTimeout(_dismissTimer); _dismissTimer = null; }
  if (_currentCard) {
    _currentCard.style.opacity = '0';
    _currentCard.style.transform = 'translateX(120%)';
    const card = _currentCard;
    _currentCard = null;
    setTimeout(() => card.remove(), 350);
  }
}

function showCard(mode: AppMode, prev: AppMode): void {
  const reason = MODE_REASONS[mode];
  if (!reason) return;

  dismiss();

  const card = document.createElement('div');
  card.id = 'wm-mode-transition-card';
  const accent = MODE_ACCENT[mode]!;
  Object.assign(card.style, {
    position:   'fixed',
    top:        '72px',
    right:      '16px',
    zIndex:     '99998',
    background: 'rgba(13,15,18,0.97)',
    border:     `1px solid ${accent}33`,
    borderLeft: `3px solid ${accent}`,
    borderRadius: '10px',
    padding:    '14px 16px',
    minWidth:   '300px',
    maxWidth:   '380px',
    color:      '#e5e7eb',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize:   '13px',
    lineHeight: '1.55',
    boxShadow:  `0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px ${accent}11`,
    transition: 'opacity 0.3s ease, transform 0.3s ease',
    opacity:    '0',
    transform:  'translateX(120%)',
  });

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;">
      <span style="font-size:17px;line-height:1">${MODE_ICONS[mode]}</span>
      <strong style="color:${accent};font-size:13.5px;letter-spacing:0.01em">${MODE_LABELS[mode]} Activated</strong>
      <button id="wm-tc-dismiss" style="margin-left:auto;background:none;border:none;color:#6b7280;cursor:pointer;font-size:18px;padding:0;line-height:1;flex-shrink:0" title="Dismiss">&times;</button>
    </div>
    <div style="color:#6b7280;font-size:11px;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">
      Previously: ${MODE_ICONS[prev]} ${MODE_LABELS[prev]}
    </div>
    <div style="color:#d1d5db">${reason}</div>
    <div style="margin-top:8px;height:2px;background:${accent}22;border-radius:1px;overflow:hidden">
      <div id="wm-tc-progress" style="height:100%;background:${accent};width:100%;transition:width ${CARD_DURATION_MS}ms linear;border-radius:1px"></div>
    </div>
  `;

  document.body.appendChild(card);
  _currentCard = card;

  requestAnimationFrame(() => requestAnimationFrame(() => {
    card.style.opacity = '1';
    card.style.transform = 'translateX(0)';
    const bar = card.querySelector<HTMLElement>('#wm-tc-progress');
    if (bar) bar.style.width = '0%';
  }));

  card.querySelector('#wm-tc-dismiss')?.addEventListener('click', dismiss);
  _dismissTimer = setTimeout(dismiss, CARD_DURATION_MS);
}

export function initModeTransitionCards(): void {
  document.addEventListener('wm:mode-changed', ((e: CustomEvent) => {
    const { mode, prev, auto } = e.detail as ModeChangedDetail;
    if (auto && mode !== prev) {
      showCard(mode, prev);
    }
  }) as EventListener);
}
