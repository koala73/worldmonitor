import type { AppContext, AppModule } from '@/app/app-context';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import { tryInvokeTauri } from '@/services/tauri-bridge';
import { getAlertSettings } from '@/services/breaking-news-alerts';

/**
 * Sends native macOS notifications for breaking alerts via osascript (Tauri command).
 * Only active on desktop. Respects the existing alert settings toggle.
 */
export class DesktopNotifications implements AppModule {
  private ctx: AppContext;
  private readonly boundHandler: (e: Event) => void;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.boundHandler = (e: Event) => {
      void this.onBreakingNews((e as CustomEvent<BreakingAlert>).detail);
    };
  }

  init(): void {
    if (!this.ctx.isDesktopApp) return;
    document.addEventListener('wm:breaking-news', this.boundHandler);
  }

  destroy(): void {
    document.removeEventListener('wm:breaking-news', this.boundHandler);
  }

  private async onBreakingNews(alert: BreakingAlert): Promise<void> {
    const settings = getAlertSettings();
    if (!settings.enabled || !settings.desktopNotificationsEnabled) return;

    const sound = alert.threatLevel === 'critical' ? 'Basso' : 'Ping';
    const body = `[${alert.threatLevel.toUpperCase()}] ${alert.headline} — ${alert.source}`;

    await tryInvokeTauri<void>('send_notification', {
      title: 'World Monitor Alert',
      body,
      sound,
    });
  }
}
