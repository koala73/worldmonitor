const DEFAULT_REMOTE_HOSTS: Record<string, string> = {
  tech: 'https://tech.worldmonitor.app',
  full: 'https://worldmonitor.app',
  world: 'https://worldmonitor.app',
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

export function isDesktopRuntime(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const hasTauriGlobals = '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
  const userAgent = window.navigator?.userAgent ?? '';
  const tauriInUserAgent = userAgent.includes('Tauri');

  return hasTauriGlobals || tauriInUserAgent;
}

export function getApiBaseUrl(): string {
  if (!isDesktopRuntime()) {
    return '';
  }

  const configuredBaseUrl = import.meta.env.VITE_TAURI_API_BASE_URL;
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }

  const variant = import.meta.env.VITE_VARIANT || 'world';
  return DEFAULT_REMOTE_HOSTS[variant] ?? DEFAULT_REMOTE_HOSTS.world ?? 'https://worldmonitor.app';
}

export function toRuntimeUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return path;
  }

  return `${baseUrl}${path}`;
}
