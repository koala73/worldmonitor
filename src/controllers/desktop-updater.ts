import { invokeTauri } from '@/services/tauri-bridge';

export type UpdaterOutcome = 'no_update' | 'update_available' | 'open_failed' | 'fetch_failed';
type DesktopBuildVariant = 'full' | 'tech' | 'finance';

interface DesktopRuntimeInfo {
  os: string;
  arch: string;
}

interface DesktopUpdaterDeps {
  container: HTMLElement;
  isDesktopApp: boolean;
  isDestroyed: () => boolean;
  getBuildVariant: () => DesktopBuildVariant;
  updateIntervalMs: number;
}

export class DesktopUpdater {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: DesktopUpdaterDeps) {}

  public setup(): void {
    if (!this.deps.isDesktopApp || this.deps.isDestroyed()) return;

    setTimeout(() => {
      if (this.deps.isDestroyed()) return;
      void this.checkForUpdate();
    }, 5000);

    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = setInterval(() => {
      if (this.deps.isDestroyed()) return;
      void this.checkForUpdate();
    }, this.deps.updateIntervalMs);
  }

  public teardown(): void {
    if (!this.intervalId) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private logOutcome(outcome: UpdaterOutcome, context: Record<string, unknown> = {}): void {
    const logger = outcome === 'open_failed' || outcome === 'fetch_failed' ? console.warn : console.info;
    logger('[updater]', outcome, context);
  }

  private async checkForUpdate(): Promise<void> {
    try {
      const res = await fetch('https://worldmonitor.app/api/version');
      if (!res.ok) {
        this.logOutcome('fetch_failed', { status: res.status });
        return;
      }
      const data = await res.json();
      const remote = data.version as string;
      if (!remote) {
        this.logOutcome('fetch_failed', { reason: 'missing_remote_version' });
        return;
      }

      const current = __APP_VERSION__;
      if (!this.isNewerVersion(remote, current)) {
        this.logOutcome('no_update', { current, remote });
        return;
      }

      const dismissKey = `wm-update-dismissed-${remote}`;
      if (localStorage.getItem(dismissKey)) {
        this.logOutcome('update_available', { current, remote, dismissed: true });
        return;
      }

      const releaseUrl = typeof data.url === 'string' && data.url
        ? data.url
        : 'https://github.com/koala73/worldmonitor/releases/latest';
      this.logOutcome('update_available', { current, remote, dismissed: false });
      await this.showUpdateBadge(remote, releaseUrl);
    } catch (error) {
      this.logOutcome('fetch_failed', { error: error instanceof Error ? error.message : String(error) });
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

  private mapDesktopDownloadPlatform(os: string, arch: string): string | null {
    const normalizedOs = os.toLowerCase();
    const normalizedArch = arch.toLowerCase().replace('amd64', 'x86_64').replace('x64', 'x86_64').replace('arm64', 'aarch64');
    if (normalizedOs === 'windows') return normalizedArch === 'x86_64' ? 'windows-exe' : null;
    if (normalizedOs === 'macos' || normalizedOs === 'darwin') {
      if (normalizedArch === 'aarch64') return 'macos-arm64';
      if (normalizedArch === 'x86_64') return 'macos-x64';
      return null;
    }
    return null;
  }

  private async resolveUpdateDownloadUrl(releaseUrl: string): Promise<string> {
    try {
      const runtimeInfo = await invokeTauri<DesktopRuntimeInfo>('get_desktop_runtime_info');
      const platform = this.mapDesktopDownloadPlatform(runtimeInfo.os, runtimeInfo.arch);
      if (platform) {
        const variant = this.deps.getBuildVariant();
        return `https://worldmonitor.app/api/download?platform=${platform}&variant=${variant}`;
      }
    } catch {
      // noop fallback
    }
    return releaseUrl;
  }

  private async showUpdateBadge(version: string, releaseUrl: string): Promise<void> {
    const versionSpan = this.deps.container.querySelector('.version');
    if (!versionSpan) return;
    const existingBadge = this.deps.container.querySelector<HTMLElement>('.update-badge');
    if (existingBadge?.dataset.version === version) return;
    existingBadge?.remove();

    const url = await this.resolveUpdateDownloadUrl(releaseUrl);
    const badge = document.createElement('a');
    badge.className = 'update-badge';
    badge.dataset.version = version;
    badge.href = url;
    badge.target = this.deps.isDesktopApp ? '_self' : '_blank';
    badge.rel = 'noopener';
    badge.textContent = `UPDATE v${version}`;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.deps.isDesktopApp) {
        void invokeTauri<void>('open_url', { url }).catch((error) => {
          this.logOutcome('open_failed', { url, error: error instanceof Error ? error.message : String(error) });
          window.open(url, '_blank', 'noopener');
        });
        return;
      }
      window.open(url, '_blank', 'noopener');
    });

    const dismiss = document.createElement('span');
    dismiss.className = 'update-badge-dismiss';
    dismiss.textContent = '\u00d7';
    dismiss.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      localStorage.setItem(`wm-update-dismissed-${version}`, '1');
      badge.remove();
    });

    badge.appendChild(dismiss);
    versionSpan.insertAdjacentElement('afterend', badge);
  }
}
