// The client compatibility marker. An open tab is force-reloaded only when the
// deployed marker differs from the one baked into its bundle.
//
// CHANGE THIS VALUE in the same pull request as any change an already-open tab
// cannot survive: a response shape the old bundle misreads, an endpoint it
// still calls being removed, a storage format it would corrupt. PR #3466 is the
// reference case (a changed setPreferences conflict response left old tabs in a
// permanent retry loop).
//
// Every other deploy leaves the marker alone. Open tabs then update only when
// that costs the viewer nothing: see src/bootstrap/soft-reload-policy.ts.
//
// Forgot to change it? Change it in a follow-up deploy. Every open tab polls
// /client-compat.txt within ten minutes and reloads on the difference.
//
// vite.config.ts publishes this value as /client-compat.txt. Keep it to
// letters, digits, dot, dash and underscore, 32 characters at most: the reader
// treats anything else as an unknown marker and reloads.
export const CLIENT_COMPAT = '1';
