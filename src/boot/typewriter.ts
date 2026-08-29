import { displayGlyphFor, type CharGrid } from './grid';

export interface TypeOptions {
  durationMs: number;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to requestAnimationFrame. */
  frame?: (cb: FrameRequestCallback) => number;
}

/** Builds every cell up front, coloured but unlit. Typing then only toggles a
 *  class, which keeps a 15k-cell grid cheap — rebuilding row HTML per
 *  character would thrash the DOM.
 *
 *  Glyphs are re-encoded for ink coverage on the way in (see displayGlyphFor):
 *  the source ramp means dense=dark, but a terminal draws ink, so the source
 *  glyph would put the most ink where the picture is darkest. */
export function renderGrid(host: HTMLElement, grid: CharGrid): HTMLElement[] {
  host.textContent = '';
  const pre = document.createElement('pre');
  pre.className = 'grid';
  const rows: HTMLElement[] = [];

  for (const line of grid.cells) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    for (const cell of line) {
      const span = document.createElement('span');
      span.className = 'cell';
      span.style.color = cell.color;
      span.textContent = displayGlyphFor(cell.ch);
      rowEl.appendChild(span);
    }
    pre.appendChild(rowEl);
    rows.push(rowEl);
  }

  host.appendChild(pre);
  return rows;
}

export function typeGrid(host: HTMLElement, grid: CharGrid, opts: TypeOptions): Promise<void> {
  const frame = opts.frame ?? ((cb: FrameRequestCallback) => requestAnimationFrame(cb));
  renderGrid(host, grid);
  const cells = [...host.querySelectorAll<HTMLElement>('span.cell')];
  const revealAll = () => cells.forEach((c) => c.classList.add('lit'));

  if (opts.signal?.aborted || opts.durationMs <= 0) {
    revealAll();
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const started = performance.now();
    let i = 0;

    const step = () => {
      if (opts.signal?.aborted) { revealAll(); resolve(); return; }

      // Ease in: start at a human typing pace, accelerate to a cascade.
      const t = Math.min(1, (performance.now() - started) / opts.durationMs);
      const target = Math.floor(cells.length * t * t);
      for (; i < target && i < cells.length; i++) cells[i]!.classList.add('lit');

      if (i >= cells.length) { resolve(); return; }
      frame(step);
    };

    frame(step);
  });
}
