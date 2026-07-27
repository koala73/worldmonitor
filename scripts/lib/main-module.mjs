import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Report whether `moduleUrl` is the entrypoint the process was started with.
 *
 * Resolve both sides through their real paths first because Node resolves
 * `import.meta.url` while `process.argv[1]` preserves a caller-supplied symlink.
 * Fall back to a plain URL comparison when either path cannot be resolved.
 */
export function isMainModule(moduleUrl, argv1) {
  if (!argv1) return false;
  try {
    return pathToFileURL(realpathSync(fileURLToPath(moduleUrl))).href
      === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    try {
      return moduleUrl === pathToFileURL(argv1).href;
    } catch {
      return false;
    }
  }
}
