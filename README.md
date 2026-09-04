<div align="center">

# 🌿 THE GREEN HOUSE

### Global environmental · biological · pharmaceutical · regulatory intelligence

**A free-first situational-awareness surface built on the WorldMonitor engine.**  
Real-time news, maps, public data, infrastructure signals, markets, weather, disasters, and cross-stream intelligence in one interface.

[![GitHub stars](https://img.shields.io/github/stars/sonoxo/thegreenhouse?style=social)](https://github.com/sonoxo/thegreenhouse/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-2ea043.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Last commit](https://img.shields.io/github/last-commit/sonoxo/thegreenhouse)](https://github.com/sonoxo/thegreenhouse/commits/main)
[![WorldMonitor Engine](https://img.shields.io/badge/Engine-WorldMonitor-0b8f55?style=flat)](https://github.com/koala73/worldmonitor)
[![Free First](https://img.shields.io/badge/Data-Zero--Cost--First-22c55e?style=flat)](#free--public-data-first)

<p>
  <a href="https://github.com/sonoxo/thegreenhouse"><img src="https://img.shields.io/badge/GREEN_HOUSE-OPEN_REPOSITORY-16a34a?style=for-the-badge&logo=github&logoColor=white" alt="Open Green House"></a>&nbsp;
  <a href="https://github.com/koala73/worldmonitor"><img src="https://img.shields.io/badge/UPSTREAM-WORLDMONITOR-0891b2?style=for-the-badge&logo=github&logoColor=white" alt="WorldMonitor upstream"></a>&nbsp;
  <a href="#quick-start"><img src="https://img.shields.io/badge/LOCAL_LAUNCH-NPM_RUN_DEV-14532d?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Local launch"></a>
</p>

<p>
  <a href="#what-it-does"><strong>Capabilities</strong></a> &nbsp;·&nbsp;
  <a href="#quick-start"><strong>Quick Start</strong></a> &nbsp;·&nbsp;
  <a href="#free--public-data-first"><strong>Free Data</strong></a> &nbsp;·&nbsp;
  <a href="#architecture"><strong>Architecture</strong></a> &nbsp;·&nbsp;
  <a href="#license--upstream-attribution"><strong>License</strong></a>
</p>

</div>

![The Green House / WorldMonitor intelligence dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## What It Does

The Green House keeps the high-density WorldMonitor experience while organizing it as a **free-first public intelligence surface** for environmental, biological, pharmaceutical, regulatory, infrastructure, and global-event awareness.

- **Curated global news feeds** with regional and topical intelligence streams
- **Dual map engine** — 3D globe plus high-performance WebGL flat mapping
- **Environmental intelligence** — weather, climate, earthquakes, disasters, energy and infrastructure signals
- **Bio / public-health context** — public datasets and evidence-oriented monitoring surfaces where available
- **Pharma / regulatory context** — structured public-source monitoring for regulatory and market awareness
- **Cross-stream correlation** across geopolitical, economic, infrastructure and disaster signals
- **Finance radar** — exchanges, commodities, crypto and market context
- **Browser-side AI capability** through Transformers.js where appropriate
- **Optional AI providers** such as Groq / OpenRouter without making paid services the baseline requirement
- **Desktop-capable upstream architecture** through Tauri 2
- **Multilingual interface** inherited from the WorldMonitor codebase

> **Identity:** The Green House is an independent derivative/integration built from the open-source WorldMonitor codebase. It is not the official WorldMonitor project. Upstream attribution and AGPL obligations remain intact.

---

## Free / Public Data First

The Green House baseline is designed around **zero-cost-first access**.

| Source / Capability | Baseline posture |
|---|---|
| Open-Meteo | Public / no-key weather data |
| USGS | Public earthquake and geology feeds |
| GDELT | Open global events and media intelligence |
| UNHCR | Public humanitarian / displacement data |
| WorldPop | Public population datasets |
| FAA NASSTATUS | Public aviation status information |
| OpenFreeMap | Free map-tile fallback |
| Transformers.js | Browser-local AI / ML |
| Groq, Finnhub, EIA, OpenSky, ACLED, OpenAQ | Optional free-registration enhancements |

Paid APIs may enhance specific panels, but they are **not the design requirement for the baseline Green House experience**.

---

## Quick Start

```bash
git clone https://github.com/sonoxo/thegreenhouse.git
cd thegreenhouse
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

The inherited WorldMonitor application can run without environment variables for its baseline experience. Feature-specific providers may require optional credentials; see `.env.example`.

### Update later

```bash
cd thegreenhouse
git pull
npm install
npm run dev
```

---

## Architecture

```text
┌──────────────────────────────────────────────────────────┐
│                    THE GREEN HOUSE                       │
│       Free-first global intelligence interface          │
├──────────────────────────────────────────────────────────┤
│  NEWS  │  MAPS  │ WEATHER │ BIO │ PHARMA │ MARKETS     │
├──────────────────────────────────────────────────────────┤
│        WorldMonitor visualization + panel engine         │
├──────────────────────────────────────────────────────────┤
│ Open/public APIs │ free registration │ browser compute   │
├──────────────────────────────────────────────────────────┤
│     provenance · attribution · evidence · licensing      │
└──────────────────────────────────────────────────────────┘
```

### Stack

| Category | Technologies |
|---|---|
| **Frontend** | Vanilla TypeScript, Vite |
| **3D Mapping** | globe.gl, Three.js |
| **2D Mapping** | deck.gl, MapLibre GL |
| **Desktop** | Tauri 2 / Rust |
| **AI / ML** | Transformers.js, optional Groq / OpenRouter / upstream providers |
| **Caching** | Browser/service-worker + upstream cache architecture |
| **Data posture** | Public / open / free-registration first |
| **Source engine** | WorldMonitor |

---

## Green House Intelligence Domains

| Domain | Focus |
|---|---|
| 🌎 **Eco** | climate, weather, disasters, energy, environment, infrastructure |
| 🧬 **Bio** | public-health signals, biological context, population and humanitarian data |
| 💊 **Pharma** | pharmaceutical-market and public-source intelligence context |
| 🏛️ **Regulatory** | FDA / government / public regulatory-source awareness |
| 📡 **Global Intel** | geopolitical, aviation, economic, cyber and event convergence |

The interface is an **intelligence and research surface**, not a substitute for authoritative medical, regulatory, emergency, or governmental determinations.

---

## Upstream WorldMonitor

The visualization engine and substantial portions of the underlying application originate from **WorldMonitor** by Elie Habib and contributors.

- Upstream source: https://github.com/koala73/worldmonitor
- Official upstream web app: https://www.worldmonitor.app
- Upstream documentation: https://www.worldmonitor.app/docs/documentation

The Green House intentionally preserves upstream attribution while applying its own project identity, data posture, ontology, and integration direction.

---

## Development

```bash
npm run typecheck
npm run build:full
```

Useful inherited variant commands may include:

```bash
npm run dev:tech
npm run dev:finance
npm run dev:commodity
npm run dev:happy
npm run dev:energy
```

---

## License & Upstream Attribution

**AGPL-3.0-only** applies to the WorldMonitor-derived source in this repository. Commercial use is permitted when the AGPL's copyleft and source-availability obligations are satisfied.

| Use Case | Status |
|---|---|
| Personal / research / educational | ✅ Allowed under AGPL-3.0-only |
| Self-hosting | ✅ Allowed under AGPL-3.0-only |
| Forking and modification | ✅ Allowed, subject to AGPL obligations |
| Commercial / SaaS deployment | ✅ Allowed when AGPL obligations are followed |
| Official WorldMonitor branding rights | ⚠️ Not granted by the code license |

See [`LICENSE`](LICENSE) for the complete license terms.

**Upstream copyright:** Copyright (C) 2024-2026 Elie Habib. All rights reserved as stated in the upstream project.

The Green House project does not remove or replace upstream copyright, license, attribution, or provenance requirements.

---

## Contributors

### Upstream WorldMonitor contributors

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" alt="WorldMonitor contributors" />
</a>

### The Green House repository

<a href="https://github.com/sonoxo/thegreenhouse/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=sonoxo/thegreenhouse" alt="The Green House contributors" />
</a>

---

<div align="center">

### 🌿 THE GREEN HOUSE

**WorldMonitor engine · Green House identity · free/public-data-first intelligence**

[Repository](https://github.com/sonoxo/thegreenhouse) · [Upstream](https://github.com/koala73/worldmonitor) · [License](LICENSE)

</div>
