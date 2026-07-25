# World Monitor

[English](README.md) | [简体中文](README.zh-CN.md)

**リアルタイム・グローバルインテリジェンスダッシュボード** — AI によるニュース集約、地政学モニタリング、インフラ追跡を統合された状況認識インターフェースで提供します。

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
  <a href="https://www.worldmonitor.app/docs/documentation"><strong>ドキュメント</strong></a> &nbsp;·&nbsp;
  <a href="https://github.com/koala73/worldmonitor/releases/latest"><strong>リリース</strong></a> &nbsp;·&nbsp;
  <a href="https://www.worldmonitor.app/docs/contributing"><strong>コントリビューション</strong></a>
</p>

![World Monitor Dashboard](docs/images/worldmonitor-7-mar-2026.jpg)

---

## 主な機能

- **500 以上の厳選ニュースフィード** — 15 カテゴリにわたり、AI が要約してブリーフを生成
- **デュアルマップエンジン** — 3D グローブ (globe.gl) と WebGL フラットマップ (deck.gl)、56 種類のマップレイヤー
- **クロスストリーム相関分析** — 軍事・経済・災害・エスカレーションのシグナル収束を検出
- **国家不安定指数 (CII)** — Tier-1 の 31 か国を対象に、サーバー側で確定する CII v8 ストレススコアリング
- **金融レーダー** — 29 の証券取引所、コモディティ、暗号資産、7 シグナルのマーケットコンポジット
- **ローカル AI** — Ollama ですべて実行可能、API キー不要
- **単一コードベースから 6 つのサイトバリアント** (world、tech、finance、commodity、happy、energy)
- **ネイティブデスクトップアプリ** (Tauri 2) — macOS、Windows、Linux 対応
- **25 言語対応** — 各言語のネイティブフィードと RTL サポート

機能の全一覧、アーキテクチャ、データソース、アルゴリズムについては **[ドキュメント](https://www.worldmonitor.app/docs/documentation)** を参照してください。

---

## サポート状況

すべてのサイトバリアントとデスクトップバイナリは単一のコードベースからビルドされ、同じリリースプロセスで配布されます。以下の表に、どの提供形態が安心して依存できるかを示すメンテナンス状況をまとめます。

| 提供形態 | ステータス | 備考 |
|---------|--------|-------|
| `worldmonitor.app`、`tech.`、`finance.`、`commodity.`、`happy.`、`energy.` | 安定 | 本リポジトリからビルドされる公開デプロイ。積極的にメンテナンス中 |
| デスクトップバイナリ (Windows / macOS Apple Silicon / macOS Intel / Linux AppImage) | 安定 | アプリ内でバリアントを切り替えられる単一の Tauri バイナリ。現在の CI リリース対象は `full` と `tech` |

上記に対して報告された Issue は同一のバックログでトリアージされます。現在オープン中の作業は [Issue ボード](https://github.com/koala73/worldmonitor/issues) を参照してください。

---

## クイックスタート

```bash
git clone https://github.com/koala73/worldmonitor.git
cd worldmonitor
npm install
npm run dev
```

[localhost:3000](http://localhost:3000) を開きます (ポートは `.env.local` の `DEV_PORT` で変更可能)。このアプリは環境変数なしで動作します。

一部の機能固有のデータソースには認証情報が必要な場合があります。全一覧は `.env.example` を参照してください。

バリアント別の開発:

```bash
npm run dev:tech       # tech.worldmonitor.app
npm run dev:finance    # finance.worldmonitor.app
npm run dev:commodity  # commodity.worldmonitor.app
npm run dev:happy      # happy.worldmonitor.app
npm run dev:energy     # energy.worldmonitor.app
```

デプロイ方法 (Vercel、Docker、静的ホスティング) については **[セルフホスティングガイド](https://www.worldmonitor.app/docs/getting-started)** を参照してください。

---

## 技術スタック

| カテゴリ | 技術 |
|----------|-------------|
| **フロントエンド** | Vanilla TypeScript、Vite、globe.gl + Three.js、deck.gl + MapLibre GL |
| **デスクトップ** | Tauri 2 (Rust) + Node.js サイドカー |
| **AI/ML** | Ollama / Groq / OpenRouter、Transformers.js (ブラウザ側) |
| **API コントラクト** | Protocol Buffers (281 proto、35 サービス)、sebuf HTTP アノテーション |
| **デプロイ** | Vercel Edge Functions (60 以上)、Railway リレー、Tauri、PWA |
| **キャッシュ** | Redis (Upstash)、3 層キャッシュ、CDN、Service Worker |

スタックの詳細は **[アーキテクチャドキュメント](https://www.worldmonitor.app/docs/architecture)** を参照してください。

---

## プログラマティックアクセス

World Monitor はブラウザだけでなく、エージェントやスクリプトからの利用も想定して設計されています:

- **MCP サーバー** — `https://worldmonitor.app/mcp` (Streamable HTTP)。`tools/list` は公開。`tools/call` は `X-WorldMonitor-Key` ヘッダーまたは OAuth で認証します。
- **REST API** — ベース URL は `https://api.worldmonitor.app`。仕様は [OpenAPI spec](https://worldmonitor.app/openapi.yaml) を参照。
- **CLI** — 公式 npm パッケージ [`worldmonitor`](https://www.npmjs.com/package/worldmonitor) (ソースは [`cli/`](cli/)):

  ```sh
  npx worldmonitor tools          # その場で実行 — すべての MCP ツールを一覧表示 (キー不要)
  npm install -g worldmonitor     # または `worldmonitor` (エイリアス `wm`) コマンドをインストール
  worldmonitor risk IR --api-key wm_xxx
  ```

- **SDK** — CLI と同等の機能を持つ、依存関係ゼロの公式クライアントライブラリ: Python [`worldmonitor-sdk`](https://pypi.org/project/worldmonitor-sdk/) (ソースは [`sdk/python/`](sdk/python/))、Ruby [`worldmonitor`](https://rubygems.org/gems/worldmonitor) ([`sdk/ruby/`](sdk/ruby/))、Go [`github.com/koala73/worldmonitor/sdk/go`](https://pkg.go.dev/github.com/koala73/worldmonitor/sdk/go) ([`sdk/go/`](sdk/go/))。ガイド: [worldmonitor.app/docs/sdks](https://www.worldmonitor.app/docs/sdks)。

エージェント向けディスカバリーファイル: [`llms.txt`](https://worldmonitor.app/llms.txt) · [agent-skills マニフェスト](https://worldmonitor.app/.well-known/agent-skills/index.json) · [api-catalog](https://worldmonitor.app/.well-known/api-catalog)。API キーは [worldmonitor.app/pro](https://www.worldmonitor.app/pro) から取得できます。

---

## フライトデータ

フライトデータは、最先端の ADS-B フライトデータソリューションである [Wingbits](https://wingbits.com?utm_source=worldmonitor&utm_medium=referral&utm_campaign=worldmonitor) のご厚意により提供されています。

---

## データソース

WorldMonitor は、地政学、金融、エネルギー、気候、航空、サイバー、軍事、インフラ、ニュースインテリジェンスの各分野にわたる 65 以上の外部プロバイダーと API を集約しています。これらは 500 以上の厳選フィードを通じて提供され、35 のソースグループを対象とする鮮度モニターで追跡されています。プロバイダー、フィードのティア、収集方法の詳細は [データソースカタログ](https://www.worldmonitor.app/docs/data-sources) を参照してください。

---

## コントリビューション

コントリビューションを歓迎します！ガイドラインは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

```bash
npm run typecheck        # 型チェック
npm run build:full       # プロダクションビルド
```

---

## ライセンス

ソースコードは **AGPL-3.0-only** です。AGPL のコピーレフトおよびソース公開の条件を遵守する限り、商用利用も許可されます。

| ユースケース | 可否 |
|----------|----------|
| 個人利用 / 研究 / 教育 | 可 (AGPL-3.0-only のもと) |
| セルフホストインスタンス | 可 (AGPL-3.0-only のもと) |
| フォークおよび改変 | 可 (必要な場合は AGPL-3.0-only でソースを公開) |
| 商用利用 / SaaS | 可 (AGPL の義務を遵守する場合、AGPL-3.0-only のもと) |
| ソース非公開のプロプライエタリ利用、または公式ブランディングの利用 | 別途、商用ライセンスまたは商標の許諾が必要 |

コードライセンスの全文は [LICENSE](LICENSE)、平易な言葉での要約は [docs/license.mdx](docs/license.mdx) を参照してください。AGPL 以外の条件が必要なチーム向けに、商用ライセンスも別途提供しています。

Copyright (C) 2024-2026 Elie Habib. All rights reserved.

---

## 作者

**Elie Habib** — [GitHub](https://github.com/koala73)

## コントリビューター

<a href="https://github.com/koala73/worldmonitor/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=koala73/worldmonitor" />
</a>

## セキュリティに関する謝辞

セキュリティ上の問題を責任ある形で開示してくださった以下の研究者の方々に感謝します:

- **Cody Richard** — IPC コマンドの露出、レンダラーからサイドカーへの信頼境界の分析、fetch パッチによる資格情報インジェクションのアーキテクチャに関する 3 件のセキュリティ指摘を開示 (2026)

責任ある開示のガイドラインについては [セキュリティポリシー](./SECURITY.md) を参照してください。

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
