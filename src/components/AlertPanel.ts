import type { AlertEventDetail, AlertItem } from '@/types/alert';
import { alertStorage } from '@/services/alert-storage';
import { escapeHtml } from '@/utils/sanitize';
import { AlertSettings } from './AlertSettings';

function highlightKeywords(title: string, keywords: string[]): string {
  let html = escapeHtml(title);
  for (const keyword of keywords) {
    const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
  }
  return html;
}

function formatRelativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export class AlertPanel {
  private readonly container: HTMLElement;
  private readonly trigger: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly onIncoming: EventListener;
  private readonly onTriggerClick: EventListener;
  private readonly onPanelClick: EventListener;
  private settings: AlertSettings | null = null;

  constructor(container: HTMLElement, trigger: HTMLElement, badge: HTMLElement) {
    this.container = container;
    this.trigger = trigger;
    this.badge = badge;

    this.onIncoming = (event: Event) => {
      const detail = (event as CustomEvent<AlertEventDetail>).detail;
      if (!detail?.article?.title || !detail?.article?.url) return;
      const item = alertStorage.appendAlert(detail);
      this.updateBadge();
      this.renderList();
      this.showBrowserNotification(item);
    };

    this.onTriggerClick = () => {
      const panel = this.container.querySelector<HTMLElement>('#alertPanel');
      if (!panel) return;
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        window.dispatchEvent(new CustomEvent('alert-panel:open'));
      }
    };

    this.onPanelClick = (event: Event) => {
      const target = event.target as HTMLElement;
      const itemEl = target.closest<HTMLElement>('[data-alert-id]');
      const markAll = target.closest<HTMLElement>('#alertMarkAllReadBtn');
      if (markAll) {
        alertStorage.markAllRead();
        this.updateBadge();
        this.renderList();
        return;
      }
      if (!itemEl) return;
      const id = itemEl.dataset.alertId;
      const url = itemEl.dataset.alertUrl;
      if (!id) return;
      alertStorage.markAlertRead(id);
      this.updateBadge();
      if (url) {
        window.open(url, '_blank', 'noopener');
        window.dispatchEvent(new CustomEvent('alert-item:click'));
      }
      this.renderList();
    };
  }

  public mount(): void {
    this.renderShell();
    this.renderList();
    this.updateBadge();
    this.trigger.addEventListener('click', this.onTriggerClick);
    this.container.addEventListener('click', this.onPanelClick);
    window.addEventListener('irishtech-alert', this.onIncoming);
  }

  public destroy(): void {
    this.trigger.removeEventListener('click', this.onTriggerClick);
    this.container.removeEventListener('click', this.onPanelClick);
    window.removeEventListener('irishtech-alert', this.onIncoming);
  }

  private renderShell(): void {
    this.container.innerHTML = `
      <div class="alert-panel" id="alertPanel">
        <div class="alert-panel-header">
          <strong>🔔 ALERTS</strong>
          <button id="alertMarkAllReadBtn" class="alert-mark-read">Mark all read</button>
        </div>
        <div id="alertList" class="alert-list"></div>
        <div id="alertSettings" class="alert-settings-wrap"></div>
      </div>
    `;

    const settingsEl = this.container.querySelector<HTMLElement>('#alertSettings');
    if (settingsEl) {
      this.settings = new AlertSettings(settingsEl, () => this.updateBadge());
      this.settings.mount();
    }
  }

  private renderList(): void {
    const listEl = this.container.querySelector<HTMLElement>('#alertList');
    if (!listEl) return;
    const alerts = alertStorage.getAlerts();
    if (alerts.length === 0) {
      listEl.innerHTML = '<div class="alert-empty">No alerts yet</div>';
      return;
    }

    listEl.innerHTML = alerts.map((item) => this.renderItem(item)).join('');
  }

  private renderItem(item: AlertItem): string {
    return `
      <article class="alert-item ${item.read ? 'read' : 'unread'}" data-alert-id="${item.id}" data-alert-url="${escapeHtml(item.article.url)}">
        <div class="alert-item-time">${formatRelativeTime(item.timestamp)}</div>
        <div class="alert-item-title">${highlightKeywords(item.article.title, item.keywords)}</div>
        <div class="alert-item-meta">${escapeHtml(item.article.source)} · ${escapeHtml(item.keywords.join(', '))}</div>
      </article>
    `;
  }

  private updateBadge(): void {
    const unread = alertStorage.getAlerts().filter((item) => !item.read).length;
    this.badge.textContent = unread > 0 ? String(unread) : '';
    this.badge.style.display = unread > 0 ? 'inline-flex' : 'none';
  }

  private showBrowserNotification(item: AlertItem): void {
    const pref = alertStorage.getPreferences();
    if (!pref.notifyBrowser) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    const n = new Notification('🇮🇪 New Irish Tech Alert', {
      body: item.article.title,
      tag: item.article.id,
    });
    n.onclick = () => {
      window.open(item.article.url, '_blank', 'noopener');
      n.close();
    };
  }
}

export { highlightKeywords, formatRelativeTime };
