/**
 * Integration Bridge — connects the agent system to the existing
 * App.ts orchestrator for incremental migration.
 *
 * The bridge:
 * 1. Converts existing service outputs into agent Signals
 * 2. Exposes agent pipeline results to existing UI components
 * 3. Provides an event adapter between App.ts events and the agent bus
 * 4. Allows gradual migration: individual services can be switched
 *    from direct App.ts calls to agent-managed tools.
 */

import type {
  IntelligenceBrief,
  AgentState,
} from './types';
import { AgentRuntime, type AgentConfig } from './runtime/agent';
import { agentBus } from './bus/event-bus';
import { createSignal } from './tools/registry';

// Import adapters and tools to register them
import './tools/adapters';
import './tools/sp500-sectors';
import './tools/earnings-capture';
import './tools/llm-provider';
import './tools/meteo-supply-chain';

// ============================================================================
// BRIDGE STATE
// ============================================================================

let runtime: AgentRuntime | null = null;
let bridgeListeners: Array<() => void> = [];

// ============================================================================
// BRIDGE API — for App.ts to call
// ============================================================================

/**
 * Initialize the agent system. Call once during app startup.
 */
export function initAgent(config?: Partial<AgentConfig>): AgentRuntime {
  if (runtime) {
    console.warn('[Bridge] Agent already initialized');
    return runtime;
  }

  runtime = new AgentRuntime(config);
  return runtime;
}

/**
 * Start the agent runtime.
 */
export function startAgent(): void {
  if (!runtime) throw new Error('Agent not initialized — call initAgent() first');
  runtime.start();
}

/**
 * Stop the agent runtime.
 */
export function stopAgent(): void {
  runtime?.stop();
}

/**
 * Get the latest intelligence brief for UI consumption.
 */
export function getLatestBrief(): IntelligenceBrief | null {
  return runtime?.getLatestBrief() ?? null;
}

/**
 * Get current agent state for status display.
 */
export function getAgentState(): AgentState | null {
  return runtime?.getState() ?? null;
}

/**
 * Subscribe to brief updates. Returns unsubscribe function.
 */
export function onBriefUpdate(handler: (brief: IntelligenceBrief) => void): () => void {
  const unsub = agentBus.on('signal:emitted', (event) => {
    handler(event.payload as IntelligenceBrief);
  });
  bridgeListeners.push(unsub);
  return unsub;
}

/**
 * Subscribe to agent phase changes. Returns unsubscribe function.
 */
export function onPhaseChange(handler: (phase: string) => void): () => void {
  const phases = ['agent:observe', 'agent:plan', 'agent:act', 'agent:reflect'] as const;
  const unsubs = phases.map(phase =>
    agentBus.on(phase, () => handler(phase.split(':')[1]!))
  );
  const unsub = () => unsubs.forEach(u => u());
  bridgeListeners.push(unsub);
  return unsub;
}

// ============================================================================
// SIGNAL ADAPTERS — convert existing service data to agent signals
// ============================================================================

/**
 * Convert existing ClusteredEvent[] from rss.ts into agent signals.
 */
export function injectNewsSignals(clusters: Array<{
  id: string;
  primaryTitle: string;
  primarySource: string;
  sourceCount: number;
  firstSeen: Date;
  isAlert: boolean;
  lat?: number;
  lon?: number;
}>): void {
  if (!runtime) return;

  const signals = clusters.map(c =>
    createSignal('news', {
      sourceId: c.id,
      severity: c.isAlert ? 'high' : c.sourceCount >= 5 ? 'medium' : 'low',
      regions: [],
      timestamp: c.firstSeen.getTime(),
      geo: c.lat && c.lon ? { lat: c.lat, lon: c.lon } : undefined,
      payload: c,
      confidence: Math.min(1, c.sourceCount / 5),
      tags: ['news', 'rss'],
      provenance: 'bridge:news',
    })
  );

  runtime.injectSignals(signals);
}

/**
 * Convert existing MilitaryFlight[] into agent signals.
 */
export function injectMilitarySignals(flights: Array<{
  icao24: string;
  callsign?: string;
  originCountry?: string;
  latitude?: number;
  longitude?: number;
}>): void {
  if (!runtime) return;

  const signals = flights.map(f =>
    createSignal('military', {
      sourceId: f.icao24,
      severity: 'medium',
      regions: f.originCountry ? [f.originCountry] : [],
      timestamp: Date.now(),
      geo: f.latitude && f.longitude ? { lat: f.latitude, lon: f.longitude } : undefined,
      payload: f,
      confidence: 0.85,
      tags: ['military', 'flight'],
      provenance: 'bridge:military',
    })
  );

  runtime.injectSignals(signals);
}

/**
 * Convert existing InternetOutage[] into agent signals.
 */
export function injectOutageSignals(outages: Array<{
  asn?: string;
  name?: string;
  countryCode?: string;
  severity?: string;
}>): void {
  if (!runtime) return;

  const signals = outages.map(o =>
    createSignal('infrastructure', {
      sourceId: o.asn ?? o.name ?? 'unknown',
      severity: o.severity === 'major' ? 'high' : 'medium',
      regions: o.countryCode ? [o.countryCode] : [],
      timestamp: Date.now(),
      payload: o,
      confidence: 0.8,
      tags: ['infrastructure', 'outage'],
      provenance: 'bridge:outage',
    })
  );

  runtime.injectSignals(signals);
}

/**
 * Convert existing SocialUnrestEvent[] into agent signals.
 */
export function injectUnrestSignals(events: Array<{
  id?: string;
  title?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  fatalities?: number;
}>): void {
  if (!runtime) return;

  const signals = events.map(e =>
    createSignal('unrest', {
      sourceId: e.id ?? e.title?.slice(0, 20) ?? 'unknown',
      severity: e.fatalities && e.fatalities > 0 ? 'high' : 'medium',
      regions: e.countryCode ? [e.countryCode] : [],
      timestamp: Date.now(),
      geo: e.latitude && e.longitude ? { lat: e.latitude, lon: e.longitude } : undefined,
      payload: e,
      confidence: 0.8,
      tags: ['unrest'],
      provenance: 'bridge:unrest',
    })
  );

  runtime.injectSignals(signals);
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Destroy the bridge and agent — call on app teardown.
 */
export function destroyAgent(): void {
  stopAgent();
  for (const unsub of bridgeListeners) {
    unsub();
  }
  bridgeListeners = [];
  runtime = null;
}
