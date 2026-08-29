import { describe, it, expect, beforeEach } from 'vitest';
import { buildTitle, runBoot, TITLE_TEXT } from './director';
import { FINAL_STAGE } from './machine';

/** scale: 0 collapses every duration, so the whole sequence runs in a few
 *  ticks instead of the ~16s it takes on screen. */
const run = (boot: HTMLElement, title: HTMLElement, onReveal = () => {}) =>
  runBoot(boot, title, onReveal, { scale: 0 });

let boot: HTMLElement;
let title: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  boot = document.createElement('div');
  boot.id = 'boot';
  title = document.createElement('div');
  title.id = 'title';
  document.body.append(boot, title);
});

describe('buildTitle', () => {
  it('reads exactly "AALICE: OpenEye" as text', () => {
    // The O is the docked eye VISUALLY, but it must also exist as a character:
    // the artwork lives in #boot, which fades out, and assistive tech and any
    // text extraction only ever see textContent. An art-only O silently ships
    // a title that reads "AALICE: penEye".
    buildTitle(title);
    expect(title.textContent).toBe('AALICE: OpenEye');
    expect(TITLE_TEXT).toBe('AALICE: OpenEye');
  });

  it('puts the letter inside the dock slot so the eye can cover it', () => {
    const slot = buildTitle(title);
    expect(slot.classList.contains('o-slot')).toBe(true);
    expect(slot.querySelector('.o-letter')?.textContent).toBe('O');
  });

  it('starts the letter unlit so it can cross-fade in', () => {
    buildTitle(title);
    expect(title.querySelector('.o-letter')?.classList.contains('lit')).toBe(false);
  });
});

describe('runBoot', () => {
  it('drops .powered before fading, or the globe never appears', async () => {
    // #boot.powered animates with fill-mode `both`, so its 100% keyframe pins
    // opacity:1 forever — and animation declarations outrank normal ones in
    // the cascade, making `#boot.faded { opacity: 0 }` unreachable. Leaving
    // the class on hides the globe behind an opaque black layer for good.
    await run(boot, title);
    expect(boot.classList.contains('faded')).toBe(true);
    expect(boot.classList.contains('powered')).toBe(false);
  });

  it('reveals the globe exactly once', async () => {
    let reveals = 0;
    await run(boot, title, () => { reveals++; });
    expect(reveals).toBe(1);
  });

  it('publishes the stage on the element for CSS and observers', async () => {
    await run(boot, title);
    expect(boot.dataset.stage).toBe(FINAL_STAGE);
  });

  it('compresses the title into a corner so it stops covering the globe', async () => {
    // The spec's end state is "title docked in corner, globe spinning".
    // Centred, the title sits permanently across the equator.
    await run(boot, title);
    expect(title.classList.contains('docked')).toBe(true);
  });

  it('lands in the same end state when skipped part-way', async () => {
    const skipped = runBoot(boot, title, () => {}, { scale: 1 });
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await skipped;

    expect(title.textContent).toBe('AALICE: OpenEye');
    expect(title.classList.contains('shown')).toBe(true);
    expect(title.querySelector('.o-letter')?.classList.contains('lit')).toBe(true);
    expect(boot.classList.contains('faded')).toBe(true);
    expect(boot.classList.contains('powered')).toBe(false);
    expect(boot.dataset.stage).toBe(FINAL_STAGE);
    expect(title.classList.contains('docked')).toBe(true);
  });

  it('leaves a lit, readable title even when skipped before the title exists', async () => {
    // Escape during POWER_ON aborts before buildTitle would normally run, so
    // the teardown has to construct and light the title itself.
    const skipped = runBoot(boot, title, () => {}, { scale: 1 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await skipped;

    expect(title.textContent).toBe('AALICE: OpenEye');
    expect(title.querySelector('.o-letter')?.classList.contains('lit')).toBe(true);
  });

  it('drops art already on screen when skipped mid-way', async () => {
    // Aborting mid-typing makes typeGrid reveal every span it has built. Those
    // are about to fade to nothing, so painting them — ~16k glyphs, each with a
    // text-shadow — is pure cost on the one path that asked for speed.
    const skipped = runBoot(boot, title, () => {}, { scale: 0.05 });
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (boot.querySelectorAll('span.cell').length > 0) return resolve();
        if (Date.now() - started > 8000) return reject(new Error('no grid was ever built'));
        setTimeout(poll, 10);
      };
      poll();
    });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await skipped;
    expect(boot.querySelectorAll('span.cell').length).toBe(0);
  });

  it('builds no art grids at all when skipped up front', async () => {
    // Escape means "get me to the globe now". typeGrid checks the signal only
    // after renderGrid, so calling it while aborted would lay out ~15k spans
    // synchronously and stall the main thread — the single most expensive step
    // in the sequence — to produce something #boot immediately fades away.
    const skipped = runBoot(boot, title, () => {}, { scale: 1 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await skipped;
    expect(boot.querySelectorAll('span.cell').length).toBe(0);
  });

  it('stops listening for skip keys once finished', async () => {
    await run(boot, title);
    const before = title.innerHTML;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(title.innerHTML).toBe(before);
  });

  it('still reaches the globe when the character art cannot be fetched', async () => {
    // jsdom has no /art route; a failed fetch must not strand the boot.
    let revealed = false;
    await run(boot, title, () => { revealed = true; });
    expect(revealed).toBe(true);
  });

  it('reveals the globe BEFORE the veil starts dissolving', async () => {
    // The globe has no fade of its own, so it must already be opaque when the
    // veil begins to go. Revealing it afterwards — or fading both at once —
    // leaves a stretch where a half-transparent veil sits over a
    // half-transparent globe, and the whole screen dips towards black.
    let fadedAtReveal: boolean | undefined;
    let dockedAtReveal: boolean | undefined;
    await runBoot(boot, title, () => {
      fadedAtReveal = boot.classList.contains('faded');
      dockedAtReveal = title.classList.contains('docked');
    }, { scale: 0 });

    expect(fadedAtReveal).toBe(false);
    expect(dockedAtReveal).toBe(false);
    // ...and both have happened by the end.
    expect(boot.classList.contains('faded')).toBe(true);
    expect(title.classList.contains('docked')).toBe(true);
  });

  it('retires the terminal instead of leaving 15k spans in the document', async () => {
    // OpenEye is meant to be left open. A dissolved-but-present full-view
    // layer carrying the whole eye grid is pure cost for the rest of the
    // session.
    await run(boot, title);
    expect(boot.querySelectorAll('span.cell').length).toBe(0);
    expect(boot.classList.contains('retired')).toBe(true);
  });

  it('docks the title only after the veil has gone', async () => {
    // The dock target lives inside #title. Flying it to the corner while the
    // eye is still travelling towards it is what made the eye never land.
    await run(boot, title);
    expect(title.classList.contains('docked')).toBe(true);
    expect(boot.classList.contains('faded')).toBe(true);
  });

  it('dissolves the CRT overlay with the veil', async () => {
    // The scanlines and vignette belong to the boot, not to the map the app
    // exists to read.
    const overlay = document.createElement('div');
    overlay.className = 'crt-overlay';
    document.body.appendChild(overlay);
    await runBoot(boot, title, () => {}, { scale: 0, overlay });
    expect(overlay.classList.contains('dissolved')).toBe(true);
  });

  it('survives having no overlay to dissolve', async () => {
    await expect(runBoot(boot, title, () => {}, { scale: 0, overlay: null }))
      .resolves.toBeUndefined();
  });

  it('skips when the user clicks anywhere', async () => {
    // Escape only helps someone who already knows it is there.
    const skipped = runBoot(boot, title, () => {}, { scale: 1 });
    window.dispatchEvent(new Event('pointerdown'));
    await skipped;
    expect(boot.dataset.stage).toBe(FINAL_STAGE);
    expect(boot.querySelectorAll('span.cell').length).toBe(0);
  });

  it('stops listening for skip clicks once finished', async () => {
    await run(boot, title);
    const before = title.innerHTML;
    window.dispatchEvent(new Event('pointerdown'));
    expect(title.innerHTML).toBe(before);
  });
});

describe('runBoot in short mode', () => {
  const short = (onReveal = () => {}) =>
    runBoot(boot, title, onReveal, { scale: 0, mode: 'short' });

  it('lands in the same end state as the full ceremony', async () => {
    await short();
    expect(title.textContent).toBe('AALICE: OpenEye');
    expect(title.querySelector('.o-letter')?.classList.contains('lit')).toBe(true);
    expect(title.classList.contains('docked')).toBe(true);
    expect(boot.classList.contains('faded')).toBe(true);
    expect(boot.dataset.stage).toBe(FINAL_STAGE);
  });

  it('reveals the globe exactly once', async () => {
    let reveals = 0;
    await short(() => { reveals++; });
    expect(reveals).toBe(1);
  });

  it('leaves nothing in the terminal for the dock to grab', async () => {
    // There is no artwork in this mode, so the dock must find nothing. It
    // matches on `.grid`, and the shell prompt is also a `.grid` — leaving it
    // there flew the shell line into the O slot and shrank it to a sliver
    // beside the wordmark.
    await short();
    expect(boot.querySelector('.grid')).toBeNull();
  });

  it('builds no art grid at all', async () => {
    // The whole point of the short boot is that a frequent launch does not pay
    // for the artwork — neither the wait nor the 15k-span layout.
    await short();
    expect(boot.querySelectorAll('span.cell').length).toBe(0);
  });

  it('never enters the artwork stages', async () => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      const s = boot.dataset.stage;
      if (s && seen[seen.length - 1] !== s) seen.push(s);
    });
    observer.observe(boot, { attributes: true, attributeFilter: ['data-stage'] });
    await short();
    observer.disconnect();
    expect(seen).not.toContain('CHARACTER');
    expect(seen).not.toContain('EYE');
    expect(seen).not.toContain('EYE_3D');
  });
});
