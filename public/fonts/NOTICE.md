# Bundled fonts

OpenEye ships these font files inside the application bundle. Both are licensed
under the SIL Open Font License, Version 1.1, whose full text is in
[`OFL-1.1.txt`](./OFL-1.1.txt) beside this file. The OFL requires that the
licence travel with the font whenever the font is redistributed, which is why
these files are in `public/` and therefore land in `dist/` and in the Tauri
bundle rather than being stripped as build-time-only assets.

| File | Family | Used for | Upstream |
|---|---|---|---|
| `vt323.woff2` | VT323 | The CRT terminal stages (`--oe` monospace, `OpenEye Mono`) | https://fonts.google.com/specimen/VT323 |
| `orbitron.woff2` | Orbitron | The "AALICE: OpenEye" title (`OpenEye Display`) | https://fonts.google.com/specimen/Orbitron |

Both were subset and converted to woff2 for offline use — the app makes no
network requests at runtime, so nothing may be fetched from a font CDN.

**If you redistribute this app, verify attribution against upstream.** The OFL
also requires each font's own copyright notice to accompany it, and the exact
notice (including any Reserved Font Name) belongs to the font's authors rather
than to this project. Copy the per-font `OFL.txt` header from the upstream
repository above into this directory before shipping a public build; this file
deliberately does not restate copyright lines it cannot verify.
