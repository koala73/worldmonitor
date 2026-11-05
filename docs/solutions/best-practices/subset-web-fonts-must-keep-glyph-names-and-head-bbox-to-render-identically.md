---
title: Subset web fonts render identically only if they keep glyph names, the original head bbox and Google's instancing rounding
date: 2026-11-04
category: best-practices
module: blog-site/scripts/fonts/subset
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Replacing Google Fonts (or any served font) with self-hosted subsets that must look the same"
  - "Subsetting or instancing a variable font with fontTools"
  - "Pixel-diffing font changes in Chromium on macOS"
tags:
  - web-fonts
  - fonttools
  - variable-fonts
  - coretext
  - pixel-diff
  - blog
---

# Subset web fonts render identically only if they keep glyph names, the original head bbox and Google's instancing rounding

## Context

PR #10145 moved the blog (`blog-site/`) from Google Fonts to self-hosted subsets of Inter, JetBrains Mono and Space Grotesk. The requirement was zero visual change. Outline and shaping comparisons with HarfBuzz all passed, yet full-page screenshots in Playwright Chromium on macOS still showed 11–14 px differences on most pages. Matching outlines is not enough: CoreText's rasterizer reads tables that have no effect on outlines.

## Guidance

When cutting a font that must render like a reference file (`blog-site/scripts/fonts/subset/subset_fonts.py` does all of this):

1. **Keep glyph names.** fontTools' `Subsetter` defaults to `glyph_names=False`, which writes `post` format 3. CoreText then rasterizes some glyphs differently. Set `options.glyph_names = True`. This costs about 0.2–1 KB per file.
2. **Keep the reference file's `head` bounding box.** Changing `head.yMax` alone changed rasterization on macOS. Copy `xMin/yMin/xMax/yMax` from the Google subset that supplied the characters, and save with `recalcBBoxes = False`. Google's files are themselves split by unicode-range, so each subset has its own box. Use the box of the subset that draws most of a file's used characters, and record any characters that came from a different subset.
3. **Instance with `instantiateVariableFont(..., optimize=True)`.** Google's pipeline applies IUP optimization. With `optimize=False`, points drift by up to 0.18 units and outlines stop matching. Reload the font from bytes before subsetting; lazily loaded `gvar` otherwise raises `KeyError` on glyph names.
4. **Trim axes only at whole sides.** Cutting `wght` 100–900 down to 400–900 (dropping the whole lower side of the default) is exact. Cutting to 400–700 cuts inside a side, rescales the deltas, and rounds by 1–2 units, for almost no saving. Pinning an axis to one value can also move glyphs: Space Grotesk at a static 700 changed 16 glyphs, so it kept its full axis.
5. **Expect features the CSS never asks for.** Chrome's UA stylesheet gives `::marker` `font-variant-numeric: tabular-nums`, so `tnum` is in use on any page with an ordered or bulleted list, even with no `tabular-nums` in the site's CSS. Read features from computed styles, including `::marker`.
6. **`prep`, `STAT` and `HVAR` don't affect macOS rendering.** Google still serves Windows and Linux a 7-byte `prep` for dropout control, so keep it if it exists.

Also make output deterministic: `recalcTimestamp = False`, otherwise `head.modified` changes every run.

## Why This Matters

Each of these differences is a sub-pixel rendering change. That is enough to fail a "no visual change" bar and to make pixel diffs useless as evidence. Glyph names and the `head` box are invisible to outline hashes and HarfBuzz shaping checks, so only a rendered comparison catches them.

## When to Apply

- Any time a font file is regenerated and must look the same as before: subsetting, instancing, re-hosting.
- Before blaming a font change for a screenshot diff, capture the same build twice. In this work, JetBrains Mono showed a Chromium glyph-cache race (max channel delta 69), and smooth scrolling shifted the fixed header by 2 px. Both appeared between two captures of the *baseline*. Use `window.scrollTo({ behavior: 'instant' })` and compare against that noise floor.

## Examples

```python
opts = Options()
opts.glyph_names = True          # post format 2; format 3 changes CoreText raster
opts.hinting = True               # keep the 7-byte prep
font = instancer.instantiateVariableFont(src, {'wght': (400, 900)}, optimize=True)
font = TTFont(io.BytesIO(font_bytes(font)))   # reload: lazy gvar KeyError otherwise
...
head = font['head']
head.xMin, head.yMin, head.xMax, head.yMax = google_subset_bbox
font.recalcBBoxes = False
font.recalcTimestamp = False
```

Result on the blog: every element pair (code, ó from the extended file, ×, synthesized italic, CJK fallback, Space Grotesk header) differs by 0 px at 2×. Full-page diffs of all 106 pages leave only the same-build noise. Font bytes per page drop from 102,897 to 56,464.
