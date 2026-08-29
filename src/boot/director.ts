import { parseChibi } from './load-chibi';
import { createBootMachine, FINAL_STAGE, type BootStage } from './machine';
import { typeGrid } from './typewriter';
import { nextFrame, wait, waitForTransition } from './timing';
import type { BootMode } from './boot-mode';
import type { CharGrid } from './grid';
import { MOTION } from './theme';

// The eye docks as the leading "O" of "OpenEye", so the slot sits between
// these literals. (Not `'penEye'.slice(1)` — that yields "enEye" and renders
// "AALICE: OpenOenEye".)
const TITLE_BEFORE = 'AALICE: ';
const TITLE_O = 'O';
const TITLE_AFTER = 'penEye';

export const TITLE_TEXT = `${TITLE_BEFORE}${TITLE_O}${TITLE_AFTER}`;

const PROMPT_LINE = 'aalice@openeye:~$ ./openeye --boot';

/** Holds owned by the director, in ms at scale 1. Anything a stylesheet also
 *  needs to agree with lives in MOTION (src/config/theme.ts) instead. */
const HOLD = {
  powerOn: 500,
  promptChar: 40,
  promptDone: 400,
  chibiType: 5000,
  chibiDone: 600,
  eyeClear: 220,
  eyeType: 3500,
  eyeSpin: 2000,
  /** The short boot's one beat: the shell line, already printed. */
  shortPrompt: 700,
} as const;

/** Slack on top of a transition's real duration before the director stops
 *  waiting for it. Only ever used when `transitionend` does not arrive. */
const TRANSITION_SLACK_MS = 400;

export interface BootOptions {
  /** Multiplies the director's own holds. 0 runs the whole sequence
   *  immediately, which is what the tests use.
   *
   *  It does NOT scale the CSS transitions — those are declared in the
   *  stylesheets from the same MOTION constants the director waits on, and
   *  reduced motion collapses them there. */
  scale?: number;
  /** 'full' plays the whole ceremony; 'short' powers on and goes to the
   *  title. See ./boot-mode. */
  mode?: BootMode;
  /** The CRT scanline layer. Retired together with the veil at the handoff,
   *  so the working map is not read through scanlines and a vignette. */
  overlay?: HTMLElement | null;
}

/**
 * The eye artwork, fetched only when it is going to be drawn.
 *
 * `eye-grid.json` is 435 KB — larger than everything else on the boot path
 * put together — and the short boot never renders it. Importing it
 * statically put all of it in the entry chunk, so every repeat visit
 * downloaded and parsed the full-ceremony artwork to play a sequence that
 * skips straight from power-on to the title.
 */
async function loadEyeGrid(): Promise<CharGrid | null> {
  try {
    const mod = await import('./eye-grid.json');
    return mod.default as CharGrid;
  } catch {
    return null; // missing art must not block the handoff
  }
}

async function loadChibiGrid(): Promise<CharGrid | null> {
  try {
    const res = await fetch('/art/chibi_winking_ascii.txt');
    if (!res.ok) return null;
    return parseChibi(await res.text());
  } catch {
    return null; // missing art must not block the globe
  }
}

/** Docks the typed eye into the title's reserved O slot using FLIP: measure
 *  both boxes, then transform the eye into the slot. Resolves when the eye has
 *  actually LANDED.
 *
 *  Two things here were the visible glitch at the handoff.
 *
 *  `.eye-3d` comes off before measuring, because that animation fills forwards
 *  and measuring the animated box docks the eye off-centre. (Its keyframes now
 *  also end on the identity transform, so taking the class off is not itself a
 *  visible snap.)
 *
 *  And the flight is translate+scale only. It used to carry a rotateY(360deg),
 *  which took the artwork edge-on twice on the way in: a full-height plane at
 *  90 degrees projects to a sliver, so the eye crossed the wordmark as a
 *  vertical bar of noise. The spin belongs to EYE_3D; the dock only lands. */
async function dockEyeIntoTitle(
  boot: HTMLElement,
  slot: HTMLElement,
  fallbackMs: number,
  signal: AbortSignal,
): Promise<void> {
  const grid = boot.querySelector<HTMLElement>('.grid');
  if (!grid) return;
  boot.classList.remove('eye-3d');

  const from = grid.getBoundingClientRect();
  const to = slot.getBoundingClientRect();
  if (!from.width || !to.width) return;

  const scale = to.width / from.width;
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);

  boot.classList.add('docking');
  grid.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;

  // Waiting on the transition rather than on a stopwatch is the whole point:
  // the old code slept for the transition's nominal duration and moved on,
  // and under load the flight was measured STARTING about 2s after it was
  // requested — so the eye was still mid-air when the veil took it away.
  await waitForTransition(grid, 'transform', fallbackMs, signal);
}

/** The title line, with the O as real text inside the dock slot.
 *
 *  The O has to exist as a character, not only as the docked artwork: the eye
 *  lives inside #boot, which dissolves at the handoff, so an art-only O would
 *  leave "AALICE:  penEye" with a hole in it — and screen readers and any text
 *  extraction would read that misspelling all along. The letter therefore sits
 *  in the slot from the start, transparent, and cross-fades in underneath the
 *  eye before the veil takes the artwork away. */
export function buildTitle(host: HTMLElement): HTMLElement {
  host.textContent = '';
  const line = document.createElement('div');
  line.className = 'line';

  const before = document.createElement('span');
  before.textContent = TITLE_BEFORE;
  const slot = document.createElement('span');
  slot.className = 'o-slot';
  const letter = document.createElement('span');
  letter.className = 'o-letter';
  letter.textContent = TITLE_O;
  slot.appendChild(letter);
  const after = document.createElement('span');
  after.textContent = TITLE_AFTER;
  const cursor = document.createElement('span');
  cursor.className = 'cursor';

  line.append(before, slot, after, cursor);
  host.appendChild(line);
  return slot;
}

function showPrompt(boot: HTMLElement): HTMLElement {
  boot.textContent = '';
  const prompt = document.createElement('pre');
  prompt.className = 'grid';
  boot.appendChild(prompt);
  return prompt;
}

export async function runBoot(
  boot: HTMLElement,
  title: HTMLElement,
  onReveal: () => void,
  opts: BootOptions = {},
): Promise<void> {
  const scale = opts.scale ?? 1;
  const mode = opts.mode ?? 'full';
  const ms = (base: number) => base * scale;
  // A CSS transition runs for its declared duration whatever `scale` says, so
  // its fallback is not scaled either — except at scale 0, which means "no
  // waiting at all".
  const settle = (base: number) => (scale === 0 ? 0 : base + TRANSITION_SLACK_MS);

  const machine = createBootMachine();
  const ctrl = new AbortController();
  const { signal } = ctrl;

  /** Stage is published on the element so CSS, tests and the verification
   *  harness can all observe the sequence instead of racing a wall clock. */
  const enter = (stage: BootStage) => { boot.dataset.stage = stage; };
  enter(machine.stage());
  const step = () => enter(machine.advance());
  const jump = (stage: BootStage) => enter(machine.jumpTo(stage));

  let hint: HTMLElement | undefined;

  const abandon = () => {
    machine.skip();
    ctrl.abort();
    // Nothing already in #boot will be seen again — it is about to dissolve.
    // Dropping it now matters: an abort mid-typing makes typeGrid reveal every
    // built span at once, and painting ~15k glyphs that each carry a
    // text-shadow stalls the frame precisely when the user asked to get on
    // with it.
    boot.textContent = '';
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' && e.key !== 'Enter') return;
    abandon();
  };
  // Clicking anywhere skips too. The keyboard shortcut is only useful to
  // someone who already knows about it, and this is the screen a frequent user
  // most wants past.
  const onPointer = () => abandon();
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onPointer);

  try {
    // POWER_ON — the tube coming up to brightness.
    boot.classList.add('powered');
    await wait(ms(HOLD.powerOn), signal);
    // The power-on keyframes fill forwards with `opacity: 1`, and animation
    // declarations outrank normal ones in the cascade — leaving `.powered` on
    // makes `#boot.faded { opacity: 0 }` unreachable, so the globe never
    // appears. The 100% keyframe equals the element's resting state, so
    // dropping the class here is visually a no-op.
    boot.classList.remove('powered');

    if (mode === 'full') {
      // PROMPT
      step();
      const prompt = showPrompt(boot);
      for (let i = 0; i <= PROMPT_LINE.length && !signal.aborted; i++) {
        prompt.textContent = PROMPT_LINE.slice(0, i);
        await wait(ms(HOLD.promptChar), signal);
      }
      await wait(ms(HOLD.promptDone), signal);

      hint = document.createElement('div');
      hint.className = 'boot-hint';
      hint.textContent = 'esc or click to skip';
      boot.appendChild(hint);
      await nextFrame();
      hint.classList.add('shown');

      // CHARACTER
      // Once skipped there is nothing to gain from building an art grid: #boot
      // is about to dissolve to nothing. typeGrid only checks the signal AFTER
      // renderGrid, so calling it anyway would lay out ~15k spans
      // synchronously — the most expensive work in the sequence — and stall
      // the main thread at exactly the moment the user asked to go faster.
      step();
      const chibi = signal.aborted ? null : await loadChibiGrid();
      if (chibi) await typeGrid(boot, chibi, { durationMs: ms(HOLD.chibiType), signal });
      await wait(ms(HOLD.chibiDone), signal);

      // EYE — VIM-style clear, then the denser artwork
      step();
      if (!signal.aborted) {
        boot.textContent = ':q!';
        await wait(ms(HOLD.eyeClear), signal);
        const eyeGrid = await loadEyeGrid();
        if (eyeGrid) await typeGrid(boot, eyeGrid, { durationMs: ms(HOLD.eyeType), signal });
      }

      // EYE_3D — lifted off the terminal and spun, ending where it started.
      step();
      boot.classList.add('eye-3d');
      await wait(ms(HOLD.eyeSpin), signal);
    } else {
      // Short boot: the tube comes up with the shell line already printed and
      // the title takes over. No artwork is built, so none of the expensive
      // work happens at all.
      jump('PROMPT');
      showPrompt(boot).textContent = PROMPT_LINE;
      await wait(ms(HOLD.shortPrompt), signal);
      // Clear the terminal before the title arrives. Both are centred, so
      // leaving the prompt behind would put the shell line under the wordmark
      // — and the dock below would find the prompt's <pre> and fly THAT into
      // the O slot, shrinking the shell line into a 44x4 sliver beside the
      // title. The dock has nothing to dock in this mode; an empty terminal is
      // how it is told so.
      boot.textContent = '';
    }

    // SHRINK_TO_O — the eye flies into the title's reserved O slot.
    jump('SHRINK_TO_O');
    // The display font has to be resolved before the slot is measured. It is
    // declared `font-display: block`, so laying the title out early measures
    // fallback metrics; when Orbitron lands, "AALICE: " and "penEye" change
    // width, the centred line reflows, and the slot slides out from under the
    // eye the FLIP just aimed at it.
    try { await document.fonts?.load('1em "OpenEye Display"'); } catch { /* no font API */ }
    const slot = buildTitle(title);
    title.classList.add('shown');
    // Commit the new line's layout before measuring it.
    await nextFrame();
    await dockEyeIntoTitle(boot, slot, settle(MOTION.dockMs), signal);

    // TITLE — the letter takes over from the artwork WHILE the artwork is
    // still parked exactly on top of it. By the time the veil removes the
    // eye, the letter underneath is already at full strength, so there is
    // nothing to see at the swap.
    step();
    title.querySelector('.o-letter')?.classList.add('lit');
    await wait(ms(MOTION.letterMs), signal);
  } finally {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerdown', onPointer);
    hint?.remove();

    // End state, reached by playing through OR by skipping.
    if (!title.querySelector('.o-slot')) buildTitle(title);
    title.classList.add('shown');
    title.querySelector('.o-letter')?.classList.add('lit');
    boot.classList.remove('powered');
    enter(FINAL_STAGE);

    // The handoff, as three separated beats rather than four simultaneous
    // ones. Previously the veil faded out, the globe faded in, the title flew
    // to the corner and the eye was still docking — all from the same tick.

    // 1. The globe becomes opaque, still completely hidden behind the veil.
    //    It has been rendering there since before the sequence started, and
    //    it has no fade of its own precisely so that this is invisible.
    onReveal();
    await nextFrame();

    // 2. One dissolve. The veil and the CRT overlay retire together, and the
    //    terminal becomes the globe in a single movement. Because only one
    //    layer is animating, there is no interval where a half-transparent
    //    veil sits over a half-transparent globe — which is what used to dip
    //    the whole screen to about a fifth of its brightness mid-handoff.
    boot.classList.add('faded');
    opts.overlay?.classList.add('dissolved');
    await wait(ms(MOTION.veilMs), signal);

    // 3. Only once the globe is the visible surface does the title compress
    //    into the corner. Moving it any earlier moved the dock target out
    //    from under an eye that was still flying towards it.
    title.classList.add('docked');

    // The terminal is finished. Its 15k spans should not stay in the document
    // of an application that is meant to be left open.
    boot.textContent = '';
    boot.classList.add('retired');
  }
}
