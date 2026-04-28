interface Window {
  umami?: {
    track: (event: string, data?: Record<string, unknown>) => void;
    identify: (data: Record<string, unknown>) => void;
  };
}

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly BASE_URL: string;
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly SSR: boolean;
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_WS_API_URL?: string;
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  glob<T = unknown>(
    pattern: string | string[],
    options?: { eager?: boolean; import?: string; query?: string },
  ): Record<string, () => Promise<T>>;
}
