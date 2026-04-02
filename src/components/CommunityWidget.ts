import { t } from '@/services/i18n';
import { getDismissed, setDismissed } from '@/utils/cross-domain-storage';

const DISMISSED_KEY = 'wm-community-dismissed-v2';
const DISCUSSION_URL = 'https://discord.gg/re63kWKxaz';

export function mountCommunityWidget(): void {
  if (getDismissed(DISMISSED_KEY)) return;
  if (document.querySelector('.community-widget')) return;

  const widget = document.createElement('div');
  widget.className = 'community-widget';
  widget.innerHTML = `
    <div class="cw-pill">
      <a class="cw-cta" href="${DISCUSSION_URL}" target="_blank" rel="noopener">Join the Discord Community</a>
      <button class="cw-close" aria-label="${t('common.close')}">&times;</button>
    </div>
  `;

  const dismiss = () => {
    setDismissed(DISMISSED_KEY);
    widget.classList.add('cw-hiding');
    setTimeout(() => widget.remove(), 300);
  };

  widget.querySelector('.cw-close')!.addEventListener('click', dismiss);

  document.body.appendChild(widget);
}
