/// <reference types="vite/client" />

interface Window {
  umami?: {
    // Tracker calls are async. Umami v3.1.0 swallows its internal fetch
    // failures, while test/extension wrappers can still return a rejecting
    // promise, so the facade must retain and observe the real return value.
    track: (event: string, data?: Record<string, unknown>) => void | Promise<unknown>;
    identify: (data: Record<string, unknown>) => void | Promise<unknown>;
  };
}

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;
declare const __CLERK_JS_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_WS_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
