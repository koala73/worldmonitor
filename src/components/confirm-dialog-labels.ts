/**
 * Pure label resolution for the confirm dialog (#4559).
 *
 * Kept in its own module with ZERO imports so it is unit-testable under
 * `tsx --test` — importing `confirm-dialog.ts` directly pulls in `@/services/i18n`
 * (which uses Vite's `import.meta.glob` and crashes outside the Vite build).
 */

export interface ConfirmDialogOptions {
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ResolvedConfirmLabels {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

/** Fill in default labels for missing/blank ones; pass the message through verbatim. */
export function resolveConfirmLabels(
  opts: ConfirmDialogOptions,
  fallback: { confirm: string; cancel: string },
): ResolvedConfirmLabels {
  const pick = (v: string | undefined, d: string): string => (v && v.trim() ? v : d);
  return {
    message: opts.message,
    confirmLabel: pick(opts.confirmLabel, fallback.confirm),
    cancelLabel: pick(opts.cancelLabel, fallback.cancel),
  };
}
