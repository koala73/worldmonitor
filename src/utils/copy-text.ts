const COPY_MANUALLY_LABEL = 'Clipboard unavailable. Select this text to copy it.';
const COPY_MANUALLY_CLOSE = 'Close';

export interface CopyTextOptions {
  label?: string;
  closeLabel?: string;
  reveal?: (text: string) => void;
  writeText?: ((text: string) => Promise<void>) | null;
  /** Mark the manual field so settings can remove a revealed API or embed key. */
  secret?: boolean;
}

export async function copyText(text: string, options: CopyTextOptions = {}): Promise<boolean> {
  const write = options.writeText === null ? null : readWrite(options);
  if (write && await invokeWrite(write, text)) return true;
  if (copyWithExecCommand(text)) return true;
  return presentManualCopy(text, options);
}

function readWrite(options: CopyTextOptions): ((text: string) => Promise<void>) | null {
  try {
    return options.writeText ?? readNavigatorWrite();
  } catch {
    return null;
  }
}

async function invokeWrite(write: (text: string) => Promise<void>, text: string): Promise<boolean> {
  try {
    await write(text);
    return true;
  } catch {
    return false;
  }
}

function presentManualCopy(text: string, options: CopyTextOptions): boolean {
  try {
    if (options.reveal) options.reveal(text);
    else revealCopyText(text, options.label ?? COPY_MANUALLY_LABEL, options.closeLabel ?? COPY_MANUALLY_CLOSE, options.secret === true);
  } catch {
    return false;
  }
  return false;
}

function readNavigatorWrite(): ((text: string) => Promise<void>) | null {
  if (typeof navigator === 'undefined' || navigator.clipboard == null) return null;
  const writeText = navigator.clipboard.writeText;
  if (typeof writeText !== 'function') return null;
  return (value) => navigator.clipboard.writeText(value);
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function' || !document.body) return false;
  const previous = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  try {
    area.focus();
    if (typeof area.select === 'function') area.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area.remove();
    restoreFocus(previous);
  }
}

function restoreFocus(previous: Element | null): void {
  if (!previous || previous === document.body || previous === document.documentElement) return;
  const control = previous as { focus?: () => void; isConnected?: boolean };
  if (control.isConnected === false || typeof control.focus !== 'function') return;
  try {
    control.focus();
  } catch {
    // The previous control can disappear or refuse focus.
  }
}

export function dismissSecretCopyFallback(): void {
  if (typeof document === 'undefined') return;
  document.querySelector('.wm-copy-fallback[data-copy-secret]')?.remove();
}

function revealCopyText(text: string, label: string, closeLabel: string, secret: boolean): void {
  if (typeof document === 'undefined' || !document.body) {
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') window.prompt(label, text);
    return;
  }
  const previous = document.activeElement;
  document.querySelector('.wm-copy-fallback')?.remove();
  const root = document.createElement('div');
  root.className = 'wm-copy-fallback';
  root.setAttribute('role', 'status');
  if (secret) root.setAttribute('data-copy-secret', '');
  const labelEl = document.createElement('label');
  labelEl.className = 'wm-copy-fallback-label';
  labelEl.textContent = label;
  const field = document.createElement('textarea');
  field.className = 'wm-copy-fallback-input';
  field.readOnly = true;
  field.rows = Math.min(6, Math.max(1, text.split('\n').length));
  field.value = text;
  field.setAttribute('aria-label', label);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'wm-copy-fallback-close';
  close.textContent = closeLabel;
  close.addEventListener('click', () => {
    root.remove();
    restoreFocus(previous);
  });
  labelEl.append(field);
  root.append(labelEl, close);
  document.body.appendChild(root);
  field.focus();
  if (typeof field.select === 'function') field.select();
}
