/**
 * Read a required environment variable, throwing a clear error if missing.
 * MUST be called inside function handlers, never at module scope.
 *
 * @example
 * ```ts
 * const apiKey = requireEnv("DODO_API_KEY");
 * ```
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in the Convex dashboard under Settings > Environment Variables.`,
    );
  }
  return value;
}
