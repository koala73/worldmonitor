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
    setTrustedHtml(
      overlay,
      trustedHtml(
        `
      <div class="confirm-dialog">
        <p class="confirm-dialog-message">${labels.message}</p>
        <div class="confirm-dialog-actions">
          <button type="button" class="confirm-dialog-btn confirm-dialog-cancel">${labels.cancelLabel}</button>
          <button type="button" class="confirm-dialog-btn confirm-dialog-confirm">${labels.confirmLabel}</button>
        </div>
      </div>
    `,
        'static i18n confirm dialog content',
      ),
    );

    let settled = false;
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        settle(false);
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
