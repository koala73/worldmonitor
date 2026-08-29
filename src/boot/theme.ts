/** Every colour in OpenEye originates here. Taken from the source artwork:
 *  black ground, blood red, magenta, white phosphor. */
export const PALETTE = {
  bg: '#000000',
  phosphor: '#ffd9d9',
  red: '#c81432',
  magenta: '#b4148c',
  white: '#ffffff',
  hair: '#ff6b6b',   // light red — the character's hair
  skin: '#ffd2b4',
  dress: '#0a0a0a',  // near-black, not pure, so it reads against the ground
  moon: '#cfcfcf',   // the moon's own grey — every colour lives here, no exceptions
} as const;

/** Boot-sequence motion, in milliseconds.
 *
 *  These are the durations that BOTH the director (as a JS `await`) and a
 *  stylesheet (as a transition duration) need to agree on. They live here for
 *  the same reason the palette does — a hand-copied duration drifts silently,
 *  and nothing fails when the two disagree. The failure it produces is not
 *  subtle: the director used to wait 1500 ms for a 1.5 s dock transition that
 *  had not started yet, so the eye was handed off to the fade-out while still
 *  in flight, and it visibly never landed on the letter.
 *
 *  Injected into `src/styles/*.css` as `--oe-<name>-ms` custom properties by
 *  the openeye-inject-theme-palette plugin (see vite.config.ts and
 *  src/config/css-tokens.ts). Anything purely decorative, that only CSS ever
 *  needs, stays in the stylesheet. */
export const MOTION = {
  /** The eye's FLIP flight from full screen into the title's O slot. */
  dockMs: 1300,
  /** Cross-fade from the docked artwork to the real letter underneath it. */
  letterMs: 800,
  /** The terminal veil dissolving away to reveal the globe behind it. */
  veilMs: 900,
  /** The title compressing from screen-centre into the corner. */
  titleDockMs: 1100,
  /** The CRT overlay retiring once the globe is the working surface. */
  overlayMs: 900,
} as const;

/*
 * AALICE:OpenEYE - the globe configuration that used to live here is gone.
 *
 * This file arrived from the standalone OpenEye app, where it also configured
 * that project's globe.gl globe: atmosphere colour, base textures, the
 * tile-activation altitude, camera clamps, and the parked sun/moon geometry
 * with its composition assertions. World Monitor's globe is God's Eye View's
 * Cesium viewer, which takes none of it - see src/components/CesiumGlobeMap.ts
 * for the camera contract that replaced `CAMERA`.
 *
 * Keeping it would have been worse than dead weight: a `CAMERA` export here
 * reads like the thing that governs the globe you can see, and it governs
 * nothing. What remains is exactly what the boot ceremony uses - the palette,
 * the motion timings the stylesheets and the director share, and the chibi
 * region masks. The full original is preserved in the openeye repo's history.
 */

export interface RegionMask {
  name: string;
  tint: string;
  /** u,v normalised across the grid: u = col/cols, v = row/rows. */
  test(u: number, v: number): boolean;
}

const inEllipse = (u: number, v: number, cu: number, cv: number, ru: number, rv: number) =>
  ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2 <= 1;

/** Order matters — first match wins. Calibrate with `npm run preview:chibi`.
 *
 *  There is deliberately NO dress mask, though PALETTE.dress exists.
 *  Rectangular masks fight this artwork rather than helping it, and the ramp
 *  already does the job: a dense glyph renders near-black under *any* tint
 *  (`@` at brightness 0.014 gives #040202 on hair vs #000000 on dress —
 *  indistinguishable), and the character's black dress is the densest region
 *  in the file. So a dress tint changes nothing where the dress actually is.
 *  What it *did* change was the sparse, bright pixels inside its bounds —
 *  crushing the collar and the dress's rim highlights to flat black and
 *  leaving a hard rectangular seam across an organic drawing. Verified by
 *  rendering both ways: without the mask the torso keeps its silhouette and
 *  its red rim light, and the pigtails and wings stay continuous.
 *
 *  Keep this in mind before adding region masks: they can only *subtract*
 *  brightness the ramp already encodes. Use one only to separate two regions
 *  of SIMILAR density that need different hues — which is exactly why skin
 *  needs one (the face and the hair are both mid-density, but must not be
 *  the same colour). */
export const CHIBI_REGIONS: RegionMask[] = [
  { name: 'skin', tint: PALETTE.skin, test: (u, v) => inEllipse(u, v, 0.43, 0.455, 0.175, 0.185) },
  { name: 'hair', tint: PALETTE.hair, test: () => true },
];
