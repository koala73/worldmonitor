# World Monitor

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md) | [Русский](README.ru.md)

**Дашборд глобальной разведки в реальном времени** — AI-агрегация новостей, геополитический мониторинг и отслеживание инфраструктуры в едином situational awareness интерфейсе.

[![GitHub stars](https://img.shields.io/github/stars/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/stargazers)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/re63kWKxaz)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Last commit](https://img.shields.io/github/last-commit/koala73/worldmonitor)](https://github.com/koala73/worldmonitor/commits/main)
[![Latest release](https://img.shields.io/github/v/release/koala73/worldmonitor?style=flat)](https://github.com/koala73/worldmonitor/releases/latest)
[![npm: worldmonitor](https://img.shields.io/npm/v/worldmonitor?logo=npm&label=npm)](https://www.npmjs.com/package/worldmonitor)
[![smithery badge](https://smithery.ai/badge/worldmonitor/wm-mcp)](https://smithery.ai/servers/worldmonitor/wm-mcp)
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
  <a href="https://www.worldmonitor.app/docs/documentation"><strong>Документация</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>Releases</strong></a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/contributing"><strong>Contributing</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## Что делает

- **500+ curated news feeds** по 15 категориям, AI-синтез в брифы
- **Dual map engine** — 3D globe (globe.gl) и WebGL flat map (deck.gl), 56 типов слоёв
- **Cross-stream correlation** — военные, экономические, disaster и escalation сигналы
- **Country Instability Index (CII)** — server-authoritative CII v8 для 31 Tier-1 стран
- **Finance radar** — 29 бирж, commodities, crypto, 7-signal market composite
- **Local AI** — всё через Ollama, без обязательных API keys
- **6 site variants** из одной кодовой базы (world, tech, finance, commodity, happy, energy)
- **Native desktop** (Tauri 2) для macOS, Windows, Linux
- **25 languages** с native-language feeds и RTL

Полный список фич, архитектура, data sources и алгоритмы — в **[документации](https://www.worldmonitor.app/docs/documentation)**.

---

## Статус поддержки

Все site variants и desktop binaries собираются из одной кодовой базы и одного release process.

| Surface | Status | Notes |
|---------|--------|-------|
| `worldmonitor.app`, `tech.`, `finance.`, `commodity.`, `happy.`, `energy.` | Stable | Публичные деплои из этого репо, активно поддерживаются |
| Desktop binaries (Windows / macOS Apple Silicon / macOS Intel / Linux AppImage) | Stable | Один Tauri binary, variants переключаются in-app; CI targets: `full` и `tech` |

Issues по любой surface — в общем backlog: [issues](https://github.com/koala73/worldmonitor/issues).

---

## Быстрый старт

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

Откройте [localhost:3000](http://localhost:3000) (порт: `DEV_PORT` в `.env.local`). Приложение работает **без** env vars.

Для отдельных data sources могут понадобиться credentials — см. `.env.example`.

Варианты dev:

```bash
npm run dev:tech       # tech.worldmonitor.app
npm run dev:finance    # finance.worldmonitor.app
npm run dev:commodity  # commodity.worldmonitor.app
npm run dev:happy      # happy.worldmonitor.app
npm run dev:energy     # energy.worldmonitor.app
```

Деплой (Vercel, Docker, static): **[self-hosting guide](https://www.worldmonitor.app/docs/getting-started)**.

---

## Стек

| Category | Technologies |
|----------|-------------|
| **Frontend** | Vanilla TypeScript, Vite, globe.gl + Three.js, deck.gl + MapLibre GL |
| **Desktop** | Tauri 2 (Rust) + Node.js sidecar |
| **AI/ML** | Ollama / Groq / OpenRouter, Transformers.js (browser-side) |
| **API Contracts** | Protocol Buffers (290 protos, 35 services), sebuf HTTP annotations |
| **Deployment** | Vercel Edge Functions (60+), Railway relay, Tauri, PWA |
| **Caching** | Redis (Upstash), 3-tier cache, CDN, service worker |

Подробности: **[architecture docs](https://www.worldmonitor.app/docs/architecture)**.

---

## Программный доступ

World Monitor рассчитан на агентов и скрипты, не только на браузер:

- **MCP server** — `https://worldmonitor.app/mcp` (Streamable HTTP). Публичный `tools/list`; `tools/call` — через `X-WorldMonitor-Key` или OAuth.
- **REST API** — `https://api.worldmonitor.app`, [OpenAPI](https://worldmonitor.app/openapi.yaml).
- **CLI** — npm-пакет [`worldmonitor`](https://www.npmjs.com/package/worldmonitor) (исходники в [`cli/`](cli/)):

  ```sh
  npx worldmonitor tools          # list every MCP tool (no key needed)
  npm install -g worldmonitor     # install `worldmonitor` (alias `wm`)
  worldmonitor risk IR --api-key wm_xxx
  ```

- **SDKs** — zero-dependency клиенты: Python [`worldmonitor-sdk`](https://pypi.org/project/worldmonitor-sdk/) ([`sdk/python/`](sdk/python/)), Ruby [`worldmonitor`](https://rubygems.org/gems/worldmonitor) ([`sdk/ruby/`](sdk/ruby/)), Go [`github.com/koala73/worldmonitor/sdk/go`](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) ([`sdk/go/`](sdk/go/)). Гайд: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks).

Agent discovery: [`llms.txt`](https://worldmonitor.app/llms.txt) · [agent-skills](https://worldmonitor.app/.well-known/agent-skills/index.json) · [api-catalog](https://worldmonitor.app/.well-known/api-catalog). API key: [worldmonitor.app/pro](https://www.worldmonitor.app/pro).

---

## Flight Data

Данные полётов предоставлены [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor) — ADS-B flight data solution.

---

## Data Sources

65+ внешних провайдеров: geopolitics, finance, energy, climate, aviation, cyber, military, infrastructure, news — через 500+ feeds и freshness monitor (35 source groups). Каталог: [data sources](https://www.worldmonitor.app/docs/data-sources).

---

## Contributing

Вклад приветствуется! См. [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
npm run typecheck        # Type checking
npm run build:full       # Production build
```

---

## Лицензия

**AGPL-3.0-only** для исходников. Commercial use разрешён при соблюдении AGPL (copyleft + source availability).

| Use Case | Allowed? |
|----------|----------|
| Personal / research / educational | Yes, under AGPL-3.0-only |
| Self-hosted instance | Yes, under AGPL-3.0-only |
| Fork and modify | Yes, share source under AGPL-3.0-only when required |
| Commercial use / SaaS | Yes, under AGPL-3.0-only when you comply with AGPL obligations |
| Private-source proprietary use or official branding rights | Separate commercial or trademark permission needed |

Полный текст: [LICENSE](LICENSE). Кратко: [docs/license.mdx](docs/license.mdx). Commercial licensing — для non-AGPL terms.

Copyright (C) 2024-2026 Elie Habib. All rights reserved.

---

## Author

**Elie Habib** — [GitHub](https://github.com/koala73)

## Contributors

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

## Security Acknowledgments

Благодарим исследователей за responsible disclosure:

- **Cody Richard** — три находки: IPC command exposure, renderer-to-sidecar trust boundary, fetch patch credential injection architecture (2026)

[Security Policy](./SECURITY.md) — guidelines for responsible disclosure.

---

<p align="center">
  <a href="https://www.worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/documentation">docs.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://commodity.worldmonitor.app">commodity.worldmonitor.app</a>
</p>

## Star History

<a href="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date" />
 </picture>
</a>
