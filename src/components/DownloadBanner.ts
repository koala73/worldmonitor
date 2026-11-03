import { t } from '@/services/i18n';
import { getCanonicalApiOrigin } from '@/services/runtime';

const DETECT_PLATFORM_RE = /Windows/i;
const DETECT_PLATFORM_RE_2 = /Linux/i;
const DETECT_PLATFORM_RE_3 = /Android/i;
const DETECT_PLATFORM_RE_4 = /Mac/i;
const DETECT_PLATFORM_RE_5 = /Apple M/i;
const DETECT_PLATFORM_RE_6 = /Intel/i;


export type Platform = 'macos-arm64' | 'macos-x64' | 'macos' | 'windows' | 'linux' | 'linux-x64' | 'linux-arm64' | 'unknown';

export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (DETECT_PLATFORM_RE.test(ua)) return 'windows';
  if (DETECT_PLATFORM_RE_2.test(ua) && !DETECT_PLATFORM_RE_3.test(ua)) return 'linux';
  if (DETECT_PLATFORM_RE_4.test(ua)) {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') as WebGLRenderingContext | null;
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          if (DETECT_PLATFORM_RE_5.test(renderer)) return 'macos-arm64';
          if (DETECT_PLATFORM_RE_6.test(renderer)) return 'macos-x64';
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
