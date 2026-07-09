# Private demo customization

This fork includes a visual-only demo overlay for internal presentation use.

## What changed

- Adds `src/styles/private-demo.css`.
- Imports that overlay from `src/styles/base-layer.css`.
- Rebrands visible UI labels to `Falcon Monitor` / `FALCON MONITOR`.
- Hides hosted SaaS `Pro`, `Upgrade`, sign-in, checkout, Discord, X, and official funnel links from the demo UI.
- Hides locked/premium placeholder panels instead of attempting to unlock paid or server-side features.

## What did not change

- No entitlement logic was bypassed.
- No server-side paid feature was unlocked.
- No license or copyright file was removed.
- The upstream project remains AGPL-3.0-only.

## Important license note

This repository remains based on World Monitor and must continue to comply with AGPL-3.0-only obligations when self-hosted, distributed, or modified. Keep the `LICENSE` file and copyright notices intact, and provide corresponding source code when required by the license.
