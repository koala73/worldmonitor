# World Monitor (全球监测)

**实时全球情报仪表盘** —— 集 AI 驱动的新闻聚合、地缘政治监测和基础设施跟踪于一体的统一态势感知界面。

[![GitHub stars](https://img.shields.io/github/stars/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/koala73/worldmonitor?style=social)](https://github.com/koala73/worldmonitor/network/members)
[![Discord](https://img.shields.io/badge/Discord-加入-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/re63kWKxaz)
[![许可证: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![最后提交](https://img.shields.io/github/last-commit/koala73/worldmonitor)](https://github.com/koala73/worldmonitor/commits/main)
[![最新版本](https://img.shields.io/github/v/release/koala73/worldmonitor?style=flat)](https://github.com/koala73/worldmonitor/releases/latest)

<p align="center">
  <a href="https://worldmonitor.app"><img src="https://img.shields.io/badge/网页端-worldmonitor.app-blue?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Web App"></a>&nbsp;
  <a href="https://tech.worldmonitor.app"><img src="https://img.shields.io/badge/科技版-tech.worldmonitor.app-0891b2?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Tech Variant"></a>&nbsp;
  <a href="https://finance.worldmonitor.app"><img src="https://img.shields.io/badge/金融版-finance.worldmonitor.app-059669?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Finance Variant"></a>&nbsp;
  <a href="https://commodity.worldmonitor.app"><img src="https://img.shields.io/badge/大宗商品版-commodity.worldmonitor.app-b45309?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Commodity Variant"></a>&nbsp;
  <a href="https://happy.worldmonitor.app"><img src="https://img.shields.io/badge/治愈版-happy.worldmonitor.app-f59e0b?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Happy Variant"></a>
</p>

<p align="center">
  <a href="https://worldmonitor.app/api/download?platform=windows-exe"><img src="https://img.shields.io/badge/下载-Windows_(.exe)-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Download Windows"></a>&nbsp;
  <a href="https://worldmonitor.app/api/download?platform=macos-arm64"><img src="https://img.shields.io/badge/下载-macOS_Apple_Silicon-000000?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS ARM"></a>&nbsp;
  <a href="https://worldmonitor.app/api/download?platform=macos-x64"><img src="https://img.shields.io/badge/下载-macOS_Intel-555555?style=for-the-badge&logo=apple&logoColor=white" alt="Download macOS Intel"></a>&nbsp;
  <a href="https://worldmonitor.app/api/download?platform=linux-appimage"><img src="https://img.shields.io/badge/下载-Linux_(.AppImage)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Download Linux"></a>
</p>

<p align="center">
  <a href="https://docs.worldmonitor.app"><strong>文档</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>发布版本</strong></a> &nbsp;·&nbsp;
  <a href="https://docs.worldmonitor.app/contributing"><strong>参与贡献</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## 核心功能

- **435+ 深度筛选的新闻源**：涵盖 15 个类别，通过 AI 综合生成每日简报。
- **双地图引擎**：3D 地球仪 (globe.gl) 和 WebGL 平面地图 (deck.gl)，包含 45 个数据图层。
- **跨流关联分析**：军事、经济、灾害和局势升级信号的深度聚合。
- **国家情报指数**：涵盖 12 个信号类别的综合风险评分。
- **金融雷达**：覆盖 92 个证券交易所、大宗商品、加密货币及 7 信号市场综合指数。
- **本地 AI 支持**：支持通过 Ollama 本地运行，无需 API 密钥。
- **5 种站点变体**：同一套代码库支持全球、科技、金融、大宗商品和“治愈”版本。
- **原生桌面应用**：基于 Tauri 2 开发，支持 macOS, Windows 和 Linux。
- **21 种语言支持**：支持母语新闻源及 RTL 布局。

有关完整的功能列表、架构、数据源和算法，请参阅 **[官方文档](https://docs.worldmonitor.app)**。

---

## 快速开始

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

打开 [localhost:5173](http://localhost:5173)。基础运行无需设置环境变量。

针对不同变体的开发：

```bash
npm run dev:tech       # 科技版
npm run dev:finance    # 金融版
npm run dev:commodity  # 大宗商品版
npm run dev:happy      # 治愈版
```

请参阅 **[自托管指南](https://docs.worldmonitor.app/getting-started)** 了解部署选项（Vercel, Docker, 静态部署）。

---

## 技术栈

| 类别 | 采用技术 |
|----------|-------------|
| **前端** | 原生 TypeScript, Vite, globe.gl + Three.js, deck.gl + MapLibre GL |
| **桌面端** | Tauri 2 (Rust) 配合 Node.js sidecar |
| **AI/ML** | Ollama / Groq / OpenRouter, Transformers.js (浏览器端推理) |
| **API 协议** | Protocol Buffers (92 个 proto, 22 个服务), sebuf HTTP 注解 |
| **部署** | Vercel Edge Functions (60+), Railway 中继, Tauri, PWA |
| **缓存** | Redis (Upstash), 三级缓存, CDN, Service Worker |

详见 **[架构文档](https://docs.worldmonitor.app/architecture)**。

---

## 参与贡献

欢迎参与贡献！请参阅 [CONTRIBUTING.md](./CONTRIBUTING.md) 了解准则。

```bash
npm run typecheck        # 类型检查
npm run build:full       # 生产环境构建
```

---

## 许可证

非商业用途遵循 **AGPL-3.0**。任何商业用途均需获得**商业授权**。

| 使用场景 | 是否允许？ |
|----------|----------|
| 个人 / 研究 / 教育 | 允许 |
| 自托管 (非商业) | 允许，需署名 |
| Fork 并修改 (非商业) | 允许，需在 AGPL-3.0 下开源 |
| 商业用途 / SaaS / 品牌重塑 | 需获得商业许可证 |

详见 [LICENSE](LICENSE) 完整条款。如需商业授权，请联系作者。

Copyright (C) 2024-2026 Elie Habib. All rights reserved.

---

## 作者

**Elie Habib** — [GitHub](https://github.com/koala73)

## 贡献者

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

## 安全致谢

感谢以下研究人员负责任地披露安全问题：

- **Cody Richard** — 披露了涵盖 IPC 命令暴露、渲染器到 sidecar 信任边界分析以及 fetch 补丁凭据注入架构的三项安全发现 (2026)。

请参阅我们的 [安全政策](./SECURITY.md) 了解负责任的披露指南。

---

<p align="center">
  <a href="https://worldmonitor.app">worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://docs.worldmonitor.app">docs.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://finance.worldmonitor.app">finance.worldmonitor.app</a> &nbsp;·&nbsp;
  <a href="https://commodity.worldmonitor.app">commodity.worldmonitor.app</a>
</p>

## Star History

<a href="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&type=Date&theme=dark" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=koala73/worldmonitor&type=Date&type=Date" />
 </picture>
</a>
