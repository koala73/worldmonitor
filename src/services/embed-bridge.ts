/**
 * Embed Bridge — postMessage communication layer for iframe embedding.
 *
 * When WorldMonitor runs inside a Streamlit/xcu_my_apps iframe, this bridge:
 *  - Sends: selected events, book-worthiness scores, current filters, state changes
 *  - Receives: filter commands, highlight requests, recency changes from parent
 *
 * Protocol:
 *   All messages are JSON with a `type` field prefixed by "wm:" (WorldMonitor).
 *   Inbound (from parent):  "wm:set-recency", "wm:set-min-score", "wm:highlight-event", "wm:request-state"
 *   Outbound (to parent):   "wm:state-update", "wm:event-selected", "wm:book-worthy-events", "wm:ready"
 */

import type { ClusteredEvent } from '@/types';
import type { BookWorthinessScore } from './book-worthiness';
import type { RecencyRange } from '@/utils/recency';
import { isRecencyRange } from '@/utils/recency';
import { SITE_VARIANT } from '@/config/variant';

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

interface WmBaseMessage {
  type: string;
}

// Inbound (parent → WorldMonitor)
export interface WmSetRecencyMsg extends WmBaseMessage {
  type: 'wm:set-recency';
  range: RecencyRange;
}

export interface WmSetMinScoreMsg extends WmBaseMessage {
  type: 'wm:set-min-score';
  minScore: number;
}

export interface WmHighlightEventMsg extends WmBaseMessage {
  type: 'wm:highlight-event';
  eventId: string;
}

export interface WmRequestStateMsg extends WmBaseMessage {
  type: 'wm:request-state';
}

export type InboundMessage =
  | WmSetRecencyMsg
  | WmSetMinScoreMsg
  | WmHighlightEventMsg
  | WmRequestStateMsg;

// Outbound (WorldMonitor → parent)
export interface WmReadyMsg extends WmBaseMessage {
  type: 'wm:ready';
  variant: string;
}

export interface WmStateUpdateMsg extends WmBaseMessage {
  type: 'wm:state-update';
  recency: RecencyRange;
  minScore: number;
  totalEvents: number;
  bookWorthyCount: number;
}

export interface WmEventSelectedMsg extends WmBaseMessage {
  type: 'wm:event-selected';
  event: {
    id: string;
    title: string;
    source: string;
    link: string;
    sourceCount: number;
    category: string | undefined;
    threatLevel: string | undefined;
  };
  worthiness: BookWorthinessScore | null;
}

export interface WmBookWorthyEventsMsg extends WmBaseMessage {
  type: 'wm:book-worthy-events';
  events: Array<{
    id: string;
    title: string;
    score: number;
    recommendedFlavors: string[];
    rationale: string;
  }>;
}

export type OutboundMessage =
  | WmReadyMsg
  | WmStateUpdateMsg
  | WmEventSelectedMsg
  | WmBookWorthyEventsMsg;

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface EmbedBridgeCallbacks {
  onSetRecency?: (range: RecencyRange) => void;
  onSetMinScore?: (score: number) => void;
  onHighlightEvent?: (eventId: string) => void;
  onRequestState?: () => void;
}

// ---------------------------------------------------------------------------
// Bridge singleton
// ---------------------------------------------------------------------------

class EmbedBridge {
  private active = false;
  private callbacks: EmbedBridgeCallbacks = {};

  /** Initialise the bridge. Only activates when running inside an iframe. */
  init(callbacks: EmbedBridgeCallbacks = {}): void {
    // Only activate in codexes variant or when explicitly embedded
    const isEmbedded = window !== window.parent;
    if (!isEmbedded && SITE_VARIANT !== 'codexes') return;

    this.callbacks = callbacks;
    this.active = true;

    window.addEventListener('message', this.handleMessage);

    // Notify parent that WorldMonitor is ready
    this.send({ type: 'wm:ready', variant: SITE_VARIANT });
  }

  destroy(): void {
    if (!this.active) return;
    window.removeEventListener('message', this.handleMessage);
    this.active = false;
  }

  /** Whether the bridge is currently active (running inside an iframe). */
  get isActive(): boolean {
    return this.active;
  }

  // --- Outbound helpers ---

  sendStateUpdate(state: Omit<WmStateUpdateMsg, 'type'>): void {
    if (!this.active) return;
    this.send({ type: 'wm:state-update', ...state });
  }

  sendEventSelected(
    event: ClusteredEvent,
    worthiness: BookWorthinessScore | null,
  ): void {
    if (!this.active) return;
    this.send({
      type: 'wm:event-selected',
      event: {
        id: event.id,
        title: event.primaryTitle,
        source: event.primarySource,
        link: event.primaryLink,
        sourceCount: event.sourceCount,
        category: event.threat?.category,
        threatLevel: event.threat?.level,
      },
      worthiness,
    });
  }

  sendBookWorthyEvents(
    events: Array<{
      event: ClusteredEvent;
      worthiness: BookWorthinessScore;
    }>,
  ): void {
    if (!this.active) return;
    this.send({
      type: 'wm:book-worthy-events',
      events: events.map((e) => ({
        id: e.event.id,
        title: e.event.primaryTitle,
        score: e.worthiness.score,
        recommendedFlavors: e.worthiness.recommendedFlavors,
        rationale: e.worthiness.rationale,
      })),
    });
  }

  // --- Internal ---

  private send(msg: OutboundMessage): void {
    if (!this.active) return;
    try {
      window.parent.postMessage(msg, '*');
    } catch {
      // Swallow — cross-origin restrictions or no parent
    }
  }

  private handleMessage = (ev: MessageEvent): void => {
    const data = ev.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
    if (!data.type.startsWith('wm:')) return;

    switch (data.type) {
      case 'wm:set-recency':
        if (typeof data.range === 'string' && isRecencyRange(data.range)) {
          this.callbacks.onSetRecency?.(data.range);
        }
        break;
      case 'wm:set-min-score':
        if (typeof data.minScore === 'number') {
          this.callbacks.onSetMinScore?.(data.minScore);
        }
        break;
      case 'wm:highlight-event':
        if (typeof data.eventId === 'string') {
          this.callbacks.onHighlightEvent?.(data.eventId);
        }
        break;
      case 'wm:request-state':
        this.callbacks.onRequestState?.();
        break;
    }
  };
}

export const embedBridge = new EmbedBridge();
