/**
 * Installs `replaceChildren` on `Element`, `Document` and `DocumentFragment`
 * on engines that lack it (Chrome < 86, Safari < 14, Firefox < 78). Every
 * page entry imports this module right after the AbortSignal fallbacks.
 *
 * Sentry WORLDMONITOR-1DP: an LG smart-TV browser threw
 * `this.tablistEl.replaceChildren is not a function` from `PanelTabBar.render`
 * during `App.init`, so the dashboard showed the boot-failure screen. src/ has
 * over 170 bare `replaceChildren` calls; installing the method once covers
 * them all, including code written later.
 *
 * Native implementations are never replaced. This module imports nothing, so
 * it cannot run app code before the fallback exists.
 */

type ParentWithAppend = Node & { append(...nodes: Array<Node | string>): void };

/** `replaceChildren` for engines without it: remove every child, then append the arguments. */
export function fallbackReplaceChildren(this: ParentWithAppend, ...nodes: Array<Node | string>): void {
  while (this.lastChild) this.removeChild(this.lastChild);
  if (nodes.length > 0) this.append(...nodes);
}

/** Define `replaceChildren` where it is missing; a no-op on current engines. */
export function installDomFallbacks(): void {
  const owners = [
    typeof Element === 'undefined' ? undefined : Element,
    typeof Document === 'undefined' ? undefined : Document,
    typeof DocumentFragment === 'undefined' ? undefined : DocumentFragment,
  ];
  for (const owner of owners) {
    const proto = owner?.prototype as { replaceChildren?: unknown; append?: unknown } | undefined;
    if (!proto || typeof proto.replaceChildren === 'function' || typeof proto.append !== 'function') continue;
    try {
      Object.defineProperty(proto, 'replaceChildren', {
        value: fallbackReplaceChildren,
        writable: true,
        configurable: true,
      });
    } catch {
      /* a frozen prototype keeps its old behavior */
    }
  }
}

installDomFallbacks();
