export const EMBED_CREDENTIAL_SOURCE = 'worldmonitor-embed';
export const EMBED_API_KEY_PLACEHOLDER = 'YOUR_WM_API_KEY';
export const EMBED_CREDENTIAL_WAIT_MS = 3000;

interface EmbedCredentialMessage {
  source?: unknown;
  type?: unknown;
  key?: unknown;
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
 */
export function waitForEmbeddingApiKey(timeoutMs = EMBED_CREDENTIAL_WAIT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (key: string | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve(key);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== window.parent) return;
      const key = readEmbeddingApiKey(event.data);
      if (key) finish(key);
    };
    window.addEventListener('message', onMessage);
    window.setTimeout(() => finish(null), timeoutMs);
  });
}
