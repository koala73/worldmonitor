# Contributing to God's Eye View

Thanks for being here. God's Eye View is an open foundation for live spatial intelligence in the browser, and it gets better when more people run it, break it, and extend it.

## Getting set up

Use Node.js 24.14.x or 26.x (also enforced by `package.json`).

```bash
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
nvm install 24.14.0
nvm use 24.14.0
npm install
./scripts/dev-fresh.sh        # or: GOOGLE_MAPS_API_KEY="…" npm run dev
```

You need a **Google Maps API key** with the Map Tiles API enabled (see the [README](README.md#-api-keys)). Most data layers work with no other accounts. On macOS the launcher pulls keys from the Keychain; on any platform you can pass them as env vars or use a `.env` (copy `.env.example`).

Open `http://localhost:4173`. Before sending a PR run `npm run build`, `npm test`, and `npm run test:track` (dev server must be up) — **all three must stay green.**

## Good first contributions

The highest-leverage places to jump in:

- **🌆 Add a CCTV source pack.** Austin is the reference camera source. Adding another city means a clean public camera catalog with coordinates, attribution, and server-registered frame URLs (the proxy only fetches registered URLs — never client-supplied ones, see [SECURITY.md](SECURITY.md)). City packs are the best first lane.
- **🛰️ Add or improve a data layer.** Each layer is one self-contained module in `src/data/<layer>.js` implementing the layer interface (`init/enable/disable/update/destroy/getStats`, optional `getDetectableObjects`/`getStats`). Use an existing layer as a template.
- **🎙️ Extend voice control.** Voice tools are declared server-side (`GEV_REALTIME_TOOLS` in `vite.config.js`) and executed client-side (`src/voice/gevActions.js`). Keep the tool surface tight and the responses honest (confirm only what actually happened).
- **🎨 Add a visual style.** Styles are GLSL post-process shaders in `src/styles/`.
- **🐛 Fix bugs / improve the first-run experience.** See [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md).

## Architecture in one minute

- **No framework.** Vanilla JS + [CesiumJS](https://cesium.com/platform/cesiumjs/) + [Vite](https://vitejs.dev/).
- **UI lives in `src/ui.js`** (panels, HUD, styles, the control facade). **Layer logic lives in `src/data/<layer>.js`.** Keep them separate.
- **Secrets stay server-side.** Anything needing a private key goes through a Vite proxy in `vite.config.js`. The browser only ever sees the Google Maps key (which you restrict) and ephemeral tokens.
- `docs/CURRENT-STATE.md` is the authoritative runtime reference — read it first.

## Coding style

- ES modules, **2-space indent, single quotes, semicolons.**
- JSDoc on exported/public functions.
- Match the surrounding code — comment density, naming, and idiom.
- Prefer small, reviewable commits. Conventional-commit-style prefixes (`feat:`, `fix:`, `perf:`, `docs:`) are appreciated but not required.

## Pull requests

1. Branch off `main`.
2. Keep `npm run build`, `npm test`, and `npm run test:track` green and avoid new console errors.
3. If you change runtime behavior, update `docs/CURRENT-STATE.md` and `CHANGELOG.md` in the same PR.
4. If you add or change a data source, update [DATA_SOURCES.md](DATA_SOURCES.md) with its license and attribution. **Don't add data you don't have the right to redistribute** — fetch it at runtime instead.
5. Describe what you changed and how you verified it (screenshots welcome for anything visual).

## Ground rules

- This is a tool for **public** data. Don't add scraping of sources whose terms forbid it, private/paywalled datasets, or anything that misrepresents public-data inference as authoritative intelligence.
- Be decent to each other. Assume good faith, keep it constructive.

By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).
