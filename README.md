<div align="center">

# 🌿 THE GREEN HOUSE

### Global environmental · biological · pharmaceutical · regulatory intelligence

**A free-first situational-awareness surface for public intelligence, environmental signals, bio/pharma context, regulation, infrastructure, markets, weather, disasters, and cross-stream analysis.**

[![GitHub stars](https://img.shields.io/github/stars/sonoxo/thegreenhouse?style=social)](https://github.com/sonoxo/thegreenhouse/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-2ea043.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Last commit](https://img.shields.io/github/last-commit/sonoxo/thegreenhouse)](https://github.com/sonoxo/thegreenhouse/commits/main)
[![Green House](https://img.shields.io/badge/Identity-THE_GREEN_HOUSE-16a34a?style=flat)](https://github.com/sonoxo/thegreenhouse)
[![Free First](https://img.shields.io/badge/Data-Zero--Cost--First-22c55e?style=flat)](#free--public-data-first)

<p>
  <a href="https://github.com/sonoxo/thegreenhouse"><img src="https://img.shields.io/badge/THE_GREEN_HOUSE-OPEN_REPOSITORY-16a34a?style=for-the-badge&logo=github&logoColor=white" alt="Open The Green House"></a>&nbsp;
  <a href="#quick-start"><img src="https://img.shields.io/badge/LOCAL_LAUNCH-NPM_RUN_DEV-14532d?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Local launch"></a>&nbsp;
  <a href="NOTICE.md"><img src="https://img.shields.io/badge/LEGAL-SOURCE_NOTICE-334155?style=for-the-badge&logo=readthedocs&logoColor=white" alt="Source notice"></a>
</p>

<p>
  <a href="#what-it-does"><strong>Capabilities</strong></a> &nbsp;·&nbsp;
  <a href="#quick-start"><strong>Quick Start</strong></a> &nbsp;·&nbsp;
  <a href="#free--public-data-first"><strong>Free Data</strong></a> &nbsp;·&nbsp;
  <a href="#architecture"><strong>Architecture</strong></a> &nbsp;·&nbsp;
  <a href="#license"><strong>License</strong></a>
</p>

</div>

![The Green House intelligence dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## What It Does

THE GREEN HOUSE is a **free-first public intelligence surface** built for environmental, biological, pharmaceutical, regulatory, infrastructure, and global-event awareness.

- **Curated global news feeds** with regional and topical intelligence streams
- **Dual map engine** — 3D globe plus high-performance WebGL flat mapping
- **Environmental intelligence** — weather, climate, earthquakes, disasters, energy and infrastructure signals
- **Bio / public-health context** — public datasets and evidence-oriented monitoring surfaces where available
- **Pharma / regulatory context** — structured public-source monitoring for regulatory and market awareness
- **Cross-stream correlation** across geopolitical, economic, infrastructure and disaster signals
- **Finance radar** — exchanges, commodities, crypto and market context
- **Browser-side AI capability** through Transformers.js where appropriate
- **Optional AI providers** such as Groq / OpenRouter without making paid services the baseline requirement
- **Desktop-capable architecture** through Tauri 2
- **Multilingual interface** inherited from the underlying open-source engine

> **Project identity:** THE GREEN HOUSE is an independent derivative/integration with its own branding, ontology, data posture, and implementation direction. It is not the official upstream project. Required upstream legal notices remain preserved in [`NOTICE.md`](NOTICE.md), [`LICENSE`](LICENSE), and the repository source history.

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

The application can run without environment variables for its baseline experience. Feature-specific providers may require optional credentials; see `.env.example`.

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
│      visualization · panel · correlation engine         │
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
| **AI / ML** | Transformers.js, optional Groq / OpenRouter / compatible providers |
| **Caching** | Browser/service-worker + multi-tier cache architecture |
| **Data posture** | Public / open / free-registration first |
| **Project identity** | THE GREEN HOUSE |

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

## License

**AGPL-3.0-only** applies to covered source in this repository. Commercial use is permitted when the AGPL's copyleft and source-availability obligations are satisfied.

| Use Case | Status |
|---|---|
| Personal / research / educational | ✅ Allowed under AGPL-3.0-only |
| Self-hosting | ✅ Allowed under AGPL-3.0-only |
| Forking and modification | ✅ Allowed, subject to AGPL obligations |
| Commercial / SaaS deployment | ✅ Allowed when AGPL obligations are followed |
| Upstream trademark / official-brand rights | ⚠️ Not granted by the code license |

See [`LICENSE`](LICENSE) for the complete license text and [`NOTICE.md`](NOTICE.md) for preserved upstream copyright, attribution, provenance, and source information.

<details>
<summary><strong>Upstream source & attribution</strong></summary>

This repository contains an independently branded derivative of an AGPL-licensed open-source intelligence project. The upstream project, source link, copyright notice, and attribution are preserved in [`NOTICE.md`](NOTICE.md). This project does not claim official upstream affiliation or trademark rights.

</details>

---

## THE GREEN HOUSE Contributors

<a href="https://github.com/sonoxo/thegreenhouse/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=sonoxo/thegreenhouse" alt="The Green House contributors" />
</a>

---

<div align="center">

### 🌿 THE GREEN HOUSE

**Eco · Bio · Pharma · Regulatory · Global Intelligence**

**Free-first data · browser intelligence · geospatial awareness · public-source correlation**

[Repository](https://github.com/sonoxo/thegreenhouse) · [Source Notice](NOTICE.md) · [License](LICENSE)

</div>
