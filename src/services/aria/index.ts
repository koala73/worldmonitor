/**
 * Aria Service
 * Handles JARVIS-like intelligent analysis and integration with WorldMonitor
 */

export interface AriaQuery {
  query: string;
  mode?: "analytical" | "proactive" | "advisory" | "exploratory";
  domains?: string[];
  regions?: string[];
  show_reasoning?: boolean;
}

export interface AriaResponse {
  conversation_id: string;
  message_sequence: number;
  metadata: {
    mode: string;
    confidence: number;
    sources: string[];
    timestamp: string;
  };
  content: string;
  actions: Array<{
    widget_name: string;
    action_type: string;
    reason: string;
    relevance: number;
  }>;
}

export interface AwarenessState {
  as_of: string;
  focus_areas: Array<{
    domain: string;
    region: string;
    topic: string;
    intensity: number;
    status: string;
  }>;
  recent_events: Array<{
    occurred_at: string;
    title: string;
    description: string;
    affected_domains: string[];
    affected_regions: string[];
    impact_score: number;
  }>;
  active_alerts: Array<{
    alert_id: string;
    severity: string;
    title: string;
    description: string;
    created_at: string;
  }>;
  system_confidence: number;
  data_freshness: number;
  sources_connected: number;
}

/**
 * Stream query to Aria and handle SSE responses
 */
export async function* queryAria(query: AriaQuery): AsyncGenerator<any> {
  const response = await fetch("/api/aria/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });

  if (!response.ok) {
    throw new Error(`Aria query failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body from Aria");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Process complete lines
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];

        if (line.startsWith("event:")) {
          const eventType = line.substring(6).trim();
          const dataLine = lines[i + 1];

          if (dataLine?.startsWith("data:")) {
            try {
              const data = JSON.parse(dataLine.substring(5));
              yield {
                event: eventType,
                data,
              };
            } catch (e) {
              console.warn("Failed to parse Aria event data:", e);
            }
          }
        }
      }

      // Keep incomplete line in buffer
      buffer = lines[lines.length - 1];
    }

    // Process remaining buffer
    if (buffer && buffer.startsWith("event:")) {
      const lines = buffer.split("\n");
      if (lines.length > 1 && lines[1].startsWith("data:")) {
        try {
          const data = JSON.parse(lines[1].substring(5));
          yield {
            event: lines[0].substring(6).trim(),
            data,
          };
        } catch (e) {
          console.warn("Failed to parse final Aria event:", e);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Get current Aria awareness state
 */
export async function getAriaAwareness(
  options?: {
    include_recent_events?: boolean;
    include_alerts?: boolean;
    include_trending?: boolean;
  }
): Promise<AwarenessState> {
  const params = new URLSearchParams();
  if (options?.include_recent_events !== undefined) {
    params.set("include_recent_events", String(options.include_recent_events));
  }
  if (options?.include_alerts !== undefined) {
    params.set("include_alerts", String(options.include_alerts));
  }
  if (options?.include_trending !== undefined) {
    params.set("include_trending", String(options.include_trending));
  }

  const response = await fetch(
    `/api/aria/awareness?${params.toString()}`
  );

  if (!response.ok) {
    throw new Error(`Failed to get Aria awareness: ${response.status}`);
  }

  return response.json();
}

/**
 * Generate an intelligence report
 */
export async function* generateIntelligenceReport(
  topic: string,
  options?: {
    report_type?: "briefing" | "analysis" | "risk-assessment" | "forecast";
    focus_regions?: string[];
    include_visualizations?: boolean;
  }
): AsyncGenerator<any> {
  const response = await fetch("/api/aria/intelligence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      topic,
      report_type: options?.report_type || "briefing",
      focus_regions: options?.focus_regions || [],
      include_visualizations: options?.include_visualizations || false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Intelligence report failed: ${response.status}`);
  }

  if (!response.body) {
    throw new Error("No response body for intelligence report");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];

        if (line.startsWith("event:")) {
          const eventType = line.substring(6).trim();
          const dataLine = lines[i + 1];

          if (dataLine?.startsWith("data:")) {
            try {
              const data = JSON.parse(dataLine.substring(5));
              yield {
                event: eventType,
                data,
              };
            } catch (e) {
              console.warn("Failed to parse report event:", e);
            }
          }
        }
      }

      buffer = lines[lines.length - 1];
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Analyze a specific topic with optional filters
 */
export async function analyzeWithAria(
  topic: string,
  domains: string[] = [],
  regions: string[] = []
): Promise<AsyncGenerator<any>> {
  return queryAria({
    query: topic,
    mode: "analytical",
    domains: domains.length > 0 ? domains : undefined,
    regions: regions.length > 0 ? regions : undefined,
  });
}

/**
 * Get proactive risk alerts from Aria
 */
export async function getAriaAlerts(
  severity?: "info" | "warning" | "critical"
): Promise<void> {
  const params = new URLSearchParams();
  if (severity) {
    params.set("severity", severity);
  }

  const response = await fetch(`/api/aria/stream-alerts?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Failed to get alerts: ${response.status}`);
  }

  // Handle WebSocket/SSE streaming
  return response.body;
}

/**
 * Cache for Aria awareness state
 */
let awarenessCache: AwarenessState | null = null;
let awarenessCacheTime = 0;
const AWARENESS_CACHE_TTL = 30000; // 30 seconds

/**
 * Get cached awareness state (with auto-refresh)
 */
export async function getCachedAwarenessState(): Promise<AwarenessState> {
  const now = Date.now();
  if (
    awarenessCache &&
    now - awarenessCacheTime < AWARENESS_CACHE_TTL
  ) {
    return awarenessCache;
  }

  awarenessCache = await getAriaAwareness({
    include_recent_events: true,
    include_alerts: true,
    include_trending: true,
  });
  awarenessCacheTime = now;

  return awarenessCache;
}

/**
 * Reset awareness cache
 */
export function resetAwarenessCache(): void {
  awarenessCache = null;
  awarenessCacheTime = 0;
}
