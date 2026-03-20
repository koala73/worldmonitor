# VPS Refactoring Plan — Hetzner CAX21 (24/7 運用)

**対象環境:** Hetzner CAX21 · Debian · 8GB RAM · ARM64 (Ampere Altra)
**目標:** 24時間365日の安定稼働 + Gemini による Discord 定期通知

---

## 0. 前提確認 — CAX21 固有の制約

| 項目 | CAX21 仕様 | 影響 |
|------|-----------|------|
| **CPU アーキテクチャ** | ARM64 (Ampere Altra) | Dockerイメージは `linux/arm64` でビルド必須 |
| **RAM** | 8GB | Redis 256MB は過小。1GB に拡張可能 |
| **ストレージ** | SSD (40GB~) | Redis パーシスタンス / ログローテーションを追加 |
| **IPv6** | 2a01:4f8:1c18:4a36::/64 | アプリ側はすでに IPv4-only を強制（問題なし） |
| **OS** | Debian | systemd でDocker自動起動を管理 |

---

## 1. 優先度マップ

```
[P0 クリティカル]  — 本番投入前に必須
[P1 高]           — 初週中に対応
[P2 中]           — 初月中に対応
[P3 低]           — 余裕があれば
```

---

## 2. P0 — ARM64 対応 (ビルド互換性)

### 問題
CAX21 は ARM64 CPU。Docker イメージを x86_64 でビルドすると実行不可。

### 対応

**① ビルド時にプラットフォームを明示する**

```bash
# 現状 (プラットフォーム未指定 → ホストアーキテクチャ依存)
docker build -t worldmonitor:latest -f Dockerfile .

# 修正後 (ARM64 を明示)
docker build --platform linux/arm64 -t worldmonitor:latest -f Dockerfile .
docker build --platform linux/arm64 -t worldmonitor-ais-relay:latest -f Dockerfile.relay .
```

**② `docker-compose.yml` にプラットフォーム指定を追加**

```yaml
services:
  worldmonitor:
    build:
      context: .
      dockerfile: Dockerfile
      platforms:           # ← 追加
        - linux/arm64
  ais-relay:
    build:
      context: .
      dockerfile: Dockerfile.relay
      platforms:
        - linux/arm64
  redis-rest:
    build:
      context: docker
      dockerfile: Dockerfile.redis-rest
      platforms:
        - linux/arm64
```

**③ ベースイメージは既存のまま OK**
- `node:22-alpine` → マルチアーキテクチャ対応済み ✅
- `redis:7-alpine` → マルチアーキテクチャ対応済み ✅

---

## 3. P0 — グレースフルシャットダウン

### 問題
`local-api-server.mjs` に SIGTERM ハンドラがない。
`docker compose restart` や更新デプロイ時に、処理中のリクエストが強制切断される。

### 対応
`src-tauri/sidecar/local-api-server.mjs` の末尾付近に追加：

```javascript
// === Graceful Shutdown ===
let isShuttingDown = false;

function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[local-api] ${signal} received — graceful shutdown`);
  server.close(() => {
    console.log('[local-api] HTTP server closed');
    process.exit(0);
  });
  // 強制終了タイムアウト (30秒)
  setTimeout(() => {
    console.error('[local-api] Forced exit after 30s timeout');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

---

## 4. P0 — Redis パーシスタンス

### 問題
現状: `redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru`
RDB/AOF が無効のため、コンテナ再起動で全キャッシュが失われる。

### 対応
`docker-compose.yml` の redis サービスを修正：

```yaml
redis:
  image: docker.io/redis:7-alpine
  container_name: worldmonitor-redis
  command: >
    redis-server
    --maxmemory 1gb
    --maxmemory-policy allkeys-lru
    --save 300 100
    --save 60 1000
    --appendonly yes
    --appendfsync everysec
  volumes:
    - redis-data:/data
  restart: unless-stopped
```

| 変更点 | 説明 |
|--------|------|
| `--maxmemory 1gb` | CAX21 の 8GB RAM に合わせて拡張 |
| `--save 300 100` | 5分間に100件変更でスナップショット |
| `--appendonly yes` | AOF ログ有効化（再起動後もデータ復元可能） |
| `--appendfsync everysec` | 1秒ごとに fsync |

---

## 5. P0 — Docker ログローテーション

### 問題
Docker のデフォルトでは json-file ドライバがログを無制限に蓄積する。長期運用でディスクフルになる。

### 対応
`docker-compose.yml` の各サービスに追加：

```yaml
services:
  worldmonitor:
    logging:
      driver: "json-file"
      options:
        max-size: "50m"
        max-file: "5"
  ais-relay:
    logging:
      driver: "json-file"
      options:
        max-size: "20m"
        max-file: "3"
  redis:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
  redis-rest:
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

---

## 6. P0 — systemd によるサービス自動起動

### 問題
VPS 再起動後に `docker compose up -d` を手動実行しない限りサービスが起動しない。

### 対応

**① Docker daemon の自動起動**
```bash
sudo systemctl enable docker
sudo systemctl start docker
```

**② `/etc/systemd/system/worldmonitor.service` を作成**

```ini
[Unit]
Description=World Monitor Stack
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/home/user/worldmonitor
ExecStart=/usr/bin/docker compose up -d --build
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=300

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable worldmonitor
sudo systemctl start worldmonitor
```

---

## 7. P1 — Discord 定期通知 (Gemini 要約)

### 概要
Redis に蓄積されたリアルタイムデータを Gemini で要約し、Discord に定期投稿する。
通知間隔は環境変数で可変。

```
Redis (地震・紛争・市場・気象等)
    ↓ redisGet()
scripts/discord-notify.mjs
    ↓ Gemini API (Direct or OpenRouter fallback)
    ↓ 要約テキスト生成
Discord Webhook → #worldmonitor チャンネル
```

### 新規ファイル: `scripts/discord-notify.mjs`

**主要機能:**

| 機能 | 詳細 |
|------|------|
| **データ取得** | Redis から8カテゴリのデータを並列 fetch |
| **フィルタリング** | M5.0以上の地震、HIGH 重大度の不安定情勢、CRITICAL サイバー脅威 など |
| **AI 要約** | Gemini 2.0 Flash で 200〜300文字の状況報告を生成 |
| **フォールバック** | `GEMINI_API_KEY` → `OPENROUTER_API_KEY` の順で試行 |
| **Discord 投稿** | リッチ Embed (カラーコード + カテゴリ別フィールド) |
| **実行モード** | 1回実行 (cron 向け) / デーモンモード (`--daemon`) |

**取得・要約する8カテゴリ:**

| カテゴリ | Redis キー | フィルタ条件 |
|---------|-----------|------------|
| 地震 | `seismology:earthquakes:v1` | M5.0以上・過去24時間 |
| 社会不安 | `unrest:events:v1` | severity=HIGH・過去24時間 |
| 軍用機 | `military:flights:v1` | riskLevel=HIGH |
| 自然災害 | `natural:events:v1` | アクティブ・重大カテゴリ |
| 気象警報 | `weather:alerts:v1` | EXTREME/SEVERE |
| サイバー脅威 | `cyber:threats:v2` | CRITICAL・過去24時間 |
| 武力紛争 | `conflict:ucdp-events:v1` | 過去7日間 |
| 市場動向 | `market:stocks-bootstrap:v1` | 変動率±2%以上 |

**Gemini API 呼び出し:**

```javascript
// Direct Gemini API (GEMINI_API_KEY)
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={KEY}
{ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1200 } }

// OpenRouter 経由 (OPENROUTER_API_KEY, フォールバック)
POST https://openrouter.ai/api/v1/chat/completions
{ model: "google/gemini-2.5-flash", messages: [...] }
```

**Discord Embed 例:**

```
🌍 World Monitor — グローバル状況レポート
━━━━━━━━━━━━━━━━━━━━━━━━━━
【脅威レベル: 高】
• M6.2の地震がトルコ西部で発生。津波の懸念なし。
• イランで大規模抗議デモ。治安部隊と衝突。
• ロシア・ウクライナ前線でHIGH リスク軍用機複数を検知。

🌊 地震 (M5.0+)      ✊ 社会不安         ✈️ 軍用機 (HIGH)
M6.2 トルコ西部      イラン (HIGH)       RRR7171 (rus)
M5.4 チリ北部        ミャンマー (HIGH)   ...

⛈️ 気象警報          🔴 サイバー脅威      📈 市場動向
Tornado Warning      C2_SERVER (CN)      ▲ NVDA +3.4%
━━━━━━━━━━━━━━━━━━━━━━━━━━
12 件のイベントを検出 • Gemini gemini-2.0-flash • World Monitor
```

### 必須環境変数

```bash
DISCORD_WEBHOOK_URL             # Discord チャンネルの Webhook URL
GEMINI_API_KEY                  # Google AI Studio で取得 (無料枠あり)
                                # https://aistudio.google.com/apikey
```

### 任意環境変数

```bash
OPENROUTER_API_KEY              # Gemini が使えない場合のフォールバック
GEMINI_MODEL                    # デフォルト: gemini-2.0-flash
DISCORD_NOTIFY_INTERVAL_MINUTES # 通知間隔(分) デフォルト: 60
DISCORD_NOTIFY_LANGUAGE         # ja | en  デフォルト: ja
```

### `docker-compose.yml` への追記

```yaml
services:
  worldmonitor:
    environment:
      DISCORD_WEBHOOK_URL: "${DISCORD_WEBHOOK_URL:-}"
      GEMINI_API_KEY: "${GEMINI_API_KEY:-}"
      GEMINI_MODEL: "${GEMINI_MODEL:-gemini-2.0-flash}"
      DISCORD_NOTIFY_INTERVAL_MINUTES: "${DISCORD_NOTIFY_INTERVAL_MINUTES:-60}"
      DISCORD_NOTIFY_LANGUAGE: "${DISCORD_NOTIFY_LANGUAGE:-ja}"
```

### cron 設定 (ホスト側で実行する場合)

```cron
# 60分ごとに Discord へ通知 (間隔は DISCORD_NOTIFY_INTERVAL_MINUTES で変更可)
0 * * * * cd /home/user/worldmonitor && node scripts/discord-notify.mjs >> /var/log/worldmonitor-discord.log 2>&1
```

### デーモンモード (コンテナ内で常駐させる場合)

`docker/supervisord.conf` に追加：

```ini
[program:discord-notify]
command=node /app/scripts/discord-notify.mjs --daemon
directory=/app
autostart=true
autorestart=true
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
```

> **推奨:** cron 方式（ホスト側）の方がシンプルで障害切り分けが楽。

---

## 8. P1 — メモリ制限と Swap 設定

### 問題
Swap がないとメモリ不足時に OOM Killer が発動し、サービスが突然終了する。

### 対応

**① VPS に Swap を追加 (2GB)**
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.d/99-worldmonitor.conf
```

**② docker-compose.yml にメモリ上限を設定**

```yaml
services:
  worldmonitor:
    mem_limit: 2g
    memswap_limit: 2g
  ais-relay:
    mem_limit: 3g       # AIS リレーはメモリを多く使う
    memswap_limit: 3g
  redis:
    mem_limit: 1.2g
    memswap_limit: 1.2g
  redis-rest:
    mem_limit: 256m
    memswap_limit: 256m
```

---

## 9. P1 — シードスクリプトのリトライ機構

### 問題
`run-seeders.sh` はシードに失敗しても再試行しない。外部 API の一時エラーでデータが長時間陳腐化する。

### 対応
`scripts/run-seeders.sh` のループを以下に置き換え：

```sh
run_with_retry() {
  f="$1"
  name="$(basename "$f")"
  max_attempts=3
  attempt=1
  while [ $attempt -le $max_attempts ]; do
    output=$(node "$f" 2>&1)
    rc=$?
    last=$(echo "$output" | tail -1)
    if echo "$last" | grep -qi "skip\|not set\|missing.*key\|not found"; then
      printf "→ %s ... SKIP (%s)\n" "$name" "$last"
      return 2
    elif [ $rc -eq 0 ]; then
      printf "→ %s ... OK%s\n" "$name" "$([ $attempt -gt 1 ] && echo " (attempt $attempt)")"
      return 0
    else
      printf "→ %s ... RETRY %d/%d (%s)\n" "$name" "$attempt" "$max_attempts" "$last"
      attempt=$((attempt + 1))
      [ $attempt -le $max_attempts ] && sleep $((attempt * attempt))  # 指数バックオフ
    fi
  done
  printf "→ %s ... FAIL after %d attempts (%s)\n" "$name" "$max_attempts" "$last"
  return 1
}
```

---

## 10. P1 — ファイアウォール設定 (ufw)

### 対応
```bash
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 3000/tcp  # World Monitor HTTP
sudo ufw allow 80/tcp    # 後で nginx/Cloudflare 用
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker が ufw をバイパスする問題への対策:
```json
// /etc/docker/daemon.json
{ "iptables": true, "userland-proxy": false }
```

---

## 11. P1 — 定期シードの cron 設定

```bash
crontab -e
```

```cron
# シードデータ更新 (30分ごと)
*/30 * * * * cd /home/user/worldmonitor && ./scripts/run-seeders.sh >> /var/log/worldmonitor-seed.log 2>&1

# Discord 通知 (60分ごと — DISCORD_NOTIFY_INTERVAL_MINUTES に合わせて調整)
0 * * * * cd /home/user/worldmonitor && node scripts/discord-notify.mjs >> /var/log/worldmonitor-discord.log 2>&1

# ログローテーション (週1回)
0 3 * * 0 truncate -s 0 /var/log/worldmonitor-seed.log /var/log/worldmonitor-discord.log
```

---

## 12. P2 — 構造化ログの追加

### 問題
`local-api-server.mjs` のログは平文 `console.log`。エラー集計や障害トリアージが困難。

### 対応
```javascript
const logger = {
  log:   (msg, meta = {}) => console.log(JSON.stringify({ level: 'info',  ts: new Date().toISOString(), msg, ...meta })),
  warn:  (msg, meta = {}) => console.log(JSON.stringify({ level: 'warn',  ts: new Date().toISOString(), msg, ...meta })),
  error: (msg, meta = {}) => console.log(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg, ...meta })),
};
```

フィルタ例: `docker logs worldmonitor | grep '"level":"error"'`

---

## 13. P2 — ヘルスチェック監視の自動化

`/api/health` が DEGRADED になっても誰も気づかない問題への対応。

**オプション A: Cron + メール**

```sh
#!/bin/sh
# scripts/health-check.sh
HEALTH=$(curl -sf http://localhost:3000/api/health 2>/dev/null | grep -o '"status":"[^"]*"' | head -1)
echo "$(date -Iseconds) $HEALTH"
if echo "$HEALTH" | grep -qE '"DEGRADED"|"UNHEALTHY"'; then
  echo "$(date -Iseconds) ALERT: $HEALTH" | mail -s "[WM] Health Alert" admin@example.com
fi
```

```cron
*/2 * * * * /home/user/worldmonitor/scripts/health-check.sh >> /var/log/worldmonitor-health.log 2>&1
```

**オプション B: UptimeRobot (無料プラン)**
- `http://your-vps-ip:3000/api/health` を HTTP キーワードモニターとして登録
- キーワード: `HEALTHY` または `WARNING` で OK 判定

---

## 14. P2 — Docker Secrets の有効化

```bash
mkdir -p /home/user/worldmonitor/secrets
echo "your-groq-key"       > secrets/groq_api_key.txt
echo "your-gemini-key"     > secrets/gemini_api_key.txt
echo "your-discord-url"    > secrets/discord_webhook_url.txt
chmod 600 secrets/*
```

`docker-compose.yml` の `secrets:` セクションを有効化後、`docker/entrypoint.sh` でシークレットを環境変数に読み込む。

---

## 15. P3 — nginx リバースプロキシ + TLS

**Cloudflare 推奨 (最も簡単):**
1. ドメインを Cloudflare に向ける
2. Cloudflare Proxy (オレンジ雲) を有効化
3. SSL/TLS モードを "Full (strict)" に設定
4. CAX21 の公開ポートは 80/443 のみ開放

**Certbot 直接:**
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 16. 実装ロードマップ

```
Week 1 (P0) — 本番投入前
├── ARM64 プラットフォーム指定追加
├── グレースフルシャットダウン追加
├── Redis パーシスタンス有効化 + maxmemory 1GB 拡張
├── Docker ログローテーション追加
└── systemd サービスファイル作成

Week 2 (P1) — 安定運用 + Discord 通知
├── Swap 設定 (2GB)
├── docker-compose メモリ上限設定
├── scripts/discord-notify.mjs 作成
│   ├── Redis 8カテゴリ取得
│   ├── Gemini 2.0 Flash 要約 (OpenRouter フォールバック)
│   └── Discord Webhook Embed 投稿
├── シードリトライロジック追加
├── ufw ファイアウォール設定
└── cron 設定 (シード 30分 / Discord 通知 可変)

Month 1 (P2)
├── 構造化ログ (JSON)
├── ヘルスチェック監視スクリプト
└── Docker Secrets 有効化

Month 2+ (P3)
└── TLS / Cloudflare Proxy 設定
```

---

## 17. 変更ファイル一覧

| ファイル | 変更内容 | 優先度 |
|---------|---------|--------|
| `docker-compose.yml` | platforms, mem_limit, logging, redis persistence, Discord/Gemini env vars | P0/P1 |
| `src-tauri/sidecar/local-api-server.mjs` | SIGTERM/SIGINT グレースフルシャットダウン | P0 |
| `scripts/discord-notify.mjs` | **新規作成** — Redis → Gemini → Discord 通知スクリプト | P1 |
| `scripts/run-seeders.sh` | リトライロジック (指数バックオフ) | P1 |
| `docker/supervisord.conf` | discord-notify デーモン追加 (デーモンモード採用時) | P1 |
| `/etc/systemd/system/worldmonitor.service` | **新規作成** (自動起動) | P0 |
| `scripts/health-check.sh` | **新規作成** (ヘルス監視) | P2 |

---

## 18. 現状評価サマリー

| 項目 | 現状 | リスク | 対応後 |
|------|------|--------|--------|
| ARM64 互換性 | ❌ 未対応 | **起動不可** | ✅ プラットフォーム明示 |
| グレースフルシャットダウン | ❌ なし | 中 (リクエスト断) | ✅ SIGTERM ハンドラ追加 |
| Redis パーシスタンス | ⚠️ 部分的 | **高 (再起動でデータ消失)** | ✅ AOF + RDB 有効化 |
| 自動起動 | ❌ なし | 高 (VPS 再起動後に停止) | ✅ systemd 管理 |
| ログローテーション | ❌ なし | 中 (ディスクフル) | ✅ max-size 設定 |
| Swap | ❌ なし | 高 (OOM Kill) | ✅ 2GB Swap 追加 |
| メモリ制限 | ❌ なし | 中 (暴走で全滅) | ✅ per-service 制限 |
| シードリトライ | ❌ なし | 中 (データ陳腐化) | ✅ 指数バックオフ |
| ファイアウォール | ❌ なし | 高 (ポート開放) | ✅ ufw 設定 |
| cron シード | ❌ なし | 高 (手動更新のみ) | ✅ 30分周期 cron |
| **Discord 通知** | ❌ なし | — (新機能) | ✅ Gemini 要約 + Webhook |
| ヘルス監視 | ⚠️ 受動的 | 中 (障害に気づかない) | ✅ 2分周期チェック |
| TLS/HTTPS | ❌ なし | 低 (HTTP のみ) | ✅ Cloudflare Proxy |
