/** Premium paths minus API-only paths; see shared/selfhost-relay-paths.js. */
export const SELFHOST_RELAY_PATHS: ReadonlySet<string>;

/** True when a docker sidecar relays `pathname` for a browser holding a desktop key. */
export function isSelfHostRelayPath(pathname: string): boolean;
