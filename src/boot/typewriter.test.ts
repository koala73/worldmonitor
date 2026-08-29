import { describe, it, expect } from 'vitest';
import { renderGrid, typeGrid } from './typewriter';
import { displayGlyphFor, type CharGrid } from './grid';

const grid = (): CharGrid => ({
  cols: 2, rows: 2,
  cells: [
    [{ ch: 'a', color: '#ff0000' }, { ch: 'b', color: '#00ff00' }],
    [{ ch: 'c', color: '#0000ff' }, { ch: 'd', color: '#ffffff' }],
  ],
});

/** Runs every queued frame synchronously so tests never wait on rAF. */
const immediateFrame = (cb: FrameRequestCallback) => { cb(performance.now()); return 0; };

describe('renderGrid', () => {
  it('creates one span per cell, all hidden initially', () => {
    const host = document.createElement('div');
    renderGrid(host, grid());
    const spans = host.querySelectorAll('span');
    expect(spans).toHaveLength(4);
    expect([...spans].every((s) => s.classList.contains('cell'))).toBe(true);
    expect([...spans].every((s) => !s.classList.contains('lit'))).toBe(true);
  });

  it('writes the re-encoded glyph, not the source glyph', () => {
    // The source ramp means dense=dark; a terminal draws ink. Rendering the
    // source glyph verbatim inverts the picture, so 'a' (a fairly dark source
    // value) must reach the DOM as a sparse, low-ink glyph instead.
    const host = document.createElement('div');
    renderGrid(host, grid());
    const first = host.querySelector('span')!;
    expect(first.textContent).not.toBe('a');
    expect(first.textContent).toBe(displayGlyphFor('a'));
  });

  it('applies per-cell colour up front so typing is only a reveal', () => {
    const host = document.createElement('div');
    renderGrid(host, grid());
    expect(host.querySelector('span')!.style.color).toBe('rgb(255, 0, 0)');
  });
});

describe('typeGrid', () => {
  it('reveals every cell by the time it resolves', async () => {
    const host = document.createElement('div');
    await typeGrid(host, grid(), { durationMs: 0, frame: immediateFrame });
    expect(host.querySelectorAll('span.lit')).toHaveLength(4);
  });

  it('lands fully revealed when aborted MID-animation, not just before it starts', async () => {
    // The committed abort test aborts BEFORE typeGrid is called, so it only
    // exercises the top-level fast path. Breaking the in-loop abort check
    // failed no test at all. Skipping must land in the same end state from
    // any point, so drive real frames first, then abort.
    const host = document.createElement('div');
    const ctrl = new AbortController();
    const queue: FrameRequestCallback[] = [];
    const frame = (cb: FrameRequestCallback) => queue.push(cb);

    const done = typeGrid(host, grid(), {
      durationMs: 10_000,
      signal: ctrl.signal,
      frame,
    });

    queue.shift()!(performance.now()); // one frame in: animation genuinely under way
    expect(host.querySelectorAll('span.cell.lit').length).toBeLessThan(4);

    ctrl.abort();
    queue.shift()!(performance.now());
    await done;

    expect(host.querySelectorAll('span.cell.lit')).toHaveLength(4);
  });

  it('stops early when aborted and leaves the grid fully revealed', async () => {
    const host = document.createElement('div');
    const ctrl = new AbortController();
    ctrl.abort();
    await typeGrid(host, grid(), { durationMs: 10_000, signal: ctrl.signal, frame: immediateFrame });
    // Skipping must land in the same end state as playing it through.
    expect(host.querySelectorAll('span.lit')).toHaveLength(4);
  });
});
