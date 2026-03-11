import { t } from '@/services/i18n';
import { getCanonicalApiOrigin } from '@/services/runtime';

export type Platform = 'macos-arm64' | 'macos-x64' | 'macos' | 'windows' | 'linux' | 'linux-x64' | 'linux-arm64' | 'unknown';

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  if (/Mac/i.test(ua)) {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') as WebGLRenderingContext | null;
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          if (/Apple M/i.test(renderer)) return 'macos-arm64';
          if (/Intel/i.test(renderer)) return 'macos-x64';
        }
      }
    } catch { /* ignore */ }
    return 'macos';
  }
  return 'unknown';
}

export interface DlButton { cls: string; href: string; label: string }

export function allButtons(): DlButton[] {
  const apiOrigin = getCanonicalApiOrigin();
  return [
    { cls: 'mac', href: `${apiOrigin}/api/download?platform=macos-arm64`, label: `\uF8FF ${t('modals.downloadBanner.macSilicon')}` },
    { cls: 'mac', href: `${apiOrigin}/api/download?platform=macos-x64`, label: `\uF8FF ${t('modals.downloadBanner.macIntel')}` },
    { cls: 'win', href: `${apiOrigin}/api/download?platform=windows-msi`, label: `\u229E ${t('modals.downloadBanner.windows')}` },
    { cls: 'linux', href: `${apiOrigin}/api/download?platform=linux-appimage`, label: `\u{1F427} ${t('modals.downloadBanner.linux')} (x64)` },
    { cls: 'linux', href: `${apiOrigin}/api/download?platform=linux-appimage-arm64`, label: `\u{1F427} ${t('modals.downloadBanner.linux')} (ARM64)` },
  ];
}

export function buttonsForPlatform(p: Platform): DlButton[] {
  const buttons = allButtons();
  switch (p) {
    case 'macos-arm64': return buttons.filter(b => b.href.includes('macos-arm64'));
    case 'macos-x64': return buttons.filter(b => b.href.includes('macos-x64'));
    case 'macos': return buttons.filter(b => b.cls === 'mac');
    case 'windows': return buttons.filter(b => b.cls === 'win');
    case 'linux': return buttons.filter(b => b.cls === 'linux');
    case 'linux-x64': return buttons.filter(b => b.href.includes('linux-appimage') && !b.href.includes('arm64'));
    case 'linux-arm64': return buttons.filter(b => b.href.includes('linux-appimage-arm64'));
    default: return buttons;
  }
}
