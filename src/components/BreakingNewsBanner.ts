import type { BreakingAlert } from '@/services/breaking-news-alerts';
import { getAlertSettings } from '@/services/breaking-news-alerts';
import { t } from '@/services/i18n';

const MAX_ALERTS = 3;
const CRITICAL_DISMISS_MS = 60_000;
const HIGH_DISMISS_MS = 30_000;
const SOUND_COOLDOWN_MS = 5 * 60 * 1000;

interface ActiveAlert {
  alert: BreakingAlert;
  element: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  timerStartedAt: number;
}

export class BreakingNewsBanner {
  private container: HTMLElement;
  private activeAlerts: ActiveAlert[] = [];
  private audio: HTMLAudioElement | null = null;
  private lastSoundMs = 0;
  private mutationObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observedPostureBanner: Element | null = null;
  private boundOnAlert: (e: Event) => void;
  private boundOnVisibility: () => void;
  private boundOnResize: () => void;
  private dismissed = new Map<string, number>();

  constructor() {
    this.container = document.createElement('div');
    this.container.className = 'breaking-news-container';
    document.body.appendChild(this.container);

    this.initAudio();
    this.updatePosition();
    this.setupObservers();

    this.boundOnAlert = (e: Event) => this.handleAlert((e as CustomEvent<BreakingAlert>).detail);
    this.boundOnVisibility = () => this.handleVisibility();
    this.boundOnResize = () => this.updatePosition();

    document.addEventListener('wm:breaking-news', this.boundOnAlert);
    document.addEventListener('visibilitychange', this.boundOnVisibility);
    window.addEventListener('resize', this.boundOnResize);

    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const dismissBtn = target.closest('.breaking-alert-dismiss');
      if (dismissBtn) {
        const alertEl = dismissBtn.closest('.breaking-alert');
        if (alertEl) {
          const id = alertEl.getAttribute('data-alert-id');
          if (id) this.dismissAlert(id);
        }
      }
    });
  }

  private initAudio(): void {
    this.audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2teleQYjfKapmWswEjCJvuPQfSoXZZ+3qqBJESSP0unGaxMJVYiytrFeLhR6p8znrFUXRW+bs7V3Qx1hn8Xjp1cYPnegprhkMCFmoLi1k0sZTYGlqqlUIA==');
    this.audio.volume = 0.3;
  }

  private playSound(): void {
    const settings = getAlertSettings();
    if (!settings.soundEnabled || !this.audio) return;
    if (Date.now() - this.lastSoundMs < SOUND_COOLDOWN_MS) return;
    this.audio.currentTime = 0;
    this.audio.play().catch(() => {});
    this.lastSoundMs = Date.now();
  }

  private setupObservers(): void {
    this.mutationObserver = new MutationObserver(() => this.updatePosition());
    this.mutationObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  private attachResizeObserverIfNeeded(): void {
    const postureBanner = document.querySelector('.critical-posture-banner');
    if (!postureBanner) return;
    if (postureBanner === this.observedPostureBanner) return;

    if (this.resizeObserver) this.resizeObserver.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.updatePosition());
    this.resizeObserver.observe(postureBanner);
    this.observedPostureBanner = postureBanner;
  }

  private updatePosition(): void {
    let top = 50;
    if (document.body.classList.contains('has-critical-banner')) {
      this.attachResizeObserverIfNeeded();
      const postureBanner = document.querySelector('.critical-posture-banner');
      if (postureBanner) {
        top += postureBanner.getBoundingClientRect().height;
      }
    }
    this.container.style.top = `${top}px`;
    this.updateOffset();
  }

  private updateOffset(): void {
    const height = this.container.offsetHeight;
    document.documentElement.style.setProperty(
      '--breaking-alert-offset',
      height > 0 ? `${height}px` : '0px'
    );
    document.body.classList.toggle('has-breaking-alert', this.activeAlerts.length > 0);
  }

  private isDismissedRecently(id: string): boolean {
    const ts = this.dismissed.get(id);
    if (ts === undefined) return false;
    if (Date.now() - ts >= 30 * 60 * 1000) {
      this.dismissed.delete(id);
      return false;
    }
    return true;
  }

  private handleAlert(alert: BreakingAlert): void {
    if (this.isDismissedRecently(alert.id)) return;

    const existing = this.activeAlerts.find(a => a.alert.id === alert.id);
    if (existing) return;

    while (this.activeAlerts.length >= MAX_ALERTS) {
      const oldest = this.activeAlerts.shift();
      if (oldest) this.removeAlert(oldest);
    }

    const el = this.createAlertElement(alert);
    this.container.appendChild(el);

    const dismissMs = alert.threatLevel === 'critical' ? CRITICAL_DISMISS_MS : HIGH_DISMISS_MS;
    const now = Date.now();
    const active: ActiveAlert = {
      alert,
      element: el,
      timer: null,
      remainingMs: dismissMs,
      timerStartedAt: now,
    };

    if (!document.hidden) {
      active.timer = setTimeout(() => this.dismissAlert(alert.id), dismissMs);
    }

    this.activeAlerts.push(active);
    this.playSound();
    this.updateOffset();
  }

  private createAlertElement(alert: BreakingAlert): HTMLElement {
    const el = document.createElement('div');
    el.className = `breaking-alert severity-${alert.threatLevel}`;
    el.setAttribute('data-alert-id', alert.id);

    const icon = alert.threatLevel === 'critical' ? '🚨' : '⚠️';
    const levelText = alert.threatLevel === 'critical'
      ? t('components.breakingNews.critical')
      : t('components.breakingNews.high');
    const timeAgo = this.formatTimeAgo(alert.timestamp);

    const iconSpan = document.createElement('span');
    iconSpan.className = 'breaking-alert-icon';
    iconSpan.textContent = icon;

    const content = document.createElement('div');
    content.className = 'breaking-alert-content';

    const levelSpan = document.createElement('span');
    levelSpan.className = 'breaking-alert-level';
    levelSpan.textContent = levelText;

    const headlineSpan = document.createElement('span');
    headlineSpan.className = 'breaking-alert-headline';
    headlineSpan.textContent = alert.headline;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'breaking-alert-meta';
    metaSpan.textContent = `${alert.source} · ${timeAgo}`;

    content.appendChild(levelSpan);
    content.appendChild(headlineSpan);
    content.appendChild(metaSpan);

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'breaking-alert-dismiss';
    dismissBtn.textContent = '×';
    dismissBtn.title = t('components.breakingNews.dismiss');

    el.appendChild(iconSpan);
    el.appendChild(content);
    el.appendChild(dismissBtn);

    return el;
  }

  private formatTimeAgo(date: Date): string {
    const ms = Date.now() - date.getTime();
    if (ms < 60_000) return t('components.intelligenceFindings.time.justNow');
    if (ms < 3_600_000) return t('components.intelligenceFindings.time.minutesAgo', { count: String(Math.floor(ms / 60_000)) });
    return t('components.intelligenceFindings.time.hoursAgo', { count: String(Math.floor(ms / 3_600_000)) });
  }

  private dismissAlert(id: string): void {
    this.dismissed.set(id, Date.now());
    const idx = this.activeAlerts.findIndex(a => a.alert.id === id);
    if (idx === -1) return;
    const active = this.activeAlerts[idx]!;
    this.removeAlert(active);
    this.activeAlerts.splice(idx, 1);
    this.updateOffset();
  }

  private removeAlert(active: ActiveAlert): void {
    if (active.timer) clearTimeout(active.timer);
    active.element.remove();
  }

  private handleVisibility(): void {
    const now = Date.now();
    if (document.hidden) {
      for (const active of this.activeAlerts) {
        if (active.timer) {
          clearTimeout(active.timer);
          active.timer = null;
          const elapsed = now - active.timerStartedAt;
          active.remainingMs = Math.max(0, active.remainingMs - elapsed);
        }
      }
    } else {
      const expired: string[] = [];
      for (const active of this.activeAlerts) {
        if (!active.timer && active.remainingMs > 0) {
          active.timerStartedAt = now;
          active.timer = setTimeout(() => this.dismissAlert(active.alert.id), active.remainingMs);
        } else if (active.remainingMs <= 0) {
          expired.push(active.alert.id);
        }
      }
      for (const id of expired) this.dismissAlert(id);
    }
  }

  public destroy(): void {
    document.removeEventListener('wm:breaking-news', this.boundOnAlert);
    document.removeEventListener('visibilitychange', this.boundOnVisibility);
    window.removeEventListener('resize', this.boundOnResize);
    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();

    for (const active of this.activeAlerts) {
      if (active.timer) clearTimeout(active.timer);
    }
    this.activeAlerts = [];
    this.container.remove();
    document.body.classList.remove('has-breaking-alert');
    document.documentElement.style.removeProperty('--breaking-alert-offset');
  }
}
