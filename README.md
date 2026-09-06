# World Monitor

[简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md)

**Real-time global intelligence dashboard** — AI-powered news aggregation, geopolitical monitoring, and infrastructure tracking in a unified situational awareness interface.

[![GitHub stars](https://img.shields.io/github/stars/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/stargazers)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/re63kWKxaz)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Last commit](https://img.shields.io/github/last-commit/koala73/worldmonitor)](https://github.com/koala73/worldmonitor/commits/main)
[![Latest release](https://img.shields.io/github/v/release/koala73/worldmonitor?style=flat)](https://github.com/koala73/worldmonitor/releases/latest)
[![npm: worldmonitor](https://img.shields.io/npm/v/worldmonitor?logo=npm&label=npm)](https://www.npmjs.com/package/worldmonitor)
[![skills.sh](https://skills.sh/b/koala73/worldmonitor)](https://skills.sh/koala73/worldmonitor)

<p align="center">
  <a href="https://www.worldmonitor.app"><img src="https://img.shields.io/badge/Web_App-worldmonitor.app-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Web App"></a>&nbsp;
  <a href="https://tech.worldmonitor.app"><img src="https://img.shields.io/badge/Tech_Variant-tech.worldmonitor.app-0891b2?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Tech Variant"></a>&nbsp;
  <a href="https://finance.worldmonitor.app"><img src="https://img.shields.io/badge/Finance_Variant-finance.worldmonitor.app-059669?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Finance Variant"></a>&nbsp;
  <a href="https://commodity.worldmonitor.app"><img src="https://img.shields.io/badge/Commodity_Variant-commodity.worldmonitor.app-b45309?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Commodity Variant"></a>&nbsp;
  <a href="https://happy.worldmonitor.app"><img src="https://img.shields.io/badge/Happy_Variant-happy.worldmonitor.app-f59e0b?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Happy Variant"></a>&nbsp;
  <a href="https://energy.worldmonitor.app"><img src="https://img.shields.io/badge/Energy_Variant-energy.worldmonitor.app-eab308?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Energy Variant"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/worldmonitor"><img src="https://img.shields.io/npm/v/worldmonitor?style=for-the-badge&logo=npm&logoColor=white&label=npm%20i%20worldmonitor&color=CB3837" alt="npm i worldmonitor"></a>&nbsp;
  <a href="https://www.npmjs.com/package/worldmonitor"><img src="https://img.shields.io/badge/CLI-npx%20worldmonitor-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npx worldmonitor"></a>&nbsp;
  <a href="https://pypi.org/project/worldmonitor-sdk/"><img src="https://img.shields.io/pypi/v/worldmonitor-sdk?style=for-the-badge&logo=pypi&logoColor=white&label=pip%20install%20worldmonitor-sdk&color=3775A9" alt="pip install worldmonitor-sdk"></a>&nbsp;
  <a href="https://rubygems.org/gems/worldmonitor"><img src="https://img.shields.io/gem/v/worldmonitor?style=for-the-badge&logo=rubygems&logoColor=white&label=gem%20install%20worldmonitor&color=E9573F" alt="gem install worldmonitor"></a>&nbsp;
  <a href="https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go"><img src="https://img.shields.io/badge/go%20get-sdk%2Fgo-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="go get github.com/koala73/worldmonitor/sdk/go"></a>
</p>

<p align="center">
  <a href="https://www.worldmonitor.app/api/download?platform=windows-exe"><img src="https://img.shields.io/badge/Download-Windows_(.exe)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows"></a>&nbsp;
  <a href="https://www.worldmonitor.app/api/download?platform=macos-arm64"><img src="https://img.shields.io/badge/Download-macOS_Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS ARM"></a>&nbsp;
  <a href="https://www.worldmonitor.app/api/download?platform=macos-x64"><img src="https://img.shields.io/badge/Download-macOS_Intel-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel"></a>&nbsp;
  <a href="https://www.worldmonitor.app/api/download?platform=linux-appimage"><img src="https://img.shields.io/badge/Download-Linux_(.AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux"></a>
</p>

<p align="center">
  <a href="https://www.worldmonitor.app/docs/documentation"><strong>Documentation</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>Releases</strong></a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/contributing"><strong>Contributing</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## What It Does

- **Curated news feeds** across global and regional categories, AI-synthesized into briefs
- **Dual map engine** — 3D globe (globe.gl) and WebGL flat map (deck.gl) with a shared map-layer catalog
- **Panel inventory** — concrete panel implementations across specialized variants
- **Cross-stream correlation** — military, economic, disaster, and escalation signal convergence
- **[Country Instability Index (CII)](https://www.worldmonitor.app/country-instability-index/)** — live CII v8 scores, bands, and approximate 24-hour movement for 31 Tier-1 countries
- **Finance radar** — stock exchanges, commodities, crypto, and a market composite
- **Local AI** — run everything with Ollama, no API keys required
- **Site variants** from a single codebase (world, tech, finance, commodity, happy, energy)
- **Native desktop app** (Tauri 2) for macOS, Windows, and Linux
- **Multilingual UI** with native-language feeds and RTL support

For the full feature list, architecture, data sources, and algorithms, see the **[documentation](https://www.worldmonitor.app/docs/documentation)**.

---

## Support Status

All site variants and desktop binaries are built from a single codebase and ship from the same release process. The table below clarifies maintenance status so you know which surfaces are safe to depend on.

| Surface | Status | Notes |
|---------|--------|-------|
| `worldmonitor.app`, `tech.`, `finance.`, `commodity.`, `happy.`, `energy.` | Stable | Public deployments built from this repo, actively maintained |
| Desktop binaries (Windows / macOS Apple Silicon / macOS Intel / Linux AppImage) | Stable | One Tauri binary for every variant — install World Monitor and switch to tech, finance, commodity, energy, or happy in-app. There is deliberately no per-variant download |

Issues filed against any of the above are triaged from the same backlog — see the [issues board](https://github.com/koala73/worldmonitor/issues) for currently-open work.

---

## Quick Start

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

Open [localhost:3000](http://localhost:3000) (override the port with `DEV_PORT` in `.env.local`). The app runs with no environment variables.

Feature-specific data sources may require credentials. See `.env.example` for the full list.

For variant-specific development:

```bash
npm run dev:tech       # tech.worldmonitor.app
npm run dev:finance    # finance.worldmonitor.app
npm run dev:commodity  # commodity.worldmonitor.app
npm run dev:happy      # happy.worldmonitor.app
npm run dev:energy     # energy.worldmonitor.app
```

See the **[self-hosting guide](https://www.worldmonitor.app/docs/getting-started)** for deployment options (Vercel, Docker, static).

---

## Tech Stack

| Category | Technologies |
|----------|-------------|
| **Frontend** | Vanilla TypeScript, Vite, globe.gl + Three.js, deck.gl + MapLibre GL |
| **Desktop** | Tauri 2 (Rust) with Node.js sidecar |
| **AI/ML** | Ollama / Groq / OpenRouter, Transformers.js (browser-side) |
| **API Contracts** | Protocol Buffers and sebuf HTTP annotations |
| **Deployment** | Vercel Edge Functions, Railway relay, Tauri, PWA |
| **Caching** | Redis (Upstash), 3-tier cache, CDN, service worker |

Full stack details in the **[architecture docs](https://www.worldmonitor.app/docs/architecture)**.

---

## Programmatic Access

World Monitor is built for agents and scripts as well as browsers:

- **MCP server** — `https://worldmonitor.app/mcp` (Streamable HTTP). Public `tools/list`; `tools/call` authenticates with a `X-WorldMonitor-Key` header or OAuth.
  The server also publishes its Agent Skills through the draft `io.modelcontextprotocol/skills` extension (`skills/list`, `skills/get`, and `skill://…` resource reads).
- **REST API** — base `https://api.worldmonitor.app`, described by the [OpenAPI spec](https://worldmonitor.app/openapi.yaml).
- **CLI** — the official [`worldmonitor`](https://www.npmjs.com/package/worldmonitor) npm package (source in [`cli/`](cli/)):

  ```sh
  npx worldmonitor tools          # run ad-hoc — list every MCP tool (no key needed)
  npm install -g worldmonitor     # or install the `worldmonitor` (alias `wm`) command
  worldmonitor risk IR --api-key wm_xxx
  ```

- **SDKs** — official zero-dependency client libraries mirroring the CLI: Python [`worldmonitor-sdk`](https://pypi.org/project/worldmonitor-sdk/) (source in [`sdk/python/`](sdk/python/)), Ruby [`worldmonitor`](https://rubygems.org/gems/worldmonitor) ([`sdk/ruby/`](sdk/ruby/)), Go [`github.com/koala73/worldmonitor/sdk/go`](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) ([`sdk/go/`](sdk/go/)). Guide: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks).

Agent discovery files: [`llms.txt`](https://worldmonitor.app/llms.txt) · [agent-skills manifest](https://worldmonitor.app/.well-known/agent-skills/index.json) · [api-catalog](https://worldmonitor.app/.well-known/api-catalog). Get an API key at [worldmonitor.app/pro](https://www.worldmonitor.app/pro).

---

## Flight Data

Flight data provided graciously by [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor), the most advanced ADS-B flight data solution.

---

## Data Sources

WorldMonitor aggregates attributed upstream sources across geopolitics, finance, energy, climate, aviation, cyber, military, infrastructure, and news intelligence. Curated feeds and freshness-tracked source groups are published in the full [data sources catalog](https://www.worldmonitor.app/docs/data-sources), with provider, feed-tier, license-posture, and collection-method details.

---

## Contributing

Contributions welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

```bash
npm run typecheck        # Type checking
npm run build:full       # Production build
```

---

## License

**AGPL-3.0-only** for the source code. Commercial use is permitted under the AGPL when you comply with its copyleft and source-availability terms.

| Use Case | Allowed? |
|----------|----------|
| Personal / research / educational | Yes, under AGPL-3.0-only |
| Self-hosted instance | Yes, under AGPL-3.0-only |
| Fork and modify | Yes, share source under AGPL-3.0-only when required |
| Commercial use / SaaS | Yes, under AGPL-3.0-only when you comply with AGPL obligations |
| Private-source proprietary use or official branding rights | Separate commercial or trademark permission needed |

See [LICENSE](LICENSE) for the full code license and [docs/license.mdx](docs/license.mdx) for a plain-language summary. Commercial licensing is available as an alternative option for teams that need non-AGPL terms.

Copyright (C) 2024-2026 Elie Habib. All rights reserved.

---

## Author

**Elie Habib** — [GitHub](https://github.com/koala73)

## Contributors

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

## Security Acknowledgments

We thank the following researchers for responsibly disclosing security issues:

- **Cody Richard** — Disclosed three security findings covering IPC command exposure, renderer-to-sidecar trust boundary analysis, and fetch patch credential injection architecture (2026)

See our [Security Policy](./SECURITY.md) for responsible disclosure guidelines.

---

<p align="center">
  <a href="https://www.worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/documentation">docs.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://commodity.worldmonitor.app">commodity.worldmonitor.app</a>
</p>

## Star History

<a href="https://star-history.dera.page/#koala73/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://star-history.dera.page/svg?repos=koala73/worldmonitor&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://star-history.dera.page/svg?repos=koala73/worldmonitor&type=Date" />
 </picture>
</a>


## 🌐 Web Resources & Interactive Index
- [IDLE LEGEND](https://themindzone.pages.dev/idle-legend.html)
- [SPRUNKI POPIT](https://learnquester.pages.dev/sprunki-popit.html)
- [COFFEE CRAZE SORTING GAME](https://studyplayings.web.app/coffee-craze-sorting-game.html)
- [AUTUMN GLAM GALA](https://studyplayings.pages.dev/autumn-glam-gala.html)
- [TOSS THE RING](https://studyplayings.pages.dev/toss-the-ring.html)
- [INDEX16](https://studyplayings.pages.dev/index16.html)
- [CATEGORY IDLE445](https://learnquester.github.io/category-idle445.html)
- [BLOCK PUZZLE KING](https://themindplaying.web.app/block-puzzle-king.html)
- [XMAS HEXA SORT](https://iskillplay.web.app/xmas-hexa-sort.html)
- [COLORS PINS](https://studyplayings.pages.dev/colors-pins.html)
- [BANANA BOUNCE](https://studyplayings.pages.dev/banana-bounce.html)
- [LIVE 100 DAYS](https://themindplays.pages.dev/live-100-days.html)
- [PIN DETECTIVE](https://iskillplay.web.app/pin-detective.html)
- [MAIDO](https://studyplayings.pages.dev/maido.html)
- [CATEGORY FPS GAMES](https://themindplay.pages.dev/category-fps-games.html)
- [NOOB SHOOTER GUN BATTLE 3D](https://studyplayings.pages.dev/noob-shooter-gun-battle-3d.html)
- [RAGDOLL MEGA DUNK](https://studyplayings.web.app/ragdoll-mega-dunk.html)
- [ANTS EMPIRE EVOLVE SIM](https://thelearnquester.web.app/ants-empire-evolve-sim.html)
- [COLOSSATRON](https://iskillquest.pages.dev/colossatron.html)
- [HITMAN SNIPER](https://iskillplay.web.app/hitman-sniper.html)
- [ABOUT A FROG](https://studyplayings.pages.dev/about-a-frog.html)
- [FIERCE BATTLE BREAKOUT](https://thelearnquester.web.app/fierce-battle-breakout.html)
- [SCHOOL TEACHER SIMULATOR](https://studyplaying.github.io/school-teacher-simulator.html)
- [JUST DICE RANDOM TOWER DEFENCE](https://thelearnquester.web.app/just-dice-random-tower-defence.html)
- [PET TILE MASTER](https://studyplayings.pages.dev/pet-tile-master.html)
- [CATEGORY RELAXING223](https://studyplayings.pages.dev/category-relaxing223.html)
- [CATEGORY MOUSE1 697](https://skillplay.github.io/category-mouse1-697.html)
- [CYBER HIGHWAY ESCAPE](https://thequizzone.pages.dev/cyber-highway-escape.html)
- [DINO SIMULATOR CITY ATTACK](https://iskillplay.web.app/dino-simulator-city-attack.html)
- [AGENT SQUAD](https://studyplayings.pages.dev/agent-squad.html)
- [ARROW SLIDE PUZZLE](https://themindplays.pages.dev/arrow-slide-puzzle.html)
- [AMAZING AIRPLANE RACER](https://thelearnquester.web.app/amazing-airplane-racer.html)
- [FAST LAP](https://iskillplay.web.app/fast-lap.html)
- [CATEGORY STRATEGY 2](https://thelearnquester.web.app/category-strategy-2.html)
- [CHICKEN WARS MERGE GUNS](https://iskillquest.pages.dev/chicken-wars-merge-guns.html)
- [MOJO MATCH 3D](https://studyplayings.pages.dev/mojo-match-3d.html)
- [STICKMAN VS ZOMBIES WORLDCRAFT](https://thequizzone.pages.dev/stickman-vs-zombies-worldcraft.html)
- [STEAL ITEMS IO](https://studyplayings.pages.dev/steal-items-io.html)
- [PARKING FURY 3D BEACH CITY 2](https://theskillquest.pages.dev/parking-fury-3d-beach-city-2.html)
- [CATEGORY UNBLOCK](https://themindplays.pages.dev/category-unblock.html)
- [EASTER SHADOW MATCH](https://themindplays.pages.dev/easter-shadow-match.html)
- [CATEGORY MONSTER206](https://iskillquest.pages.dev/category-monster206.html)
- [WORD OF FORTUNE](https://studyplaying.github.io/word-of-fortune.html)
- [BUSY BEE HIVE](https://themindplaying.web.app/busy-bee-hive.html)
- [AVENGER GUARD](https://studyplaying.github.io/avenger-guard.html)
- [CHAOS ROAD COMBAT CAR RACING](https://studyplayings.pages.dev/chaos-road-combat-car-racing.html)
- [GEOMETRY PLATFORMER](https://thequizzone.pages.dev/geometry-platformer.html)
- [BUBBLE SHOOTER WILD WEST](https://themindplays.pages.dev/bubble-shooter-wild-west.html)
- [WORD SEARCH WITH HINTS](https://iskillquest.pages.dev/word-search-with-hints.html)
- [DYNAMONS 11](https://thequizzone.pages.dev/dynamons-11.html)
- [DARLING DOLL](https://iskillquest.pages.dev/darling-doll.html)
- [INDEX3](https://thelearnquester.web.app/index3.html)
- [INDEX19](https://thelearnquester.web.app/index19.html)
- [SNAKE 2048IO](https://thelearnquester.web.app/snake-2048io.html)
- [FALLING PARTY](https://iskillplay.web.app/falling-party.html)
- [CATEGORY CASUAL 4](https://skillplay.github.io/category-casual-4.html)
- [CARGO SKATES](https://iskillplay.web.app/cargo-skates.html)
- [BLOCKY ARCHER RUN](https://theskillquest.pages.dev/blocky-archer-run.html)
- [NG FLOW LINES](https://studyplayings.web.app/ng-flow-lines.html)
- [HOARD MASTER](https://thelearnquester.web.app/hoard-master.html)
- [ICONIC HALLOWEEN COSTUMES](https://studyplaying.github.io/iconic-halloween-costumes.html)
- [CARD BATTLE](https://iskillplay.web.app/card-battle.html)
- [HIDDEN OBJECTS ISLAND](https://studyplayings.web.app/hidden-objects-island.html)
- [CATEGORY DRAWING34](https://studyplayings.pages.dev/category-drawing34.html)
- [MUSHROOM FEVER MATCH 3](https://themindplays.pages.dev/mushroom-fever-match-3.html)
- [SOLITAIRE KLONDIKE](https://iskillplay.web.app/solitaire-klondike.html)
- [CATEGORY RAGDOLL57](https://thelearnquester.web.app/category-ragdoll57.html)
- [SAMURAI LEGACY](https://studyplayings.pages.dev/samurai-legacy.html)
- [CALL OF THE JUNGLE ANIMAL EVOLUTION](https://studyplaying.github.io/call-of-the-jungle-animal-evolution.html)
- [DADDY CACTUS](https://thelearnquester.web.app/daddy-cactus.html)
- [ALIEN HUNTERS](https://themindplays.pages.dev/alien-hunters.html)
- [CATEGORY UNBLOCKER](https://themindplays.pages.dev/category-unblocker.html)
- [COLLEGE GIRL COLORING DRESS UP](https://studyplayings.pages.dev/college-girl-coloring-dress-up.html)
- [DESTRUCTION SIMULATOR](https://studyplayings.pages.dev/destruction-simulator.html)
- [CATEGORY BLOCK94](https://themindplays.pages.dev/category-block94.html)
- [PRIVACY](https://learnquester.github.io/privacy.html)
- [NORTHERN LIGHTS THE SECRET OF THE FOREST](https://iskillquest.pages.dev/northern-lights-the-secret-of-the-forest.html)
- [MEDIEVAL ESCAPE](https://studyplayings.pages.dev/medieval-escape.html)
- [MY PERFECT YEAR PLANNER](https://thequizzone.pages.dev/my-perfect-year-planner.html)
- [SNAKE CLASSIC](https://iskillplay.web.app/snake-classic.html)
- [CLOWNFISH PIN OUT](https://iskillquest.pages.dev/clownfish-pin-out.html)
- [CATEGORY STICKMAN](https://studyplayings.pages.dev/category-stickman.html)
- [PICK BRAINROT 3D BATTLE](https://thequizzone.pages.dev/pick-brainrot-3d-battle.html)
- [BRAINROT BOING BOING MERGE](https://studyplayings.web.app/brainrot-boing-boing-merge.html)
- [SINGLE LINE PUZZLE DRAWING](https://studyplayings.web.app/single-line-puzzle-drawing.html)
- [CATEGORY TANK](https://studyplayings.web.app/category-tank.html)
- [RAGDOLL BEAT SIMULATOR](https://iskillplay.web.app/ragdoll-beat-simulator.html)
- [CATEGORY BIKE 3](https://themindplays.pages.dev/category-bike-3.html)
- [CUBATORIA MERGE 2048](https://thelearnquester.web.app/cubatoria-merge-2048.html)
- [SNAKES](https://iskillplay.web.app/snakes.html)
- [STICKMAN JAILBREAK STORY](https://thelearnquester.web.app/stickman-jailbreak-story.html)
- [REACH 2048](https://studyplayings.pages.dev/reach-2048.html)
- [KITTY MATCH 3 PUZZLE GAME](https://studyplayings.pages.dev/kitty-match-3-puzzle-game.html)
- [STICKMAN SANTA](https://thequizzone.pages.dev/stickman-santa.html)
- [CATEGORY SHOOTER](https://iskillquest.pages.dev/category-shooter.html)
- [ESCAPE OR DIE TROLL DEVIL LEVELS](https://thequizzone.pages.dev/escape-or-die-troll-devil-levels.html)
- [OIL DIGGING](https://themindplay.pages.dev/oil-digging.html)
- [HUNTER UNDERWATER SPEARFISHING](https://iskillquest.pages.dev/hunter-underwater-spearfishing.html)
- [TEAM LOYALTY](https://themindplay.pages.dev/team-loyalty.html)
- [NORTHERN LIGHTS THE SECRET OF THE FOREST](https://themindplays.pages.dev/northern-lights-the-secret-of-the-forest.html)
- [SUPERHERO PHONE SIMULATOR](https://themindplays.pages.dev/superhero-phone-simulator.html)
- [THREAD SORT](https://thequizzone.pages.dev/thread-sort.html)
- [ZUMBIA QUEST](https://iskillplay.web.app/zumbia-quest.html)
- [SECRETS OF CHARMLAND](https://thequizzone.pages.dev/secrets-of-charmland.html)
- [MILITARY CUBES 2048](https://studyplaying.github.io/military-cubes-2048.html)
- [SORTING CANDY FACTORY](https://learnquester.github.io/sorting-candy-factory.html)
- [GEOMETRY VIBES X BALL](https://studyplayings.web.app/geometry-vibes-x-ball.html)
- [DRAW TO FLY](https://thequizzone.pages.dev/draw-to-fly.html)
- [VOLLEY BEAN](https://themindplays.pages.dev/volley-bean.html)
- [DINO SHOOTER PRO](https://thequizzone.pages.dev/dino-shooter-pro.html)
- [SQUAD ASSEMBLER](https://themindplay.pages.dev/squad-assembler.html)
- [SAVE BABY CAPYBARAS PULL PIN](https://studyplaying.github.io/save-baby-capybaras-pull-pin.html)
- [ECHOLOCATION SHOOTER](https://themindzone.pages.dev/echolocation-shooter.html)
- [MERMAID PRINCESS AVATER CASTLE](https://learnquester.github.io/mermaid-princess-avater-castle.html)
- [COMBINE PICKAXES](https://studyplayings.pages.dev/combine-pickaxes.html)
- [PONGOAL](https://thequizzone.pages.dev/pongoal.html)
- [CRAZYZOMBIES 3D](https://thequizzone.pages.dev/crazyzombies-3d.html)
- [SLAP AND RUN](https://thequizzone.pages.dev/slap-and-run.html)
- [CATEGORY IDLE](https://thelearnquester.web.app/category-idle.html)
- [SNAKE KING](https://iskillquest.pages.dev/snake-king.html)
- [SLIDING PUZZLE](https://thequizzone.pages.dev/sliding-puzzle.html)
- [CATEGORY WAR137](https://studyplayings.pages.dev/category-war137.html)
- [FLOWER BLOCK](https://learnquester.github.io/flower-block.html)
- [CATEGORY BATTLE CATEGORY](https://iskillquest.pages.dev/category-battle-category.html)
- [VENETIAN LOVE AFFAIR](https://thelearnquester.web.app/venetian-love-affair.html)
- [INDEX8](https://thelearnquester.web.app/index8.html)
- [CATEGORY BLOCK94](https://studyplayings.web.app/category-block94.html)
- [MAZOO](https://studyplayings.web.app/mazoo.html)
- [HIPPO SUPERMARKET](https://thelearnquester.web.app/hippo-supermarket.html)
- [HILL CLIMB TRUCK TRANSFORM ADVENTURE](https://studyplayings.pages.dev/hill-climb-truck-transform-adventure.html)
