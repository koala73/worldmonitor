import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Report whether `moduleUrl` is the entrypoint the process was started with.
 *
 * Both sides are resolved through `realpathSync` first. Node sets
 * `import.meta.url` to the real path while `process.argv[1]` keeps whatever
 * path the caller typed, so the naive comparison silently no-ops — exit 0, zero
 * output — whenever the checkout is reached through a symlink (`/tmp` ->
 * `/private/tmp` on macOS is the common one). For an audit or gate that is the
 * worst possible failure: it looks exactly like a clean run.
 */
export function isMainModule(moduleUrl, argv1) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href
      === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // Degrade to the plain comparison rather than answering `false`: a throw
    // here (an unresolvable path, a permission error) must not put the caller
    // back to exiting 0 with no output, which is the silent no-op this
    // function exists to prevent.
    try {
      return moduleUrl === pathToFileURL(argv1).href;
    } catch {
      return false;
    }
  }
}
