# Brief magazine fonts

The brief magazine (`/api/brief/...`, rendered by `server/_shared/brief-render.js`) uses Playfair
Display, Source Serif 4 and IBM Plex Mono. They used to come from Google Fonts. They are now
served from `public/assets/brief-fonts/` as slimmed copies of the files Google serves, produced by
hand with the script here. The build does no font processing.

## Rerun

```sh
npm ci                          # repo root
npx playwright install chromium # once
# uv: https://docs.astral.sh/uv/ (installs the script's pinned Python packages)
npm run brief-fonts:subset
```

Commit what it rewrites: `public/assets/brief-fonts/`, `server/_shared/brief-fonts.generated.js`
and `scripts/brief-fonts/manifest.json`. A failed run writes nothing.

`node scripts/brief-fonts/run.mjs --skip-google-parity` skips the comparison with Google's files
(for offline experiments). `tests/brief-fonts-fresh.test.mjs` rejects that output.

To pick up new font files from Google, refresh the snapshot first and commit it too:

```sh
uv run scripts/brief-fonts/subset_brief_fonts.py --refresh-google-snapshot
npm run brief-fonts:subset
```

## When to rerun

`tests/brief-fonts-fresh.test.mjs` fails, naming the change, when:

- a `font-*`, `text-transform` or `hyphens` declaration in `brief-render.js` is added, changed,
  moved to another rule or removed (it can change which faces and weights are needed);
- a `lang` attribute in the renderer changes (the subsets drop `locl` and assume English).

`run.mjs` also stops if the rendered briefs turn on a font feature, variant or variation setting
the subsets do not keep. News text needs no rerun: each file keeps every character Google's
file has, except those another file of the same face draws first.

## How it works

1. `run.mjs` renders the sample briefs in `fixtures.mjs` and lays them out in Chromium at five
   widths. It records which face (family, style, weight) draws each text run and whether that face
   appears on the cover.
2. `subset_brief_fonts.py` reads `google-fonts-snapshot.json`, which lists the files Google serves
   to four classes of browser. Google sends Windows and Linux hinted IBM Plex Mono, sends Chrome on
   macOS italics with overlap flags, sends Safari and Firefox on macOS those italics as WOFF, and
   sends Android and iOS neither. For each class and each face the brief uses, it then:
   - keeps Google's split into latin, latin-ext, cyrillic and the other files, and the glyphs in
     each;
   - narrows each `unicode-range` to the characters that file draws. Chromium tries the last
     declared face first, so a character in two ranges belongs to the later file. Characters that
     no file of the face has keep Google's ranges, because Chrome renders some of them (U+2011)
     differently once they leave every range;
   - drops OpenType features the brief never turns on (`lnum`, `pnum`, `tnum`, `locl`). It keeps
     `frac`, `numr` and `dnom`, which HarfBuzz applies by itself around the fraction slash (U+2044);
   - drops the variable axis of Source Serif 4 roman, which the brief renders only at its default
     weight. Playfair Display keeps its axis, because pinning it at 900 would round outlines;
   - renames the fonts internally to WM Brief Display, WM Brief Text and WM Brief Mono, as the SIL
     Open Font License requires for modified fonts that have a Reserved Font Name. The CSS family
     names are unchanged;
   - refuses to write anything if a glyph outline, point flag, hinting instruction, advance or
     HarfBuzz shaping result differs from Google's file.
3. The route picks the class from the User-Agent (`server/_shared/brief-font-platform.js`) and
   sends `Vary: User-Agent`. The page inlines that class's `@font-face` rules and preloads the
   latin files of the faces on the cover.
