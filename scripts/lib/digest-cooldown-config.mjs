/**
 * Sprint 1 / U5 — kill-switch parser for the cooldown decision module.
 *
 * Mode contract:
 *   `DIGEST_COOLDOWN_MODE` ∈ {'shadow', 'off'}.
 *   Default (unset / empty)         → 'shadow'
 *   Exact 'off'                     → 'off'
 *   Anything else (typo, garbage,
 *     'true', '1', or even 'enforce'
 *     which Sprint 2 will introduce) → 'shadow' + invalidRaw warn.
 *
 * Why 'enforce' is intentionally invalid in Sprint 1: Sprint 2 introduces
 * the third value once the 14-day replay (U6) validates the cooldown
 * table. Treating an early 'enforce' set as fail-closed-to-shadow
 * prevents an operator from accidentally flipping enforcement on before
 * Sprint 2 ships the wiring — the env flag would otherwise produce a
 * silent partial-enforce state where the U5 decision is computed but
 * the send-loop integration that gates on it doesn't exist yet.
 *
 * Pattern modelled on `scripts/lib/brief-dedup.mjs::readOrchestratorConfig`
 * — see that file's header for the canonical fail-closed-on-typo
 * rationale (`feedback_kill_switch_default_on_typo`).
 *
 * The parser is pure: no I/O, no side effects, deterministic output for a
 * given env. Callers that want the warn-on-typo loud-log pass `cfg.invalidRaw`
 * to their console.warn at startup; this module only reports it.
 */

const VALID_MODES = Object.freeze(new Set(['shadow', 'off']));

/**
 * @typedef {'shadow' | 'off'} CooldownMode
 *
 * @typedef {object} CooldownConfig
 * @property {CooldownMode} mode
 * @property {string | null} invalidRaw
 *   Non-null when the env var was set to something the parser rejected.
 *   Operators surface this as a startup warn so a typo can't hide.
 */

/**
 * Parse the cooldown mode from the given env (or process.env). Empty /
 * unset → 'shadow' (the safe default). Exact 'off' → 'off'. Anything
 * else → 'shadow' with `invalidRaw` populated for the caller to warn.
 *
 * Case-folded to lowercase so `Shadow`, `OFF`, `Off` all behave as
 * expected (Railway env values frequently come from operators typing
 * mixed case during incident response). Empty string after .trim() is
 * also treated as unset — Railway sometimes round-trips through a
 * dashboard widget that surfaces empty strings instead of unset values.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {CooldownConfig}
 */
export function readCooldownConfig(env = process.env) {
  const raw = env?.DIGEST_COOLDOWN_MODE;
  // Treat unset, undefined, and empty-after-trim identically — these are
  // all "no operator opinion" cases that should fall to the safe default.
  const trimmed = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (trimmed === '') {
    return { mode: 'shadow', invalidRaw: null };
  }
  if (VALID_MODES.has(trimmed)) {
    return { mode: /** @type {CooldownMode} */ (trimmed), invalidRaw: null };
  }
  // Anything else fails closed to 'shadow'. Surface the raw (post-trim,
  // post-lowercase) value so operators can spot typos. We deliberately
  // don't pass the original case-sensitive string here — operators
  // chasing a typo care about which value the parser saw, not the exact
  // capitalisation they typed.
  return { mode: 'shadow', invalidRaw: trimmed };
}

/**
 * Convenience accessor — returns just the mode. Use this when you don't
 * need the invalidRaw warn surface (e.g., inside the decision module's
 * `decision === null` short-circuit when mode is 'off').
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {CooldownMode}
 */
export function readCooldownMode(env = process.env) {
  return readCooldownConfig(env).mode;
}
