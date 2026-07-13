# World Monitor

[English](README.md)

**实时全球情报仪表盘** — 在统一的态势感知界面中，汇集 AI 驱动的新闻聚合、地缘政治监测和基础设施追踪。

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
  <a href="https://www.worldmonitor.app"><img src="https://img.shields.io/badge/Web_App-worldmonitor.app-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Web 应用"></a>&nbsp;
  <a href="https://tech.worldmonitor.app"><img src="https://img.shields.io/badge/Tech_Variant-tech.worldmonitor.app-0891b2?style=for-the-badge&logo=googlechrome&logoColor=white" alt="科技变体"></a>&nbsp;
  <a href="https://finance.worldmonitor.app"><img src="https://img.shields.io/badge/Finance_Variant-finance.worldmonitor.app-059669?style=for-the-badge&logo=googlechrome&logoColor=white" alt="金融变体"></a>&nbsp;
  <a href="https://commodity.worldmonitor.app"><img src="https://img.shields.io/badge/Commodity_Variant-commodity.worldmonitor.app-b45309?style=for-the-badge&logo=googlechrome&logoColor=white" alt="大宗商品变体"></a>&nbsp;
  <a href="https://happy.worldmonitor.app"><img src="https://img.shields.io/badge/Happy_Variant-happy.worldmonitor.app-f59e0b?style=for-the-badge&logo=googlechrome&logoColor=white" alt="正能量变体"></a>&nbsp;
  <a href="https://energy.worldmonitor.app"><img src="https://img.shields.io/badge/Energy_Variant-energy.worldmonitor.app-eab308?style=for-the-badge&logo=googlechrome&logoColor=white" alt="能源变体"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/worldmonitor"><img src="https://img.shields.io/npm/v/worldmonitor?style=for-the-badge&logo=npm&logoColor=white&label=npm%20i%20worldmonitor&color=CB3837" alt="npm i worldmonitor"></a>&nbsp;
  <a href="https://www.npmjs.com/package/worldmonitor"><img src="https://img.shields.io/badge/CLI-npx%20worldmonitor-CB3837?style=for-the-badge&logo=npm&logoColor=white" alt="npx worldmonitor"></a>&nbsp;
  <a href="https://pypi.org/project/worldmonitor-sdk/"><img src="https://img.shields.io/pypi/v/worldmonitor-sdk?style=for-the-badge&logo=pypi&logoColor=white&label=pip%20install%20worldmonitor-sdk&color=3775A9" alt="pip install worldmonitor-sdk"></a>&nbsp;
  <a href="https://rubygems.org/gems/worldmonitor"><img src="https://img.shields.io/gem/v/worldmonitor?style=for-the-badge&logo=rubygems&logoColor=white&label=gem%20install%20worldmonitor&color=E9573F" alt="gem install worldmonitor"></a>&nbsp;
  <a href="https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go"><img src="https://img.shields.io/badge/go%20get-sdk%2Fgo-00ADD8?style=for-the-badge&logo=go&logoColor=white" alt="go get github.com/koala73/worldmonitor/sdk/go"></a>
</p>

<p align="center">
  <a href="https://www.worldmonitor.app/api/download?platform=windows-exe"><img src="https://img.shields.io/badge/Download-Windows_(.exe)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="下载 Windows"></a>&nbsp;
  <a href="https://www.worldmonitor.app/api/download?platform=macos-arm64"><img src="https://img.shields.io/badge/Download-macOS_Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="下载 macOS Apple Silicon"></a>&nbsp;
  <a href="https://www.worldmonitor.app/api/download?platform=macos-x64"><img src="https://img.shields.io/badge/Download-macOS_Intel-555555?style=for-the-badge&logo=apple&logoColor=white" alt="下载 macOS Intel"></a>&nbsp;
  <a href="https://www.worldmonitor.app/api/download?platform=linux-appimage"><img src="https://img.shields.io/badge/Download-Linux_(.AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="下载 Linux"></a>
</p>

<p align="center">
  <a href="https://www.worldmonitor.app/docs/zh/documentation"><strong>文档</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>发布版本</strong></a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/zh/contributing"><strong>贡献指南</strong></a>
</p>

![World Monitor 仪表盘](docs/images/worldmonitor-7-mar-2026.jpg)

---

## 功能概览

- **500+ 精选新闻源**，覆盖 15 个类别，并由 AI 综合生成简报
- **双地图引擎** — 3D 地球仪（globe.gl）和 WebGL 平面地图（deck.gl），提供 56 种地图图层
- **跨信息流关联** — 汇聚军事、经济、灾害和升级信号
- **国家不稳定指数（CII）** — 面向 31 个一级国家的服务器权威 CII v8 压力评分
- **金融雷达** — 29 家证券交易所、大宗商品、加密货币，以及 7 信号市场综合指标
- **本地 AI** — 通过 Ollama 运行全部功能，无需 API 密钥
- **6 个站点变体**，均来自同一代码库（World Monitor、Tech Monitor、Finance Monitor、Commodity Monitor、Happy Monitor、Energy Monitor）
- **原生桌面应用**（Tauri 2），支持 macOS、Windows 和 Linux
- **25 种语言**，提供本地语言信息流和 RTL 支持

完整的功能清单、架构、数据源和算法，请参阅**[文档](https://www.worldmonitor.app/docs/zh/documentation)**。

---

## 支持状态

所有站点变体和桌面二进制文件均从同一代码库构建，并通过同一发布流程交付。下表说明维护状态，帮助你判断哪些产品形态可放心依赖。

| 产品形态 | 状态 | 说明 |
|---------|--------|-------|
| `worldmonitor.app`、`tech.`、`finance.`、`commodity.`、`happy.`、`energy.` | 稳定 | 从本仓库构建的公开部署，持续维护中 |
| 桌面二进制文件（Windows / macOS Apple Silicon / macOS Intel / Linux AppImage） | 稳定 | 一个可在应用内切换变体的 Tauri 二进制文件；当前 CI 发布目标为 `full` 和 `tech` |

上述任一产品形态的问题都会进入同一待办队列；请查看[问题看板](https://github.com/koala73/worldmonitor/issues)了解当前公开工作。

---

## 快速开始

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

打开 [localhost:3000](http://localhost:3000)（可在 `.env.local` 中通过 `DEV_PORT` 覆盖端口）。应用无需环境变量即可运行。

特定功能的数据源可能需要凭据。完整列表请参阅 `.env.example`。

针对特定变体进行开发：

```bash
npm run dev:tech       # tech.worldmonitor.app
npm run dev:finance    # finance.worldmonitor.app
npm run dev:commodity  # commodity.worldmonitor.app
npm run dev:happy      # happy.worldmonitor.app
npm run dev:energy     # energy.worldmonitor.app
```

部署选项（Vercel、Docker、静态托管）请参阅**[自托管指南](https://www.worldmonitor.app/docs/zh/getting-started)**。

---

## 技术栈

| 类别 | 技术 |
|----------|-------------|
| **前端** | Vanilla TypeScript、Vite、globe.gl + Three.js、deck.gl + MapLibre GL |
| **桌面** | Tauri 2（Rust）与 Node.js sidecar |
| **AI/ML** | Ollama / Groq / OpenRouter、Transformers.js（浏览器端） |
| **API 契约** | Protocol Buffers（279 个 proto、35 项服务）、sebuf HTTP 注解 |
| **部署** | Vercel Edge Functions（60+）、Railway 中继、Tauri、PWA |
| **缓存** | Redis（Upstash）、3 层缓存、CDN、service worker |

完整技术栈详情请参阅**[架构文档](https://www.worldmonitor.app/docs/zh/architecture)**。

---

## 编程访问

World Monitor 同时为智能体、脚本和浏览器而构建：

- **MCP Server** — `https://worldmonitor.app/mcp`（Streamable HTTP）。公开提供 `tools/list`；`tools/call` 通过 `X-WorldMonitor-Key` 请求头或 OAuth 进行身份验证。
- **REST API** — 基础地址为 `https://api.worldmonitor.app`，详见 [OpenAPI 规范](https://worldmonitor.app/openapi.yaml)。
- **CLI** — 官方 [`worldmonitor`](https://www.npmjs.com/package/worldmonitor) npm 包（源代码位于 [`cli/`](cli/)）：

  ```sh
  npx worldmonitor tools          # run ad-hoc — list every MCP tool (no key needed)
  npm install -g worldmonitor     # or install the `worldmonitor` (alias `wm`) command
  worldmonitor risk IR --api-key wm_xxx
  ```

- **SDK** — 与 CLI 对应的官方零依赖客户端库：Python [`worldmonitor-sdk`](https://pypi.org/project/worldmonitor-sdk/)（源代码位于 [`sdk/python/`](sdk/python/)）、Ruby [`worldmonitor`](https://rubygems.org/gems/worldmonitor)（[`sdk/ruby/`](sdk/ruby/)）、Go [`github.com/koala73/worldmonitor/sdk/go`](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go)（[`sdk/go/`](sdk/go/)）。指南：[worldmonitor.app/docs/zh/sdks](https://www.worldmonitor.app/docs/zh/sdks)。

智能体发现文件：[`llms.txt`](https://worldmonitor.app/llms.txt) · [智能体技能清单](https://worldmonitor.app/.well-known/agent-skills/index.json) · [API 目录](https://worldmonitor.app/.well-known/api-catalog)。请在 [worldmonitor.app/pro](https://www.worldmonitor.app/pro) 获取 API 密钥。

---

## 航班数据

航班数据由 [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor) 慷慨提供；Wingbits 是先进的 ADS-B 航班数据解决方案。

---

## 数据源

WorldMonitor 汇聚来自地缘政治、金融、能源、气候、航空、网络、军事、基础设施和新闻情报领域的 65+ 个外部提供商与 API；其内容通过 500+ 个精选信息流呈现，并由覆盖 35 个来源组的新鲜度监控器追踪。有关提供商、信息流层级和采集方法，请参阅完整的[数据源目录](https://www.worldmonitor.app/docs/zh/data-sources)。

---

## 贡献

欢迎贡献！请参阅[贡献指南](https://www.worldmonitor.app/docs/zh/contributing)。

```bash
npm run typecheck        # Type checking
npm run build:full       # Production build
```

---

## 许可证

源代码采用 **AGPL-3.0-only** 许可。在遵守 AGPL copyleft 和源代码可用条款的前提下，允许商业使用。

| 使用场景 | 是否允许？ |
|----------|----------|
| 个人 / 研究 / 教育 | 是，采用 AGPL-3.0-only |
| 自托管实例 | 是，采用 AGPL-3.0-only |
| Fork 并修改 | 是，需要时须以 AGPL-3.0-only 共享源代码 |
| 商业使用 / SaaS | 是，在遵守 AGPL 义务的前提下采用 AGPL-3.0-only |
| 私有源代码的专有使用或官方品牌权利 | 需要单独的商业许可或商标许可 |

完整的代码许可证请参阅 [LICENSE](LICENSE)，通俗语言摘要请参阅 [docs/zh/license.mdx](docs/zh/license.mdx)。对于需要非 AGPL 条款的团队，可选择商业许可。

版权所有 (C) 2024-2026 Elie Habib。保留所有权利。

---

## 作者

**Elie Habib** — [GitHub](https://github.com/koala73)

## 贡献者

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

## 安全致谢

我们感谢以下研究人员负责任地披露安全问题：

- **Cody Richard** — 披露了三项安全发现，涵盖 IPC 命令暴露、渲染器到 sidecar 的信任边界分析，以及 fetch 补丁凭据注入架构（2026）

有关负责任披露指南，请参阅我们的[安全政策](./SECURITY.md)。

---

<p align="center">
  <a href="https://www.worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/zh/documentation">docs.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://commodity.worldmonitor.app">commodity.worldmonitor.app</a>
</p>

## 星标历史

<a href="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&theme=dark" />
   <img alt="星标历史图表" src="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date" />
 </picture>
</a>
