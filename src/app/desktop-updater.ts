import type { AppContext, AppModule } from '@/app/app-context';
import { invokeTauri } from '@/services/tauri-bridge';
import { openExternalUrl } from '@/services/external-navigation';
import { trackUpdateShown, trackUpdateClicked, trackUpdateDismissed } from '@/services/analytics';
import { escapeHtml } from '@/utils/sanitize';
import { getDismissed, setDismissed } from '@/utils/cross-domain-storage';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { decideUpdateOutcome } from '@/utils/desktop-version';


interface DesktopRuntimeInfo {
  os: string;
  arch: string;
}

type UpdaterOutcome =
  | 'no_update'
  | 'update_available'
  | 'open_failed'
  | 'fetch_failed'
  | 'version_unparsable';

export class DesktopUpdater implements AppModule {
  private ctx: AppContext;
  private updateCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  private readonly UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  init(): void {
    this.setupUpdateChecks();
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
    const logger = outcome === 'no_update' || outcome === 'update_available'
      ? console.info
      : console.warn;
    logger('[updater]', outcome, context);
  }

  private async checkForUpdate(): Promise<void> {
    try {
      const res = await fetch('https://api.worldmonitor.app/api/version', {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logUpdaterOutcome('fetch_failed', { status: res.status });
        return;
      }
      const data = await res.json();
      const remote = data.version as string;
      if (!remote) {
        this.logUpdaterOutcome('fetch_failed', { reason: 'missing_remote_version' });
        return;
      }

      const current = __APP_VERSION__;
      // #5908: three outcomes, not two. An unreadable version must never fall
      // into "up to date" — the old `Number('0-tech')` -> NaN path did exactly
      // that and logged `no_update`, so one malformed release stopped every
      // client updating with no trace. The mapping lives in
      // `decideUpdateOutcome` so a regression that collapses it fails a test.
      const decision = decideUpdateOutcome(remote, current);
      if (decision !== 'update_available') {
        this.logUpdaterOutcome(decision, { current, remote });
        return;
      }

      const dismissKey = `wm-update-dismissed-${remote}`;
      if (getDismissed(dismissKey)) {
        this.logUpdaterOutcome('update_available', { current, remote, dismissed: true });
        return;
      }

      const releaseUrl = typeof data.url === 'string' && data.url
        ? data.url
        : 'https://github.com/koala73/worldmonitor/releases/latest';
      this.logUpdaterOutcome('update_available', { current, remote, dismissed: false });
      trackUpdateShown(current, remote);
      await this.showUpdateToast(remote, releaseUrl);
    } catch (error) {
      this.logUpdaterOutcome('fetch_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private mapDesktopDownloadPlatform(os: string, arch: string): string | null {
    const normalizedOs = os.toLowerCase();
    const normalizedArch = arch.toLowerCase()
      .replace('amd64', 'x86_64')
      .replace('x64', 'x86_64')
      .replace('arm64', 'aarch64');

    if (normalizedOs === 'windows') {
      return normalizedArch === 'x86_64' ? 'windows-msi' : null;
    }

    if (normalizedOs === 'macos' || normalizedOs === 'darwin') {
      if (normalizedArch === 'aarch64') return 'macos-arm64';
      if (normalizedArch === 'x86_64') return 'macos-x64';
      return null;
    }

    if (normalizedOs === 'linux') {
      if (normalizedArch === 'x86_64') return 'linux-appimage';
      if (normalizedArch === 'aarch64') return 'linux-appimage-arm64';
      return null;
    }

    return null;
  }

  private async resolveUpdateDownloadUrl(releaseUrl: string): Promise<string> {
    try {
      const runtimeInfo = await invokeTauri<DesktopRuntimeInfo>('get_desktop_runtime_info');
      const platform = this.mapDesktopDownloadPlatform(runtimeInfo.os, runtimeInfo.arch);
      if (platform) {
        // #5908: one published desktop binary, variants switch in-app — so the
        // download is chosen by OS/arch alone. There is no per-variant asset to
        // disambiguate, and asking for one only ever produced a 302 to the
        // releases page.
        return `https://api.worldmonitor.app/api/download?platform=${platform}`;
      }
    } catch (error) {
      // Falls back to the release page, but says so: this is the same silent
      // class as #5908 — the user still gets a link, so a broken runtime probe
      // would otherwise degrade every download to the generic page unnoticed.
      this.logUpdaterOutcome('fetch_failed', {
        reason: 'runtime_info_unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return releaseUrl;
  }

  private async showUpdateToast(version: string, releaseUrl: string): Promise<void> {
    const existing = document.querySelector<HTMLElement>('.update-toast');
    if (existing?.dataset.version === version) return;
    existing?.remove();

    const url = await this.resolveUpdateDownloadUrl(releaseUrl);

    const toast = document.createElement('div');
    toast.className = 'update-toast';
    toast.dataset.version = version;
    setTrustedHtml(toast, trustedHtml(`
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
      <button class="update-toast-action" data-action="download">Download</button>
      <button class="update-toast-dismiss" data-action="dismiss" aria-label="Dismiss">\u00d7</button>
    `, "legacy direct innerHTML migration"));

    const dismissToast = () => {
      setDismissed(`wm-update-dismissed-${version}`);
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    };

    toast.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'download') {
        trackUpdateClicked(version);
        if (this.ctx.isDesktopApp) {
          void openExternalUrl(url)
            .then((outcome) => {
              if (outcome !== 'native') this.logUpdaterOutcome('open_failed', { url, outcome });
            })
            .catch((error) => {
              this.logUpdaterOutcome('open_failed', { url, error: error instanceof Error ? error.message : String(error) });
            });
        } else {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        dismissToast();
      } else if (action === 'dismiss') {
        trackUpdateDismissed(version);
        dismissToast();
      }
    });

    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => toast.classList.add('visible'));
    });
  }
}
