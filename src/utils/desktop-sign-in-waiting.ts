/**
 * The bar shown while desktop sign-in continues in the browser (#9396
 * follow-up): says where to look, and offers Cancel and the in-app card.
 */

export interface DesktopSignInWaitingActions {
  onCancel(): void;
  onInApp(): void;
}

export function showDesktopSignInWaiting(actions: DesktopSignInWaitingActions): () => void {
  document.querySelector('.wm-desktop-sign-in-waiting')?.remove();

  const bar = document.createElement('div');
  bar.className = 'wm-desktop-sign-in-waiting';
  bar.setAttribute('role', 'status');
  Object.assign(bar.style, {
    position: 'fixed',
    left: '50%',
    bottom: '24px',
    transform: 'translateX(-50%)',
    zIndex: '10000',
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '10px 14px',
    background: '#111',
    color: '#e8e8e8',
    border: '1px solid #2a2a2a',
    borderRadius: '6px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    font: "13px 'SF Mono', Monaco, 'Cascadia Code', monospace",
  } satisfies Partial<CSSStyleDeclaration>);

  const text = document.createElement('span');
  text.textContent = 'Continue signing in in your browser.';

  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    Object.assign(el.style, {
      background: 'none',
      border: 'none',
      color: '#44ff88',
      cursor: 'pointer',
      font: 'inherit',
      padding: '0',
      textDecoration: 'underline',
    } satisfies Partial<CSSStyleDeclaration>);
    el.addEventListener('click', () => {
      bar.remove();
      onClick();
    });
    return el;
  };

  bar.append(text, button('Sign in here instead', actions.onInApp), button('Cancel', actions.onCancel));
  document.body.appendChild(bar);
  return () => bar.remove();
}
