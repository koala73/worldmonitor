// DOM side of MCP Apps display modes, shared by the news-and-maps and country views.
import { layoutFlags, mergeHostContext, type PluginHostContext } from './plugin-host-context';

export const EXPAND_REFUSED = 'Claude kept this view in the conversation.';

type HostRequest = (method: string, params: object) => Promise<unknown>;

/**
 * Applies theme, safe-area padding, container fill and expand-button visibility.
 * Returns true when the view just left fill mode and should report its content height again.
 */
export function applyHostLayout(host: PluginHostContext, expandButton?: HTMLButtonElement): boolean {
  const flags = layoutFlags(host);
  const body = document.body;
  if (host.theme) document.documentElement.dataset.theme = host.theme;
  const insets = host.safeAreaInsets;
  body.style.paddingTop = insets?.top ? `${insets.top}px` : '';
  body.style.paddingRight = insets?.right ? `${insets.right}px` : '';
  body.style.paddingBottom = insets?.bottom ? `${insets.bottom}px` : '';
  body.style.paddingLeft = insets?.left ? `${insets.left}px` : '';
  const wasFilling = body.hasAttribute('data-wm-fill');
  body.toggleAttribute('data-wm-fill', flags.fillContainer);
  if (flags.fillContainer) body.style.setProperty('--wm-fill-height', `${host.containerDimensions!.height}px`);
  else body.style.removeProperty('--wm-fill-height');
  if (expandButton) expandButton.hidden = !flags.canExpand;
  return wasFilling && !flags.fillContainer;
}

/**
 * An icon button that asks the host for fullscreen. The request is sent synchronously
 * from the click because hosts refuse display-mode changes without a user gesture.
 */
export function createExpandButton(options: {
  className: string;
  request: HostRequest;
  getHost: () => PluginHostContext;
  setHost: (host: PluginHostContext) => void;
  onRefused: () => void;
}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = options.className;
  button.setAttribute('aria-label', 'Expand');
  button.title = 'Expand';
  button.hidden = true;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 16 16');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4');
  icon.appendChild(path);
  button.appendChild(icon);
  button.addEventListener('click', () => {
    const revision = options.getHost().displayModeRevision;
    void options.request('ui/request-display-mode', { mode: 'fullscreen' }).then(result => {
      if ((result as { mode?: unknown } | undefined)?.mode !== 'fullscreen') { options.onRefused(); return; }
      // A display-mode notification since the click is newer than this answer; keep it.
      // Other updates (theme, size) do not, so merge the granted mode into the latest state.
      const latest = options.getHost();
      if (latest.displayModeRevision !== revision) return;
      options.setHost(mergeHostContext(latest, { displayMode: 'fullscreen' }));
    }).catch(options.onRefused);
  });
  return button;
}
