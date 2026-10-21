/**
 * The `shown/total` badge every renderer uses to disclose a marker budget cut.
 *
 * Quietly dropping 2,000 conflict events off a monitoring product would
 * misrepresent the data, so the withholding is stated in the panel that controls
 * it (#5368 for the globe, #7112 for the SVG overlay). Both renderers reached
 * that conclusion independently and grew a near-identical 20-line copy of the
 * DOM write, down to a duplicated 40-word title string with one word changed —
 * which is how two renderers drift into disclosing different things about the
 * same cut. One implementation, one wording, one place to fix.
 *
 * Kept out of `globe-marker-budget.ts` on purpose: that module is deliberately
 * free of DOM imports so the selection algorithm can be unit-tested directly.
 */
import type { GlobeLayerTruncation } from './globe-marker-budget';

/** How the renderer's viewport moves, for the badge's "… to bring others in". */
export type TruncationMoveVerb = 'pan' | 'rotate';

export interface TruncationBadgeResult {
  /** Layer keys that had a toggle row and now carry a badge. */
  disclosed: string[];
  /**
   * Layer keys the budget trimmed that have NO toggle row in this picker, so the
   * cut could not be disclosed anywhere. Returned rather than silently dropped:
   * a trimmed layer the user cannot see the count for is indistinguishable from
   * missing data, and the caller needs to be able to assert on the set.
   */
  undisclosed: string[];
}

/**
 * Writes/removes `.layer-truncation-count` badges on `root`'s toggle rows.
 *
 * Idempotent: reuses an existing badge, removes it when the layer is no longer
 * truncated, so repeated calls converge rather than accumulating nodes.
 */
export function renderLayerTruncationBadges(
  root: HTMLElement,
  truncation: Readonly<Record<string, GlobeLayerTruncation>>,
  moveVerb: TruncationMoveVerb,
): TruncationBadgeResult {
  const disclosed: string[] = [];
  const rowLayers = new Set<string>();

  for (const row of Array.from(root.querySelectorAll<HTMLElement>('.layer-toggle-row'))) {
    const layer = row.dataset.layer;
    if (layer) rowLayers.add(layer);
    const counts = layer ? truncation[layer] : undefined;
    const existing = row.querySelector<HTMLElement>('.layer-truncation-count');
    if (!counts) { existing?.remove(); continue; }
    const badge = existing ?? document.createElement('span');
    if (!existing) {
      // Sibling of the toggle control, not a child: inside it, every click on
      // the badge would toggle the layer off. `.layer-explain-btn` sits outside
      // the label for the same reason.
      badge.className = 'layer-truncation-count';
      row.appendChild(badge);
    }
    badge.textContent = `${counts.shown}/${counts.total}`;
    // Untranslated literal: a new i18n key is a ~29-file change across locales,
    // and the badge itself is numeric. Real key tracked as follow-up.
    // Says "nearest this view" rather than "highest priority" because that is
    // what the ranking actually does for layers with no severity of their own.
    badge.title = `Showing ${counts.shown} of ${counts.total} markers — the most significant, and those nearest the current view. The map caps markers per layer to keep interaction responsive; ${moveVerb} or zoom to bring others in.`;
    if (layer) disclosed.push(layer);
  }

  const undisclosed = Object.keys(truncation).filter((layer) => !rowLayers.has(layer));
  return { disclosed, undisclosed };
}
