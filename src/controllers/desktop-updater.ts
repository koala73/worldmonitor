/**
 * DesktopUpdater — handles desktop (Tauri) update checking, badge display,
 * and download URL resolution.
 *
 * Extracted from `src/App.ts`.
 */

import type { AppContext } from './app-context';
import { invokeTauri } from '@/services/tauri-bridge';

declare const __APP_VERSION__: string;

/* ------------------------------------------------------------------ */
/*  Local types                                                        */
/* ------------------------------------------------------------------ */

type UpdaterOutcome = 'no_update' | 'update_available' | 'open_failed' | 'fetch_failed';
type DesktopBuildVariant = 'full' | 'tech' | 'finance';

interface DesktopRuntimeInfo {
  os: string;
  arch: string;
}

const DESKTOP_BUILD_VARIANT: DesktopBuildVariant = (
  import.meta.env.VITE_VARIANT === 'tech' || import.meta.env.VITE_VARIANT === 'finance'
    ? import.meta.env.VITE_VARIANT
    : 'full'
);

/* ------------------------------------------------------------------ */
/*  Controller                                                         */
/* ------------------------------------------------------------------ */

export class DesktopUpdater {
  private readonly ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /* ---- Public API ------------------------------------------------ */

  setupUpdateChecks(): void {
    if (!this.ctx.isDesktopApp || this.ctx.isDestroyed) return;
    setTimeout(() => {
      if (this.ctx.isDestroyed) return;
      void this.checkForUpdate();
    }, 5000);
    if (this.ctx.updateCheckIntervalId) {
      clearInterval(this.ctx.updateCheckIntervalId);
    }
    this.ctx.updateCheckIntervalId = setInterval(() => {
      if (this.ctx.isDestroyed) return;
      void this.checkForUpdate();
    }, this.ctx.UPDATE_CHECK_INTERVAL_MS);
  }

  /** Clear the periodic update-check interval (for cleanup). */
  clearInterval(): void {
    if (this.ctx.updateCheckIntervalId) {
      clearInterval(this.ctx.updateCheckIntervalId);
      this.ctx.updateCheckIntervalId = null;
    }
  }

  getDesktopBuildVariant(): DesktopBuildVariant {
    return DESKTOP_BUILD_VARIANT;
  }

  /* ---- Private helpers ------------------------------------------- */

  private logUpdaterOutcome(outcome: UpdaterOutcome, context: Record<string, unknown> = {}): void {
    const logger = outcome === 'open_failed' || outcome === 'fetch_failed'
      ? console.warn
      : console.info;
    logger('[updater]', outcome, context);
  }

  private async checkForUpdate(): Promise<void> {
    try {
      const res = await fetch('https://intelhq.io/api/version');
      if (!res.ok) return;
      const data = await res.json();
      const remote = data.version as string;
      if (!remote) {
        this.logUpdaterOutcome('fetch_failed', { reason: 'missing_remote_version' });
        return;
      }
      const current = __APP_VERSION__;
      if (!this.isNewerVersion(remote, current)) {
        this.logUpdaterOutcome('no_update', { current, remote });
        return;
      }
      const dismissKey = `wm-update-dismissed-${remote}`;
      if (localStorage.getItem(dismissKey)) {
        this.logUpdaterOutcome('update_available', { current, remote, dismissed: true });
        return;
      }
      const releaseUrl = typeof data.url === 'string' && data.url
        ? data.url
        : 'https://github.com/koala73/worldmonitor/releases/latest';
      this.logUpdaterOutcome('update_available', { current, remote, dismissed: false });
      await this.showUpdateBadge(remote, releaseUrl);
    } catch (error) {
      this.logUpdaterOutcome('fetch_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
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
    const normalizedArch = arch.toLowerCase()
      .replace('amd64', 'x86_64')
      .replace('x64', 'x86_64')
      .replace('arm64', 'aarch64');
    if (normalizedOs === 'windows') {
      return normalizedArch === 'x86_64' ? 'windows-exe' : null;
    }
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
        return `https://intelhq.io/api/download?platform=${platform}`;
      }
    } catch {
      // Silent fallback to release page when desktop runtime info is unavailable.
    }
    return releaseUrl;
  }

  private async showUpdateBadge(version: string, releaseUrl: string): Promise<void> {
    const versionSpan = this.ctx.container.querySelector('.version');
    if (!versionSpan) return;
    const existingBadge = this.ctx.container.querySelector<HTMLElement>('.update-badge');
    if (existingBadge?.dataset.version === version) return;
    existingBadge?.remove();
    const url = await this.resolveUpdateDownloadUrl(releaseUrl);
    const badge = document.createElement('a');
    badge.className = 'update-badge';
    badge.dataset.version = version;
    badge.href = url;
    badge.target = this.ctx.isDesktopApp ? '_self' : '_blank';
    badge.rel = 'noopener';
    badge.textContent = `UPDATE v${version}`;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.ctx.isDesktopApp) {
        void invokeTauri<void>('open_url', { url }).catch((error) => {
          this.logUpdaterOutcome('open_failed', {
            url,
            error: error instanceof Error ? error.message : String(error),
          });
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
