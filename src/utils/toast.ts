/**
 * Minimal body-level transient toast shared across dashboard surfaces.
 * Single-instance: a new toast replaces any visible one. Callers that need
 * the legacy 3-second timing can override the 4-second default explicitly.
 */
export function showToast(msg: string, durationMs = 4000): void {
  document.querySelector('.toast-notification')?.remove();
  const el = document.createElement('div');
  el.className = 'toast-notification';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 300); }, durationMs);
}
