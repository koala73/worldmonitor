import { isDesktopRuntime } from '@/services/runtime';

const STORAGE_KEY = 'wm-download-banner-dismissed';
const SHOW_DELAY_MS = 12_000;
let bannerScheduled = false;

export function maybeShowDownloadBanner(): void {
  if (bannerScheduled) return;
  if (isDesktopRuntime()) return;
  if (localStorage.getItem(STORAGE_KEY)) return;

  bannerScheduled = true;
  setTimeout(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const panel = buildPanel();
    document.body.appendChild(panel);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => panel.classList.add('wm-dl-show'));
    });
  }, SHOW_DELAY_MS);
}

function dismiss(panel: HTMLElement): void {
  localStorage.setItem(STORAGE_KEY, '1');
  panel.classList.remove('wm-dl-show');
  panel.addEventListener('transitionend', () => panel.remove(), { once: true });
}

function buildPanel(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'wm-dl-panel';
  el.innerHTML = `
    <style>
      .wm-dl-panel {
        position: fixed;
        top: 48px;
        right: 0;
        z-index: 900;
        width: 230px;
        background: var(--surface);
        border-left: 3px solid var(--green);
        border-bottom: 1px solid var(--border);
        border-bottom-left-radius: 8px;
        padding: 14px;
        transform: translateX(110%);
        transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        font-family: inherit;
      }
      .wm-dl-panel.wm-dl-show { transform: translateX(0); }
      .wm-dl-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .wm-dl-title {
        font-size: 11px; font-weight: 700; color: var(--green);
        text-transform: uppercase; letter-spacing: 0.5px;
        display: flex; align-items: center; gap: 5px;
      }
      .wm-dl-close {
        background: none; border: none; color: var(--text-dim);
        font-size: 14px; cursor: pointer; padding: 0 2px; line-height: 1;
      }
      .wm-dl-close:hover { color: var(--text); }
      .wm-dl-body { font-size: 11px; color: var(--text-dim); line-height: 1.5; margin-bottom: 12px; }
      .wm-dl-btns { display: flex; flex-direction: column; gap: 5px; }
      .wm-dl-btn {
        display: flex; align-items: center; gap: 6px;
        padding: 7px 10px; border-radius: 6px;
        font-size: 10px; font-weight: 600;
        cursor: pointer; text-decoration: none;
        transition: background 0.15s;
      }
      .wm-dl-btn.mac {
        background: color-mix(in srgb, var(--green) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--green) 20%, transparent);
        color: var(--green);
      }
      .wm-dl-btn.mac:hover { background: color-mix(in srgb, var(--green) 18%, transparent); }
      .wm-dl-btn.win {
        background: color-mix(in srgb, var(--semantic-info) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--semantic-info) 18%, transparent);
        color: var(--semantic-info);
      }
      .wm-dl-btn.win:hover { background: color-mix(in srgb, var(--semantic-info) 15%, transparent); }
    </style>
    <div class="wm-dl-head">
      <div class="wm-dl-title">\u{1F5A5} Desktop Available</div>
      <button class="wm-dl-close" aria-label="Dismiss">\u00D7</button>
    </div>
    <div class="wm-dl-body">Native performance, secure local key storage, offline map tiles.</div>
    <div class="wm-dl-btns">
      <a class="wm-dl-btn mac" href="/api/download?platform=macos-arm64">\uF8FF macOS (Apple Silicon)</a>
      <a class="wm-dl-btn mac" href="/api/download?platform=macos-x64">\uF8FF macOS (Intel)</a>
      <a class="wm-dl-btn win" href="/api/download?platform=windows-exe">\u229E Windows (.exe)</a>
    </div>
  `;

  el.querySelector('.wm-dl-close')!.addEventListener('click', () => dismiss(el));
  el.querySelectorAll('.wm-dl-btn').forEach(btn =>
    btn.addEventListener('click', () => dismiss(el))
  );

  return el;
}
