/**
 * Keyboard activation for click-target rows/cards built from template strings.
 *
 * Generalizes the pattern proven by market-chart-interactions.ts: the template
 * gives the element `tabindex="0"` (plus `role="button"` where it isn't a
 * table row — a role would override row semantics and break the table for AT,
 * same call RouteExplorer's rows made in #6964), and one delegated keydown on
 * the panel's stable content element turns Enter/Space into a click. The
 * synthesized click routes through the panel's EXISTING click delegation, so
 * activation behavior cannot drift between mouse and keyboard.
 *
 * Bind once on a stable container (panel content), not on re-rendered rows.
 * Repeated calls with the same root+selector are no-ops so a re-bind after a
 * same-HTML `setSafeContent` short-circuit cannot stack listeners.
 */
const boundActivationSelectors = new WeakMap<HTMLElement, Set<string>>();

export function bindActivationKeys(root: HTMLElement, selector: string): void {
  let selectors = boundActivationSelectors.get(root);
  if (!selectors) {
    selectors = new Set();
    boundActivationSelectors.set(root, selectors);
  }
  if (selectors.has(selector)) return;
  selectors.add(selector);

  root.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // Held keys repeat; Space would otherwise keep synthesizing clicks.
    if (event.repeat) return;
    const target = event.target as HTMLElement | null;
    const el = target?.closest<HTMLElement>(selector);
    if (!el || !root.contains(el)) return;
    // Focus can only sit on the row itself or on a nested native control
    // (link/button/input); nested controls keep their own Enter/Space.
    if (target !== el) return;
    event.preventDefault();
    el.click();
  });
}
