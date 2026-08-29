// Extension-qualified because vite.config.ts imports this module, and Vite's
// native config loader cannot resolve an extensionless relative import there.
import { MOTION, PALETTE } from './theme';

/** The placeholder-to-value map the Vite plugin substitutes into
 *  `src/styles/*.css` at build/serve time.
 *
 *  CSS cannot import TypeScript, so without this the stylesheets would
 *  hand-copy values out of theme.ts — two sources of truth that drift silently,
 *  because nothing fails when they disagree. Colours drift into a
 *  slightly-wrong red; durations drift into an animation that is handed off
 *  before it finishes.
 *
 *  This lives in its own module rather than inside vite.config.ts so the drift
 *  guard in css-tokens.test.ts can check the SAME map the build uses. A test
 *  that rebuilt the map itself would pass while the build shipped a literal
 *  `__OPENEYE_DOCK_MS__` into a transition-duration. */

/** `dockMs` -> `__OPENEYE_DOCK_MS__`, `titleDockMs` -> `__OPENEYE_TITLE_DOCK_MS__`. */
function motionToken(key: string): string {
  const screaming = key.replace(/Ms$/, '').replace(/([A-Z])/g, '_$1').toUpperCase();
  return `__OPENEYE_${screaming}_MS__`;
}

export const CSS_TOKENS: Readonly<Record<string, string>> = {
  __OPENEYE_BG__: PALETTE.bg,
  __OPENEYE_RED__: PALETTE.red,
  __OPENEYE_MAGENTA__: PALETTE.magenta,
  __OPENEYE_PHOSPHOR__: PALETTE.phosphor,
  ...Object.fromEntries(
    Object.entries(MOTION).map(([key, value]) => [motionToken(key), `${value}ms`]),
  ),
};

/** Every `__OPENEYE_*__` placeholder, however it is spelled. Used by the drift
 *  guard to find placeholders in the stylesheets that no token would fill. */
export const TOKEN_PATTERN = /__OPENEYE_[A-Z0-9_]+__/g;

export function applyCssTokens(css: string): string {
  let out = css;
  for (const [token, value] of Object.entries(CSS_TOKENS)) {
    // split/join rather than replaceAll: World Monitor's tsconfig targets
    // ES2020, and this module is also loaded by vite.config.ts.
    out = out.split(token).join(value);
  }
  return out;
}
