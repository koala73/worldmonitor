/**
 * `?` cheat-sheet overlay for the Route Explorer keyboard bindings.
 */

export interface KeyboardHelpOptions {
  onClose: () => void;
}

const BINDINGS: ReadonlyArray<readonly [string, string]> = [
  ['Esc', 'Close picker, then close panel'],
  ['Tab / Shift+Tab', 'Move between panel and map'],
  ['F', 'Jump to From picker'],
  ['T', 'Jump to To picker'],
  ['P', 'Jump to Product picker'],
  ['S', 'Swap From ↔ To'],
  ['1 – 4', 'Switch tabs (Current / Alternatives / Land / Impact)'],
  ['↑ / ↓', 'Navigate ranked list'],
  ['Enter', 'Commit selection'],
  ['Cmd+,', 'Copy shareable URL'],
  ['?', 'Show this help'],
];

export class KeyboardHelp {
  public readonly element: HTMLDivElement;

  constructor(opts: KeyboardHelpOptions) {
    this.element = document.createElement('div');
    this.element.className = 're-help';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Route Explorer keyboard shortcuts');

    const header = document.createElement('div');
    header.className = 're-help__header';
    header.innerHTML =
      '<span class="re-help__title">Keyboard shortcuts</span>' +
      '<button class="re-help__close" aria-label="Close help">×</button>';

    const list = document.createElement('table');
    list.className = 're-help__table';
    for (const [key, label] of BINDINGS) {
      const row = document.createElement('tr');
      row.innerHTML = `<td class="re-help__key"><kbd>${escapeHtml(key)}</kbd></td><td class="re-help__label">${escapeHtml(label)}</td>`;
      list.append(row);
    }

    this.element.append(header, list);

    header.querySelector('.re-help__close')?.addEventListener('click', () => opts.onClose());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
