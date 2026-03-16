import { t } from '@/services/i18n';

const DISMISSED_KEY = 'wm-community-dismissed';
const DISCUSSION_URL = 'https://github.com/bradleybond512/worldmonitor-macos/discussions';

export function mountCommunityWidget(): void {
  if (localStorage.getItem(DISMISSED_KEY) === 'true') return;
  if (document.querySelector('.community-widget')) return;

  const widget = document.createElement('div');
  widget.className = 'community-widget';
  widget.innerHTML = `
    <div class="cw-pill">
      <div class="cw-dot"></div>
      <a class="cw-cta" href="${DISCUSSION_URL}" target="_blank" rel="noopener">${t('components.community.joinDiscussion')}</a>
      <button class="cw-close" aria-label="${t('common.close')}">&times;</button>
    </div>
    <button class="cw-dismiss">${t('components.community.dontShowAgain')}</button>
  `;

  const dismiss = () => {
    widget.classList.add('cw-hiding');
    setTimeout(() => widget.remove(), 300);
  };

  widget.querySelector('.cw-close')!.addEventListener('click', dismiss);

  widget.querySelector('.cw-dismiss')!.addEventListener('click', () => {
    localStorage.setItem(DISMISSED_KEY, 'true');
    dismiss();
  });

  document.body.appendChild(widget);
}
