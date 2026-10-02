# World Monitor

[English](README.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja-JP.md) | [**Русский**](README.ru.md)

**Дашборд глобальной разведки в реальном времени** — AI-агрегация новостей, геополитический мониторинг и отслеживание инфраструктуры в едином интерфейсе ситуационной осведомлённости.

[![GitHub stars](https://img.shields.io/github/stars/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/stargazers)
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
  <a href="https://www.worldmonitor.app/docs/documentation"><strong>Документация</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>Релизы</strong></a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/contributing"><strong>Участие</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## Что делает

- **Курируемые новостные ленты** по глобальным и региональным категориям, AI-синтез в сводки
- **Движок двух карт** — 3D-глобус (globe.gl) и плоская карта WebGL (deck.gl) с общим каталогом слоёв карты
- **Набор панелей** — конкретные реализации панелей для специализированных вариантов
- **Сквозная корреляция потоков** — сходимость военных, экономических, сигналов бедствий и эскалации
- **[Country Instability Index (CII)](https://www.worldmonitor.app/country-instability-index/)** — актуальные оценки CII v8, диапазоны и приблизительное 24-часовое движение для 31 страны Tier-1
- **Финансовый радар** — биржи, сырьё, криптовалюты и рыночный композит
- **Локальный AI** — всё на Ollama, без обязательных API-ключей
- **Варианты сайта** из одной кодовой базы (world, tech, finance, commodity, happy, energy)
- **Нативное десктоп-приложение** (Tauri 2) для macOS, Windows и Linux
- **Многоязычный интерфейс** с лентами на родных языках и поддержкой RTL

Полный список функций, архитектура, источники данных и алгоритмы — в **[документации](https://www.worldmonitor.app/docs/documentation)**.

---

## Статус поддержки

Все варианты сайта и десктоп-сборки собираются из одной кодовой базы и выходят одним процессом релиза. Таблица ниже показывает, на что можно опираться.

| Поверхность | Статус | Примечания |
|---------|--------|-------|
| `worldmonitor.app`, `tech.`, `finance.`, `commodity.`, `happy.`, `energy.` | Стабильно | Публичные деплои из этого репозитория, активно поддерживаются |
| Десктоп-сборки (Windows / macOS Apple Silicon / macOS Intel / Linux AppImage) | Стабильно | **Один бинарник Tauri для всех вариантов** — установите World Monitor и переключайтесь на tech, finance, commodity, energy или happy в приложении. Отдельных загрузок по вариантам намеренно нет |

Обращения по любому из пунктов выше попадают в один бэклог — см. [доску issues](https://github.com/koala73/worldmonitor/issues).

---

## Быстрый старт

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

Откройте [localhost:3000](http://localhost:3000) (порт можно задать через `DEV_PORT` в `.env.local`). Приложение запускается без обязательных переменных окружения.

Для источников данных отдельных функций могут понадобиться учётные данные — полный список в `.env.example`.

Разработка конкретного варианта:

```bash
npm run dev:tech       # tech.worldmonitor.app
npm run dev:finance    # finance.worldmonitor.app
npm run dev:commodity  # commodity.worldmonitor.app
npm run dev:happy      # happy.worldmonitor.app
npm run dev:energy     # energy.worldmonitor.app
```

См. **[руководство по самостоятельному хостингу](https://www.worldmonitor.app/docs/getting-started)** (Vercel, Docker, статическая выкладка).

---

## Технологический стек

| Категория | Технологии |
|----------|-------------|
| **Фронтенд** | Vanilla TypeScript, Vite, globe.gl + Three.js, deck.gl + MapLibre GL |
| **Десктоп** | Tauri 2 (Rust) с Node.js sidecar |
| **AI/ML** | Ollama / Groq / OpenRouter, Transformers.js (browser-side) |
| **API-контракты** | Protocol Buffers и sebuf HTTP-аннотации |
| **Развёртывание** | Vercel Edge Functions, Railway relay, Tauri, PWA |
| **Кэширование** | Redis (Upstash), 3-уровневый кэш, CDN, service worker |

Подробности — в **[документации по архитектуре](https://www.worldmonitor.app/docs/architecture)**.

---

## Программный доступ

World Monitor рассчитан и на агентов/скрипты, и на браузеры:

- **MCP-сервер** — `https://worldmonitor.app/mcp` (Streamable HTTP). Публичный `tools/list`; `tools/call` с `X-WorldMonitor-Key` или OAuth.
  Сервер также публикует Agent Skills через черновик расширения `io.modelcontextprotocol/skills` (`skills/list`, `skills/get` и чтение ресурсов `skill://…`).
- **REST API** — base `https://api.worldmonitor.app`, [OpenAPI spec](https://worldmonitor.app/openapi.yaml).
- **CLI** — официальный npm-пакет [`worldmonitor`](https://www.npmjs.com/package/worldmonitor) (исходники в [`cli/`](cli/)):

  ```sh
  npx worldmonitor tools          # разово — список всех MCP-инструментов (ключ не нужен)
  npm install -g worldmonitor     # или установить команду `worldmonitor` (псевдоним `wm`)
  worldmonitor risk IR --api-key wm_xxx
  ```

- **SDK** — клиенты без зависимостей зеркалят CLI: Python [`worldmonitor-sdk`](https://pypi.org/project/worldmonitor-sdk/) ([`sdk/python/`](sdk/python/)), Ruby [`worldmonitor`](https://rubygems.org/gems/worldmonitor) ([`sdk/ruby/`](sdk/ruby/)), Go [`github.com/koala73/worldmonitor/sdk/go`](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) ([`sdk/go/`](sdk/go/)). Гайд: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks).

Файлы обнаружения для агентов: [`llms.txt`](https://worldmonitor.app/llms.txt) · [манифест agent-skills](https://worldmonitor.app/.well-known/agent-skills/index.json) · [api-catalog](https://worldmonitor.app/.well-known/api-catalog). API-ключ: [worldmonitor.app/pro](https://www.worldmonitor.app/pro).

---

## Данные полётов

Данные полётов любезно предоставлены [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor) — передовое решение ADS-B для данных полётов.

---

## Источники данных

WorldMonitor агрегирует атрибутированные исходные источники по геополитике, финансам, энергетике, климату, авиации, кибербезопасности, военной сфере, инфраструктуре и новостной разведке. Курируемые ленты и группы источников с отслеживанием актуальности — в полном [каталоге источников данных](https://www.worldmonitor.app/docs/data-sources) (провайдер, уровень ленты, лицензионный статус, метод сбора).

---

## Участие

Приветствуем вклад! См. [CONTRIBUTING.md](./CONTRIBUTING.md).

```bash
npm run typecheck        # проверка типов
npm run build:full       # продакшен-сборка
```

---

## Лицензия

**AGPL-3.0-only** для исходного кода. Коммерческое использование разрешено по AGPL при соблюдении копилефта и требования публиковать исходный код.

| Сценарий | Разрешено? |
|----------|----------|
| Личное / исследование / образование | Да, по AGPL-3.0-only |
| Самостоятельно размещённый экземпляр | Да, по AGPL-3.0-only |
| Форк и изменение | Да, делитесь исходниками по AGPL-3.0-only, когда это требуется |
| Коммерческое использование / SaaS | Да, по AGPL-3.0-only при соблюдении обязательств AGPL |
| Проприетарное использование с закрытым исходным кодом или права на официальный брендинг | Нужно отдельное коммерческое разрешение или разрешение на товарный знак |

Полный текст: [LICENSE](LICENSE). Кратко: [docs/license.mdx](docs/license.mdx). Коммерческое лицензирование доступно как альтернатива для условий вне AGPL.

Copyright (C) 2024-2026 Elie Habib. All rights reserved.

---

## Автор

**Elie Habib** — [GitHub](https://github.com/koala73)

## Участники

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

## Благодарности за ответственное раскрытие

Благодарим исследователей за ответственное раскрытие уязвимостей:

- **Cody Richard** — три находки: раскрытие IPC-команд, граница доверия renderer-to-sidecar, архитектура подмены fetch с внедрением учётных данных (2026)

См. [политику безопасности](./SECURITY.md).

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
