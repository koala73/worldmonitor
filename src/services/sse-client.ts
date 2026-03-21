export type SseCallback<T = any> = (payload: T) => void;

class SseClient {
  private eventSource: EventSource | null = null;
  private listeners: Map<string, Set<SseCallback>> = new Map();
  private isConnecting = false;
  private reconnectTimer: number | null = null;
  private retryCount = 0;
  private maxRetries = 10;
  private baseBackoffMs = 2000;

  // We need a stable reference to uniquely unbind if necessary.
  private sourceListeners: Map<string, (e: MessageEvent) => void> = new Map();

  constructor() {
    // Lazy initialization, wait for first subscriber
  }

  private async connect() {
    if (this.eventSource || this.isConnecting) return;
    this.isConnecting = true;

    // Use dynamic import to avoid circular dependency with runtime.ts during E2E mocks
    const { getSseEndpointUrl } = await import('./runtime');
    const sseUrl = getSseEndpointUrl();

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

      // Internal connection test
      this.eventSource.addEventListener('connection', (e: MessageEvent) => {
        console.log('[SseClient] Connection ack:', e.data);
      });

      // Bind all currently subscribed event types
      for (const eventType of this.listeners.keys()) {
        this.bindEventSourceListener(eventType);
      }

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
    this.sourceListeners.clear();
  }

  private bindEventSourceListener(eventType: string) {
    if (!this.eventSource || this.sourceListeners.has(eventType)) return;
    
    const handler = (e: MessageEvent) => {
      this.dispatch(eventType, e.data);
    };
    
    this.eventSource.addEventListener(eventType, handler);
    this.sourceListeners.set(eventType, handler);
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

  public subscribe<T = any>(eventType: string, callback: SseCallback<T>): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
      this.bindEventSourceListener(eventType);
    }
    this.listeners.get(eventType)!.add(callback as SseCallback);

    // Re-connect if disconnected (lazy initialization / resume)
    if (!this.eventSource && !this.isConnecting && !this.reconnectTimer) {
      this.retryCount = 0;
      this.connect();
    }

    // Return unsubscribe function
    return () => {
      const cbs = this.listeners.get(eventType);
      if (cbs) {
        cbs.delete(callback as SseCallback);
        if (cbs.size === 0) {
          this.listeners.delete(eventType);
          // If no listeners at all, disconnect EventSource to save bandwidth
          if (this.listeners.size === 0) {
            console.log('[SseClient] No more listeners, closing connection');
            this.cleanup();
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
          }
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
