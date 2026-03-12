

type SseCallback = (payload: any) => void;

class SseClient {
  private eventSource: EventSource | null = null;
  private listeners: Map<string, Set<SseCallback>> = new Map();
  private isConnecting = false;
  private reconnectTimer: number | null = null;
  private retryCount = 0;
  private maxRetries = 10;
  private baseBackoffMs = 2000;

  constructor() {
    // Lazy initialization, wait for first subscriber
  }

  private async connect() {
    if (this.eventSource || this.isConnecting) return;
    this.isConnecting = true;

    // Use dynamic import to avoid circular dependency with runtime.ts during E2E mocks
    const { getRemoteApiBaseUrl } = await import('./runtime');

    // The relay runs on WS_RELAY_URL (usually port 3004)
    // We get the base URL and modify it to hit the SSE endpoint
    let baseUrl = getRemoteApiBaseUrl();
    // If not local, the relay might be under a different domain or path,
    // but typically `getRemoteApiBaseUrl()` returns the relay URL in frontend config.
    // Ensure we hit the root relay path:
    const sseUrl = `${baseUrl.replace(/\/api$/, '')}/sse`;

    console.log('[SseClient] Connecting to', sseUrl);

    try {
      this.eventSource = new EventSource(sseUrl);

      this.eventSource.onopen = () => {
        console.log('[SseClient] Connected');
        this.isConnecting = false;
        this.retryCount = 0;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.eventSource.onerror = (err) => {
        console.warn('[SseClient] Connection error:', err);
        this.cleanup();
        this.scheduleReconnect();
      };

      // Listen to specific channels
      this.eventSource.addEventListener('telegram', (e: MessageEvent) => {
        this.dispatch('telegram', e.data);
      });

      this.eventSource.addEventListener('oref', (e: MessageEvent) => {
        this.dispatch('oref', e.data);
      });

      // Internal connection test
      this.eventSource.addEventListener('connection', (e: MessageEvent) => {
        console.log('[SseClient] Connection ack:', e.data);
      });

    } catch (e) {
      console.error('[SseClient] Failed to initialize EventSource:', e);
      this.cleanup();
      this.scheduleReconnect();
    }
  }

  private cleanup() {
    this.isConnecting = false;
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.retryCount >= this.maxRetries) return;

    this.retryCount++;
    // Exponential backoff with jitter
    const backoff = Math.min(30000, this.baseBackoffMs * Math.pow(1.5, this.retryCount));
    const jitter = backoff * 0.2 * Math.random();
    const delay = backoff + jitter;

    console.log(`[SseClient] Reconnecting in ${Math.round(delay)}ms (Attempt ${this.retryCount}/${this.maxRetries})`);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private dispatch(eventType: string, rawData: string) {
    let payload;
    try {
      payload = JSON.parse(rawData);
    } catch {
      payload = rawData;
    }

    const cbs = this.listeners.get(eventType);
    if (cbs) {
      for (const cb of cbs) {
        try {
          cb(payload);
        } catch (e) {
          console.error(`[SseClient] Error in ${eventType} listener:`, e);
        }
      }
    }
  }

  public subscribe(eventType: string, callback: SseCallback): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType)!.add(callback);

    // Re-connect if disconnected (lazy initialization / resume)
    if (!this.eventSource && !this.isConnecting && !this.reconnectTimer) {
      this.retryCount = 0;
      this.connect();
    }

    // Return unsubscribe function
    return () => {
      const cbs = this.listeners.get(eventType);
      if (cbs) {
        cbs.delete(callback);
        if (cbs.size === 0) {
          this.listeners.delete(eventType);
        }
      }
    };
  }
}

// Singleton instance - lazy initialized
let instance: SseClient | null = null;
export function getSseClient(): SseClient {
  if (!instance) {
    instance = new SseClient();
  }
  return instance;
}
