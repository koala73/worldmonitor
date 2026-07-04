/**
 * Shared modal-confirmation scaffold for the dashboard checkout 409 blocks.
 *
 * Two dialogs — duplicate-subscription (`ACTIVE_SUBSCRIPTION_EXISTS`) and
 * payment-in-progress (`PAYMENT_IN_PROGRESS`, #4438) — render the same
 * backdrop/card/two-button modal with the same lifecycle (idempotent mount,
 * Esc + backdrop dismiss, single-resolution guard, opacity fade, focus on
 * confirm). They differ only in id, copy, and button labels, so the scaffold
 * lives here once instead of being copy-pasted (#4438 review — was ~130
 * duplicated lines across checkout-duplicate-dialog.ts and
 * checkout-pending-dialog.ts).
 *
 * Services-layer (NOT components/) to honor the dependency rule: checkout.ts
 * imports the dialogs that wrap this; services must not import from the
 * components tree. The /pro marketing app cannot reuse this (separate build,
 * no `src/` imports) and keeps its own inline copy.
 *
 * Content is caller-supplied static copy plus a whitelist-resolved plan name
 * only; raw server text never reaches the dialog.
 */

export interface CheckoutConfirmDialogOptions {
  /** Unique element id; also used for the title id and `aria-labelledby`. */
  id: string;
  /** Heading text. */
  title: string;
  /** Pre-composed body copy (caller interpolates the whitelisted plan name). */
  body: string;
  /** Primary-action button label. */
  confirmLabel: string;
  /** Dismiss button label. */
  dismissLabel: string;
  /** Primary action clicked. */
  onConfirm: () => void;
  /** Dismiss button, backdrop click, or Esc. */
  onDismiss: () => void;
}

/**
 * Render a checkout confirmation dialog. Idempotent: a second call while a
 * dialog with the same `id` is mounted is a no-op — the first dialog's
 * callbacks remain in effect.
 */
export function showCheckoutConfirmDialog(options: CheckoutConfirmDialogOptions): void {
  if (document.getElementById(options.id)) return;

  const backdrop = document.createElement('div');
  backdrop.id = options.id;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', `${options.id}-title`);
  Object.assign(backdrop.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '99990',
    background: 'rgba(10, 10, 10, 0.72)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    transition: 'opacity 0.18s ease',
    opacity: '0',
  });

  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#141414',
    border: '1px solid #2a2a2a',
    borderRadius: '8px',
    padding: '20px 22px',
    maxWidth: '440px',
    width: '100%',
    color: '#e8e8e8',
    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', monospace",
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  });

  const title = document.createElement('h2');
  title.id = `${options.id}-title`;
  title.textContent = options.title;
  Object.assign(title.style, {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 10px 0',
    color: '#ffffff',
  });

  const body = document.createElement('p');
  body.textContent = options.body;
  Object.assign(body.style, {
    fontSize: '13px',
    lineHeight: '1.5',
    margin: '0 0 18px 0',
    color: '#c8c8c8',
  });

  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '10px',
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = options.dismissLabel;
  Object.assign(dismissBtn.style, {
    background: 'transparent',
    color: '#aaaaaa',
    border: '1px solid #2a2a2a',
    borderRadius: '4px',
    padding: '8px 14px',
    fontSize: '12px',
    fontWeight: '600',
    cursor: 'pointer',
    fontFamily: 'inherit',
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.textContent = options.confirmLabel;
  Object.assign(confirmBtn.style, {
    background: '#44ff88',
    color: '#0a0a0a',
    border: 'none',
    borderRadius: '4px',
    padding: '8px 14px',
    fontSize: '12px',
    fontWeight: '700',
    cursor: 'pointer',
    fontFamily: 'inherit',
  });

  row.appendChild(dismissBtn);
  row.appendChild(confirmBtn);
  card.appendChild(title);
  card.appendChild(body);
  card.appendChild(row);
  backdrop.appendChild(card);

  let resolved = false;
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  };
  const close = () => {
    document.removeEventListener('keydown', keyHandler, true);
    backdrop.style.opacity = '0';
    setTimeout(() => backdrop.remove(), 200);
  };

  confirmBtn.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onConfirm();
  });
  const dismiss = () => {
    if (resolved) return;
    resolved = true;
    close();
    options.onDismiss();
  };
  dismissBtn.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) dismiss();
  });
  // Esc unconditionally dismisses; keyHandler is removed by `close()` on every
  // resolution path (confirm + button-dismiss + backdrop-click + Esc itself),
  // so the listener can't leak past the dialog's lifetime.
  document.addEventListener('keydown', keyHandler, true);

  document.body.appendChild(backdrop);
  requestAnimationFrame(() => {
    backdrop.style.opacity = '1';
    confirmBtn.focus();
  });
}
