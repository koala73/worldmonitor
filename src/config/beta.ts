export const BETA_MODE = typeof window !== 'undefined'
  && localStorage.getItem('worldmonitor-beta-mode') === 'true';
