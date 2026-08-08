function loadBetaMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem('worldmonitor-beta-mode') === 'true';
  } catch {
    return false;
  }
}

export const BETA_MODE = loadBetaMode();
