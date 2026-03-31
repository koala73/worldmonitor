import type { AppContext, AppModule, UpdateState } from '@/app/app-context';
import { invokeTauri } from '@/services/tauri-bridge';
import { trackUpdateShown, trackUpdateClicked, trackUpdateDismissed } from '@/services/analytics';
import { escapeHtml } from '@/utils/sanitize';

type UpdaterOutcome = 'no_update' | 'update_available' | 'open_failed' | 'fetch_failed';

export class DesktopUpdater implements AppModule {
  private ctx: AppContext;
  private updateCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.setupUpdateChecks();

    // Manual "Check for Updates…" from the macOS Help menu
    document.addEventListener('wm:check-for-updates', () => {
      void this.checkForUpdate(true);
    });
  }

  destroy(): void {
    if (this.updateCheckIntervalId) {
      clearInterval(this.updateCheckIntervalId);
      this.updateCheckIntervalId = null;
    }
  }

  private setupUpdateChecks(): void {
    if (!this.ctx.isDesktopApp || this.ctx.isDestroyed) return;

    setTimeout(() => {
      if (this.ctx.isDestroyed) return;
      void this.checkForUpdate();
    }, 5000);

    if (this.updateCheckIntervalId) {
      clearInterval(this.updateCheckIntervalId);
    }
    this.updateCheckIntervalId = setInterval(() => {
      if (this.ctx.isDestroyed) return;
      void this.checkForUpdate();
    }, this.UPDATE_CHECK_INTERVAL_MS);
  }

  private logUpdaterOutcome(outcome: UpdaterOutcome, context: Record<string, unknown> = {}): void {
    const logger = outcome === 'open_failed' || outcome === 'fetch_failed'
      ? console.warn
      : console.info;
    logger('[updater]', outcome, context);
  }

  private setUpdateState(state: UpdateState): void {
    this.ctx.updateState = state;
    document.dispatchEvent(new CustomEvent('wm:update-state'));
  }

  private resolveDownloadUrl(data: { assets?: { name: string; browser_download_url: string }[] }): string {
    const buildArch = (typeof __BUILD_ARCH__ === 'undefined' ? 'aarch64' : __BUILD_ARCH__) as string;
    const assets = Array.isArray(data.assets) ? data.assets : [];
    const dmg =
      assets.find(a => typeof a.name === 'string' && a.name.endsWith('.dmg') && a.name.includes(buildArch)) ??
      assets.find(a => typeof a.name === 'string' && a.name.endsWith('.dmg'));
    return dmg?.browser_download_url ?? 'https://github.com/bradleybond512/worldmonitor-macos/releases/latest';
  }

  private async checkForUpdate(manual = false): Promise<void> {
    this.setUpdateState({ phase: 'checking' });
    try {
      const res = await fetch(
        'https://api.github.com/repos/bradleybond512/worldmonitor-macos/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) }
      );
      if (!res.ok) {
        this.logUpdaterOutcome('fetch_failed', { status: res.status });
        this.setUpdateState({ phase: 'up-to-date' });
        if (manual) this.showInfoToast('Could not reach update server. Check your connection.');
        return;
      }
      const data = await res.json();

      const tagName = typeof data.tag_name === 'string' ? data.tag_name : '';
      const remote = tagName.replace(/^v/, '');
      if (!remote) {
        this.logUpdaterOutcome('fetch_failed', { reason: 'missing_remote_version' });
        this.setUpdateState({ phase: 'up-to-date' });
        return;
      }

      const current = __APP_VERSION__;
      if (!this.isNewerVersion(remote, current)) {
        this.logUpdaterOutcome('no_update', { current, remote });
        this.setUpdateState({ phase: 'up-to-date' });
        if (manual) this.showInfoToast(`You're up to date — v${current} is the latest version.`);
        return;
      }

      const downloadUrl = this.resolveDownloadUrl(data);
      const dismissKey = `wm-update-dismissed-${remote}`;
      if (localStorage.getItem(dismissKey) && !manual) {
        this.logUpdaterOutcome('update_available', { current, remote, dismissed: true });
        this.setUpdateState({ phase: 'available', version: remote, downloadUrl });
        return;
      }

      this.logUpdaterOutcome('update_available', { current, remote, dismissed: false });
      this.setUpdateState({ phase: 'available', version: remote, downloadUrl });
      trackUpdateShown(current, remote);
      await this.showUpdateToast(remote, downloadUrl);
    } catch (error) {
      this.logUpdaterOutcome('fetch_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.setUpdateState({ phase: 'up-to-date' });
    }
  }

  private isNewerVersion(remote: string, current: string): boolean {
    const r = remote.split('.').map(Number);
    const c = current.split('.').map(Number);
    for (let i = 0; i < Math.max(r.length, c.length); i++) {
      const rv = r[i] ?? 0;
      const cv = c[i] ?? 0;
      if (rv > cv) return true;
      if (rv < cv) return false;
    }
    return false;
  }

  private async showUpdateToast(version: string, downloadUrl: string): Promise<void> {
    const existing = document.querySelector<HTMLElement>('.update-toast');
    if (existing?.dataset.version === version) return;
    existing?.remove();

    // On macOS desktop, show "Update Now" (auto-install). Otherwise show "Download".
    const canAutoInstall = this.ctx.isDesktopApp && downloadUrl.endsWith('.dmg');
    const actionLabel = canAutoInstall ? 'Update Now' : 'Download';

    const toast = document.createElement('div');
    toast.className = 'update-toast';
    toast.dataset.version = version;
    toast.innerHTML = `
      <div class="update-toast-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </div>
      <div class="update-toast-body">
        <div class="update-toast-title">Update Available</div>
        <div class="update-toast-detail">v${escapeHtml(__APP_VERSION__)} \u2192 v${escapeHtml(version)}</div>
      </div>
      <button class="update-toast-action" data-action="install">${actionLabel}</button>
      <button class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">\u00D7</button>
    `;

    toast.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;

      if (action === 'install') {
        trackUpdateClicked(version);
        const btn = toast.querySelector<HTMLButtonElement>('[data-action="install"]');

        if (canAutoInstall) {
          // Auto-install: download DMG, mount, replace app, relaunch
          if (btn) { btn.textContent = 'Downloading…'; btn.disabled = true; }
          invokeTauri<void>('install_update', { downloadUrl })
            .catch((error: unknown) => {
              this.logUpdaterOutcome('open_failed', {
                downloadUrl,
                error: error instanceof Error ? error.message : String(error),
              });
              if (btn) { btn.textContent = 'Failed — retry?'; btn.disabled = false; }
              // Fall back to opening the releases page
              void invokeTauri<void>('open_url', {
                url: 'https://github.com/bradleybond512/worldmonitor-macos/releases/latest',
              }).catch(() => {});
            });
        } else {
          // Web or non-DMG: open in browser
          if (this.ctx.isDesktopApp) {
            void invokeTauri<void>('open_url', { url: downloadUrl }).catch((error: unknown) => {
              this.logUpdaterOutcome('open_failed', {
                downloadUrl,
                error: error instanceof Error ? error.message : String(error),
              });
              this.showInfoToast('Could not open the download link.');
            });
          } else {
            window.open(downloadUrl, '_blank', 'noopener');
          }
        }
      } else if (action === 'dismiss') {
        trackUpdateDismissed(version);
        localStorage.setItem(`wm-update-dismissed-${version}`, '1');
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
      }
    });

    document.body.append(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('visible'));
    });
  }

  private showInfoToast(message: string): void {
    const existing = document.querySelector<HTMLElement>('.update-info-toast');
    existing?.remove();
    const toast = document.createElement('div');
    toast.className = 'update-toast update-info-toast';
    toast.innerHTML = `
      <div class="update-toast-body">
        <div class="update-toast-title">World Monitor</div>
        <div class="update-toast-detail">${escapeHtml(message)}</div>
      </div>
      <button class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">\u00D7</button>
    `;
    toast.addEventListener('click', () => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    });
    document.body.append(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('visible')));
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }
}
