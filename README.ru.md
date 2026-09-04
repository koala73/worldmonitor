# World Monitor

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md) | [**Русский**](README.ru.md)

**Дашборд глобальной разведки в реальном времени** — AI-агрегация новостей, геополитический мониторинг и отслеживание инфраструктуры в едином интерфейсе ситуационной осведомлённости.

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
  <a href="https://www.worldmonitor.app/docs/documentation"><strong>Documentation</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>Releases</strong></a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/contributing"><strong>Contributing</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## Что делает

- **Курируемые новостные ленты** по глобальным и региональным категориям, AI-синтез в briefs
- **Dual map engine** — 3D globe (globe.gl) и WebGL flat map (deck.gl) с общим каталогом map-layer
- **Panel inventory** — конкретные реализации панелей для специализированных variants
- **Cross-stream correlation** — сходимость военных, экономических, disaster и escalation сигналов
- **Country Instability Index (CII)** — server-authoritative CII v8 stress scoring для Tier-1 registry
- **Finance radar** — биржи, commodities, crypto и market composite
- **Local AI** — всё на Ollama, без обязательных API keys
- **Site variants** из одной codebase (world, tech, finance, commodity, happy, energy)
- **Native desktop app** (Tauri 2) для macOS, Windows и Linux
- **Multilingual UI** с native-language feeds и RTL support

Полный список фич, архитектура, data sources и алгоритмы — в **[документации](https://www.worldmonitor.app/docs/documentation)**.

---

## Статус поддержки

Все site variants и desktop binaries собираются из одной codebase и выходят одним release process. Таблица ниже показывает, на что можно опираться.

| Surface | Status | Notes |
|---------|--------|-------|
| `worldmonitor.app`, `tech.`, `finance.`, `commodity.`, `happy.`, `energy.` | Stable | Публичные деплои из этого репо, активно поддерживаются |
| Desktop binaries (Windows / macOS Apple Silicon / macOS Intel / Linux AppImage) | Stable | **Один Tauri binary для всех variants** — установите World Monitor и переключайтесь на tech, finance, commodity, energy или happy в приложении. Отдельных per-variant download намеренно нет |

Issues по любому из пунктов выше идут в один backlog — см. [issues board](https://github.com/koala73/worldmonitor/issues).

---

## Быстрый старт

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

Откройте [localhost:3000](http://localhost:3000) (порт можно задать через `DEV_PORT` в `.env.local`). Приложение запускается без обязательных environment variables.

Для feature-specific data sources могут понадобиться credentials — полный список в `.env.example`.

Variant-specific development:

```bash
npm run dev:tech       # tech.worldmonitor.app
npm run dev:finance    # finance.worldmonitor.app
npm run dev:commodity  # commodity.worldmonitor.app
npm run dev:happy      # happy.worldmonitor.app
npm run dev:energy     # energy.worldmonitor.app
```

См. **[self-hosting guide](https://www.worldmonitor.app/docs/getting-started)** (Vercel, Docker, static).

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

Подробности — в **[architecture docs](https://www.worldmonitor.app/docs/architecture)**.

---

## Programmatic Access

World Monitor рассчитан и на агентов/скрипты, и на браузеры:

- **MCP server** — `https://worldmonitor.app/mcp` (Streamable HTTP). Public `tools/list`; `tools/call` с `X-WorldMonitor-Key` или OAuth.
- **REST API** — base `https://api.worldmonitor.app`, [OpenAPI spec](https://worldmonitor.app/openapi.yaml).
- **CLI** — официальный npm-пакет [`worldmonitor`](https://www.npmjs.com/package/worldmonitor) (исходники в [`cli/`](cli/)):

  ```sh
  npx worldmonitor tools          # run ad-hoc — list every MCP tool (no key needed)
  npm install -g worldmonitor     # or install the `worldmonitor` (alias `wm`) command
  worldmonitor risk IR --api-key wm_xxx
  ```

- **SDKs** — zero-dependency клиенты зеркалят CLI: Python [`worldmonitor-sdk`](https://pypi.org/project/worldmonitor-sdk/) ([`sdk/python/`](sdk/python/)), Ruby [`worldmonitor`](https://rubygems.org/gems/worldmonitor) ([`sdk/ruby/`](sdk/ruby/)), Go [`github.com/koala73/worldmonitor/sdk/go`](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) ([`sdk/go/`](sdk/go/)). Гайд: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks).

Agent discovery: [`llms.txt`](https://worldmonitor.app/llms.txt) · [agent-skills manifest](https://worldmonitor.app/.well-known/agent-skills/index.json) · [api-catalog](https://worldmonitor.app/.well-known/api-catalog). API key: [worldmonitor.app/pro](https://www.worldmonitor.app/pro).

---

## Flight Data

Данные полётов любезно предоставлены [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor) — advanced ADS-B flight data solution.

---

## Data Sources

WorldMonitor агрегирует attributed upstream sources по geopolitics, finance, energy, climate, aviation, cyber, military, infrastructure и news intelligence. Курируемые feeds и freshness-tracked source groups — в полном [каталоге data sources](https://www.worldmonitor.app/docs/data-sources) (provider, feed-tier, license-posture, collection-method).

---

## Contributing

Contributions welcome! См. [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
npm run typecheck        # Type checking
npm run build:full       # Production build
```

---

## License

**AGPL-3.0-only** для исходного кода. Commercial use разрешён под AGPL при соблюдении copyleft и source-availability.

| Use Case | Allowed? |
|----------|----------|
| Personal / research / educational | Yes, under AGPL-3.0-only |
| Self-hosted instance | Yes, under AGPL-3.0-only |
| Fork and modify | Yes, share source under AGPL-3.0-only when required |
| Commercial use / SaaS | Yes, under AGPL-3.0-only when you comply with AGPL obligations |
| Private-source proprietary use or official branding rights | Separate commercial or trademark permission needed |

Полный текст: [LICENSE](LICENSE). Кратко: [docs/license.mdx](docs/license.mdx). Commercial licensing доступен как альтернатива для non-AGPL terms.

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

См. [Security Policy](./SECURITY.md).

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
