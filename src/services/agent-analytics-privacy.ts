/**
 * Keeps agent-initiated UI selection on the issue #6212 telemetry allowlist.
 *
 * Map layer callbacks run synchronously inside selection, while panel-view
 * IntersectionObserver callbacks run later after a smooth scroll. The two
 * small mechanisms below cover those lifetimes without putting result content
 * into analytics state or changing the visible UI path.
 */

const PANEL_VIEW_SUPPRESSION_TTL_MS = 5_000;

let synchronousSuppressionDepth = 0;
const suppressedPanelViews = new Map<string, {
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}>();

export function runWithAgentAnalyticsSuppressed<T>(callback: () => T): T {
  synchronousSuppressionDepth += 1;
  try {
    return callback();
  } finally {
    synchronousSuppressionDepth -= 1;
  }
}

export function isAgentAnalyticsSuppressed(): boolean {
  return synchronousSuppressionDepth > 0;
}

export function suppressNextAgentPanelView(panelId: string, now = Date.now()): void {
  const previous = suppressedPanelViews.get(panelId);
  if (previous) clearTimeout(previous.timer);
  const expiresAt = now + PANEL_VIEW_SUPPRESSION_TTL_MS;
  const timer = setTimeout(() => {
    if (suppressedPanelViews.get(panelId)?.expiresAt === expiresAt) {
      suppressedPanelViews.delete(panelId);
    }
  }, PANEL_VIEW_SUPPRESSION_TTL_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  suppressedPanelViews.set(panelId, { expiresAt, timer });
}

export function isAgentPanelViewSuppressed(panelId: string, now = Date.now()): boolean {
  const suppression = suppressedPanelViews.get(panelId);
  if (!suppression) return false;
  if (suppression.expiresAt >= now) return true;
  clearTimeout(suppression.timer);
  suppressedPanelViews.delete(panelId);
  return false;
}
