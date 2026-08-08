/**
 * Minimal transient toast. Mirrors the long-standing inline implementations
 * in UnifiedSettings.ts / webcams/pinned-store.ts so new callers (e.g. the
 * CMD+K "Add panel" cap-block feedback) have a shared entry point instead of
 * a fourth copy. Single-instance: a new toast replaces any visible one.
 */
export function showToast(msg: string): void {
  document.querySelector('.toast-notification')?.remove();
  const el = document.createElement('div');
  el.className = 'toast-notification';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, 4000);
}
