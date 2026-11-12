/**
 * Fatal boot-failure screen, rendered from the main.ts boot .catch when
 * `app.init()` rejects. The dashboard is half-initialised (or already torn
 * down) at that point, so this module must work with nothing but the DOM:
 * no app code, no i18n, no dashboard stylesheet — plain elements and inline
 * styles only, in the same visual family as public/404.html and
 * public/500.html (branded, dark).
 */

const SCREEN_ID = 'wm-boot-failure';

// system-ui covers the -apple-system/"Segoe UI" fallbacks of the static error
// pages' longer stack on every browser this bundle supports.
const FONT_STACK = 'Inter,ui-sans-serif,system-ui,sans-serif';

/** Readable one-line summary of the boot error for the detail strip. */
function describeBootError(error: unknown): string {
  let text: string;
  if (error instanceof Error && error.message) {
    text = error.message;
  } else {
    try {
      text = String(error);
    } catch {
      text = '';
    }
  }
  text = text.trim() || 'Unknown error';
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function styled<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cssText: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.style.cssText = cssText;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Covers the whole viewport with a branded fatal-error screen. Idempotent:
 * a second call (e.g. a re-entered boot path) leaves the first screen alone.
 */
export function renderBootFailureScreen(error: unknown): void {
  if (document.getElementById(SCREEN_ID)) return;

  const overlay = styled(
    'div',
    'position:fixed;inset:0;z-index:2147483000;overflow:auto;display:grid;place-items:center;' +
      'padding:24px 20px;background:#050807;color:#eef8f0;color-scheme:dark;' +
      `font-family:${FONT_STACK};line-height:1.55;`,
  );
  overlay.id = SCREEN_ID;
  overlay.setAttribute('role', 'alert');

  const column = styled('div', 'max-width:560px;width:100%;');

  const brand = styled(
    'p',
    'display:flex;align-items:center;gap:8px;margin:0 0 36px;font-size:15px;font-weight:700;',
    'World Monitor',
  );
  brand.prepend(
    styled('span', 'width:10px;height:10px;border-radius:2px;background:#4ade80;flex:none;'),
  );
  brand.firstElementChild?.setAttribute('aria-hidden', 'true');

  const eyebrow = styled(
    'p',
    'margin:0 0 12px;color:#4ade80;text-transform:uppercase;letter-spacing:0.08em;font-size:12px;font-weight:700;',
    'Startup error',
  );

  const heading = styled(
    'h1',
    'margin:0 0 16px;font-size:clamp(26px,5vw,38px);line-height:1.1;letter-spacing:-0.01em;',
    'The dashboard couldn’t start',
  );

  const lede = styled(
    'p',
    'margin:0;color:#a8b8ad;font-size:17px;',
    'Something went wrong while World Monitor was loading. This is usually temporary — reloading fixes most cases.',
  );

  const detail = styled(
    'p',
    'margin:20px 0 0;padding:10px 14px;border:1px solid #1b2b22;border-radius:8px;background:#0c1210;' +
      'color:#a8b8ad;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow-wrap:anywhere;',
    describeBootError(error),
  );

  const actions = styled(
    'div',
    'display:flex;align-items:center;gap:8px 20px;flex-wrap:wrap;margin-top:28px;',
  );

  const reload = styled(
    'button',
    'display:inline-flex;align-items:center;min-height:44px;padding:12px 18px;border:0;border-radius:8px;' +
      `background:#4ade80;color:#04170c;font-family:${FONT_STACK};font-weight:700;font-size:15px;cursor:pointer;outline-offset:3px;`,
    'Reload the dashboard',
  );
  reload.type = 'button';
  reload.addEventListener('click', () => {
    // reload:user-initiated — the user pressed Reload on a dead dashboard, so
    // the modal guard does not apply: deferring a direct instruction would be
    // a bug, and the failed App has already torn its overlays down.
    location.reload();
  });

  const home = styled(
    'a',
    'display:inline-flex;align-items:center;min-height:44px;color:#4ade80;font-size:15px;text-decoration:none;outline-offset:3px;',
    'World Monitor homepage',
  );
  home.href = '/';

  actions.append(reload, home);
  column.append(brand, eyebrow, heading, lede, detail, actions);
  overlay.append(column);
  // Teardown leaves an already-rendered header in place; covering it is not
  // enough, its controls would stay in the tab order behind the screen.
  for (const sibling of Array.from(document.body.children)) {
    sibling.setAttribute('inert', '');
  }
  document.body.appendChild(overlay);
  reload.focus();
}
