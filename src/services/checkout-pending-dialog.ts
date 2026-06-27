/**
 * Modal confirmation dialog for the `PAYMENT_IN_PROGRESS` 409 (#4438).
 *
 * Surfaced when the user tries to start a checkout while a recent 3DS/SCA
 * payment is still pending in the same tier group. Rather than silently
 * stacking another duplicate payment (the original incident — a customer
 * stacked 4–5 payments all "Requires customer action"), we confirm: the
 * pending one may still be completing; start a NEW checkout anyway?
 *
 * Adapted from checkout-duplicate-dialog.ts and lives in the services layer
 * (NOT components/) for the same reason: services can touch the DOM directly
 * but must not import from the components tree, and checkout.ts (a service)
 * imports this. Content is static copy + a whitelist-resolved plan name only;
 * raw server text NEVER reaches the dialog (it goes to Sentry via the taxonomy
 * reporter).
 */

const DIALOG_ID = 'wm-pending-payment-dialog';

export interface CheckoutPendingDialogOptions {
  /** Whitelisted display name for the plan with a pending payment (e.g., "Pro Monthly"). */
  planDisplayName: string;
  /** User clicked "Start new checkout". */
  onConfirm: () => void;
  /** User clicked "Cancel", pressed Esc, or clicked the backdrop. */
  onDismiss: () => void;
}

/**
 * Render the pending-payment dialog. Idempotent: a second call while a dialog
 * is already mounted is a no-op — the first dialog's callbacks remain in effect.
 */
export function showCheckoutPendingDialog(options: CheckoutPendingDialogOptions): void {
  if (document.getElementById(DIALOG_ID)) return;

  const backdrop = document.createElement('div');
  backdrop.id = DIALOG_ID;
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
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
  title.id = `${DIALOG_ID}-title`;
  title.textContent = 'Payment in progress';
  Object.assign(title.style, {
    fontSize: '16px',
    fontWeight: '600',
    margin: '0 0 10px 0',
    color: '#ffffff',
  });

  const body = document.createElement('p');
  body.textContent = `You have a ${options.planDisplayName} payment in progress. It may still be completing — if it does and you're charged twice, contact support and we'll refund the duplicate. Start a new checkout anyway?`;
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
  dismissBtn.textContent = 'Cancel';
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
  confirmBtn.textContent = 'Start new checkout';
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
