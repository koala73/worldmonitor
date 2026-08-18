export const EMBED_CREDENTIAL_SOURCE = 'worldmonitor-embed';
export const EMBED_CREDENTIAL_READY_TYPE = 'ready';
export const EMBED_API_KEY_PLACEHOLDER = 'YOUR_WM_API_KEY';
export const EMBED_CREDENTIAL_WAIT_MS = 3000;

interface EmbedCredentialMessage {
  source?: unknown;
  type?: unknown;
  key?: unknown;
}

export interface EmbedCredentialHost {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  parent: { postMessage(message: unknown, targetOrigin: string): void };
  setTimeout(handler: () => void, timeout: number): number;
}

function readEmbeddingApiKey(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const message = data as EmbedCredentialMessage;
  if (message.source !== EMBED_CREDENTIAL_SOURCE || message.type !== 'credential') return null;
  if (typeof message.key !== 'string') return null;
  const key = message.key.trim();
  if (!key || key === EMBED_API_KEY_PLACEHOLDER) return null;
  return key;
}

/**
 * Wait for the partner loader to post the embedding account's API key.
 * The iframe URL must never carry the key; only `window.parent` may supply it.
 *
 * `host` is injectable so Node tests can drive the handshake without jsdom.
 * Production callers omit it and use the iframe `window`.
 */
export function waitForEmbeddingApiKey(
  timeoutMs = EMBED_CREDENTIAL_WAIT_MS,
  host: EmbedCredentialHost = window,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (key: string | null): void => {
      if (settled) return;
      settled = true;
      host.removeEventListener('message', onMessage);
      resolve(key);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== host.parent) return;
      const key = readEmbeddingApiKey(event.data);
      if (key) finish(key);
    };
    host.addEventListener('message', onMessage);
    try {
      host.parent.postMessage(
        { source: EMBED_CREDENTIAL_SOURCE, type: EMBED_CREDENTIAL_READY_TYPE },
        '*',
      );
    } catch {
      // Tests and sandboxed frames may lack a parent postMessage target.
    }
    host.setTimeout(() => finish(null), timeoutMs);
  });
}
