declare module 'virtual:pwa-register' {
  export interface RegisterSWOptions {
    onRegisteredSW?: (swUrl: string, registration: ServiceWorkerRegistration | undefined) => void;
    onOfflineReady?: () => void;
    onNeedRefresh?: () => void;
  }
  export function registerSW(options?: RegisterSWOptions): (reloadPage?: boolean) => Promise<void>;
}
