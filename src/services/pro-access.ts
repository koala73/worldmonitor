function getCookieValue(name: string): string {
  try {
    const match = document.cookie
      .split(';')
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith(`${name}=`));
    return match ? match.slice(name.length + 1) : '';
  } catch {
    return '';
  }
}

function getStoredKey(name: string): string {
  const cookieVal = getCookieValue(name);
  if (cookieVal) {
    try {
      return decodeURIComponent(cookieVal).trim();
    } catch {
      return cookieVal.trim();
    }
  }
  try {
    return (localStorage.getItem(name) ?? '').trim();
  } catch {
    return '';
  }
}

export function isProUser(): boolean {
  return !!getStoredKey('wm-widget-key') || !!getStoredKey('wm-pro-key');
}

export function getWidgetAgentKey(): string {
  return getStoredKey('wm-widget-key');
}

export function getProWidgetKey(): string {
  return getStoredKey('wm-pro-key');
}

export function isWidgetFeatureEnabled(): boolean {
  return !!getStoredKey('wm-widget-key');
}

export function isProWidgetEnabled(): boolean {
  return !!getStoredKey('wm-pro-key');
}
