const COPY_MANUALLY_LABEL = 'Clipboard unavailable. Select this text to copy it.';
const COPY_MANUALLY_CLOSE = 'Close';

export interface CopyTextOptions {
  label?: string;
  closeLabel?: string;
  reveal?: (text: string) => void;
  writeText?: ((text: string) => Promise<void>) | null;
}

export async function copyText(text: string, options: CopyTextOptions = {}): Promise<boolean> {
  try {
    const write = options.writeText === null ? null : (options.writeText ?? readNavigatorWrite());
    const wrote = write ? await write(text).then(() => true, () => false) : false;
    if (wrote || copyWithExecCommand(text)) return true;
    return presentManualCopy(text, options);
  } catch {
    return presentManualCopy(text, options);
  }
}

function presentManualCopy(text: string, options: CopyTextOptions): boolean {
  try {
    if (options.reveal) options.reveal(text);
    else revealCopyText(text, options.label ?? COPY_MANUALLY_LABEL, options.closeLabel ?? COPY_MANUALLY_CLOSE);
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
  }
}

function revealCopyText(text: string, label: string, closeLabel: string): void {
  if (typeof document === 'undefined' || !document.body) {
    if (typeof window !== 'undefined' && typeof window.prompt === 'function') window.prompt(label, text);
    return;
  }
  document.querySelector('.wm-copy-fallback')?.remove();
  const root = document.createElement('div');
  root.className = 'wm-copy-fallback';
  root.setAttribute('role', 'status');
  const labelEl = document.createElement('label');
  labelEl.className = 'wm-copy-fallback-label';
  labelEl.textContent = label;
  const input = document.createElement('input');
  input.className = 'wm-copy-fallback-input';
  input.type = 'text';
  input.readOnly = true;
  input.value = text;
  input.setAttribute('aria-label', label);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'wm-copy-fallback-close';
  close.textContent = closeLabel;
  close.addEventListener('click', () => root.remove());
  labelEl.append(input);
  root.append(labelEl, close);
  document.body.appendChild(root);
  input.focus();
  if (typeof input.select === 'function') input.select();
}
