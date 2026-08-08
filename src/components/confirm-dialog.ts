/**
 * Non-blocking confirm dialog (#4559).
 *
 * Replaces native `confirm()` — which blocks the main thread and inflates INP
 * processingDuration with human dwell time — with an in-app overlay that resolves
 * a Promise. Mirrors the construction of `src/components/MobileWarningModal.ts`
 * (overlay + `setTrustedHtml`/`trustedHtml`, `.active` class for the CSS
 * transition) and is reusable by any call site.
 *
 * Resolves `true` on confirm; `false` on cancel, Escape, or backdrop click.
 */
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { escapeHtml } from '@/utils/sanitize';
import { type ConfirmDialogOptions, resolveConfirmLabels } from '@/components/confirm-dialog-labels';

export type { ConfirmDialogOptions, ResolvedConfirmLabels } from '@/components/confirm-dialog-labels';
export { resolveConfirmLabels } from '@/components/confirm-dialog-labels';

let activeOverlay: HTMLElement | null = null;

/** Whether a confirm dialog is currently on screen (callers can avoid re-opening). */
export function isConfirmDialogOpen(): boolean {
  return activeOverlay !== null;
}

/**
 * Show a non-blocking confirm dialog. Single-instance: a call made while one is
 * already open resolves `false` immediately rather than stacking overlays.
 */
export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  if (activeOverlay) return Promise.resolve(false);

  const labels = resolveConfirmLabels(opts, {
    // Cancel reuses the covered common.cancel key; the affirmative defaults to a
    // literal (no t() key) — a translated `common.discard` would have to be added
    // to every locale file (locale-completeness gate), deferred as a follow-up.
    // Callers needing a translated affirmative pass `confirmLabel` explicitly.
    confirm: 'Discard',
    cancel: t('common.cancel'),
  });

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    activeOverlay = overlay;
    overlay.className = 'confirm-dialog-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    // Single-instance (guarded below), so the fixed message id is unique.
    overlay.setAttribute('aria-labelledby', 'confirm-dialog-message');
    setTrustedHtml(
      overlay,
      trustedHtml(
        // Every interpolated value is escaped so the reusable API is XSS-safe by
        // default even if a caller passes user-controlled `message`.
        `
      <div class="confirm-dialog">
        <p id="confirm-dialog-message" class="confirm-dialog-message">${escapeHtml(labels.message)}</p>
        <div class="confirm-dialog-actions">
          <button type="button" class="confirm-dialog-btn confirm-dialog-cancel">${escapeHtml(labels.cancelLabel)}</button>
          <button type="button" class="confirm-dialog-btn confirm-dialog-confirm">${escapeHtml(labels.confirmLabel)}</button>
        </div>
      </div>
    `,
        'confirm dialog skeleton; all interpolated values escaped via escapeHtml',
      ),
    );

    let settled = false;
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        settle(false);
        return;
      }
      if (e.key === 'Tab') {
        // Minimal focus trap: keep Tab / Shift+Tab cycling within the dialog
        // buttons so focus can't reach the settings modal behind the overlay.
        const buttons = [...overlay.querySelectorAll<HTMLElement>('.confirm-dialog-btn')];
        if (buttons.length === 0) return;
        const first = buttons[0]!;
        const last = buttons[buttons.length - 1]!;
        const active = document.activeElement;
        if (!buttons.includes(active as HTMLElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (activeOverlay === overlay) activeOverlay = null;
      resolve(value);
    };

    overlay.querySelector('.confirm-dialog-confirm')?.addEventListener('click', () => settle(true));
    overlay.querySelector('.confirm-dialog-cancel')?.addEventListener('click', () => settle(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) settle(false);
    });
    document.addEventListener('keydown', onKeydown, true);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('active');
      (overlay.querySelector('.confirm-dialog-confirm') as HTMLElement | null)?.focus();
    });
  });
}
