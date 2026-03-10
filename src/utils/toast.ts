/**
 * Global toast notification (body-level). Use for short-lived feedback e.g. "Settings saved".
 * For in-panel toasts with custom styling (e.g. import/export), use component-specific logic.
 */
export function showToast(msg: string): void {
  document.querySelector('.toast-notification')?.remove();
  const el = document.createElement('div');
  el.className = 'toast-notification';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
