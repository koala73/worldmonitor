/// <reference types="vite/client" />

declare module '*?url' {
  const url: string;
  export default url;
}

declare const __APP_VERSION__: string;
declare const __BUILD_HASH__: string;
declare const __CLERK_JS_VERSION__: string;
declare const __VERSION__: string;

interface Window {
  umami?: {
    track: (event: string, data?: Record<string, unknown>) => void | Promise<unknown>;
    identify: (data?: Record<string, unknown>) => void | Promise<unknown>;
  };
}

interface ImportMetaEnv {
  readonly VITE_WORLDMONITOR_API_KEY?: string;
  readonly VITE_WM_MCP_URL?: string;
  readonly VITE_VARIANT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
