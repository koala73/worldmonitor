# VPS Refactoring Plan — Hetzner CAX21 (24/7 運用)

**対象環境:** Hetzner CAX21 · Debian · 8GB RAM · ARM64 (Ampere Altra)
**目標:** 24時間365日の安定稼働

---

## 0. 前提確認 — CAX21 固有の制約

| 項目 | CAX21 仕様 | 影響 |
|------|-----------|------|
| **CPU アーキテクチャ** | ARM64 (Ampere Altra) | Dockerイメージは `linux/arm64` でビルド必須 |
| **RAM** | 8GB | Redis 256MB は過小。1GB に拡張可能 |
| **ストレージ** | SSD (40GB~) | Redisパーシスタンス / ログローテーションを追加 |
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
# docker-compose.yml の各 build セクションに追加
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

また、ヘルスチェックリクエスト中のシャットダウン対策として、`isShuttingDown` フラグを既存のリクエストハンドラに連携させる。

---

## 4. P0 — Redis パーシスタンス

### 問題
現状の Redis コマンド: `redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru`
RDB/AOF が無効のため、コンテナ再起動で全キャッシュが失われ、シードを再実行しなければダッシュボードが空になる。

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

**変更点の説明:**
- `--maxmemory 256mb → 1gb` : CAX21 の 8GB RAM に合わせて拡張
- `--save 300 100` : 5分間に100件変更があればスナップショット保存
- `--save 60 1000` : 1分間に1000件変更があればスナップショット保存
- `--appendonly yes` : AOF ログ有効化（再起動後もデータ復元可能）
- `--appendfsync everysec` : 1秒ごとに fsync（パフォーマンスと耐久性のバランス）

---

## 5. P0 — Docker ログローテーション

### 問題
supervisord のログを `/dev/stdout` に流すが、Docker のデフォルトでは json-file ドライバがログを無制限に蓄積する。
長期運用でディスクフルになる。

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
VPS の再起動後に `docker compose up -d` を手動実行しない限りサービスが起動しない。

### 対応

**① Docker daemon の自動起動**
```bash
sudo systemctl enable docker
sudo systemctl start docker
```

**② systemd ユニットファイルの作成**

`/etc/systemd/system/worldmonitor.service` を作成：

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

## 7. P1 — メモリ制限と Swap 設定

### 問題
CAX21 に Swap がないとメモリ不足時に OOM Killer が発動し、サービスが突然終了する。

### 対応

**① VPS に Swap を追加 (2GB)**
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Swappiness を下げる (メモリが余裕ある間は Swap を使わない)
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

## 8. P1 — シードスクリプトのリトライ機構

### 問題
`run-seeders.sh` はシードに失敗しても再試行せずに `FAIL` としてカウントするだけ。
外部 API の一時的なエラーで長時間データが陳腐化する。

### 対応
`scripts/run-seeders.sh` にリトライロジックを追加：

```sh
# 既存のシード実行ループを以下に置き換え
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
      if [ $attempt -gt 1 ]; then
        printf "→ %s ... OK (attempt %d)\n" "$name" "$attempt"
      else
        printf "→ %s ... OK\n" "$name"
      fi
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

## 9. P1 — ファイアウォール設定 (ufw)

### 問題
Redis (:6379) や Redis REST proxy (:8079) がホストに露出していると、外部からアクセス可能になるリスクがある。
現状の docker-compose.yml では redis-rest が `127.0.0.1:8079:80` でバインドしているが、iptables レベルで保護する方が安全。

### 対応
```bash
sudo apt install -y ufw

# デフォルトポリシー
sudo ufw default deny incoming
sudo ufw default allow outgoing

# SSH (必ず先に許可)
sudo ufw allow 22/tcp

# World Monitor (HTTP)
sudo ufw allow 3000/tcp

# HTTPS (後で nginx リバースプロキシを立てる場合)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 有効化
sudo ufw enable
sudo ufw status verbose
```

Docker のネットワークは ufw をバイパスする問題がある。以下で対策：

```bash
# /etc/docker/daemon.json
{
  "iptables": true,
  "userland-proxy": false
}
```

---

## 10. P1 — 定期シードの cron 設定

### 対応
```bash
crontab -e
```

以下を追加：
```cron
# World Monitor — シードデータ更新 (30分ごと)
*/30 * * * * cd /home/user/worldmonitor && ./scripts/run-seeders.sh >> /var/log/worldmonitor-seed.log 2>&1

# ログローテーション (週1回)
0 3 * * 0 truncate -s 0 /var/log/worldmonitor-seed.log
```

---

## 11. P2 — 構造化ログの追加

### 問題
`local-api-server.mjs` のログは平文 `console.log`。
エラー集計や障害トリアージが困難。

### 対応
API サーバーのログフォーマットを JSON に統一：

```javascript
// 既存の console.log を置き換えるロガーラッパー
const logger = {
  log:   (msg, meta = {}) => console.log(JSON.stringify({ level: 'info',  ts: new Date().toISOString(), msg, ...meta })),
  warn:  (msg, meta = {}) => console.log(JSON.stringify({ level: 'warn',  ts: new Date().toISOString(), msg, ...meta })),
  error: (msg, meta = {}) => console.log(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg, ...meta })),
};
```

ログは `docker logs worldmonitor | grep '"level":"error"'` でフィルタリング可能になる。

---

## 12. P2 — ヘルスチェック監視の自動化

### 問題
`/api/health` エンドポイントはヘルス状態を返すが、DEGRADED になっても誰も気づかない。

### 対応

**オプション A: Cron ベースの簡易監視**

`/home/user/worldmonitor/scripts/health-check.sh` を作成：

```sh
#!/bin/sh
HEALTH=$(curl -sf http://localhost:3000/api/health 2>/dev/null | grep -o '"status":"[^"]*"' | head -1)
echo "$(date -Iseconds) $HEALTH"
if echo "$HEALTH" | grep -qE '"DEGRADED"|"UNHEALTHY"'; then
  echo "$(date -Iseconds) ALERT: World Monitor is $HEALTH" | \
    mail -s "[WM] Health Alert" admin@example.com
fi
```

```cron
# 2分ごとにヘルスチェック
*/2 * * * * /home/user/worldmonitor/scripts/health-check.sh >> /var/log/worldmonitor-health.log 2>&1
```

**オプション B: UptimeRobot (無料プラン)**
- `https://your-vps-ip:3000/api/health` を HTTP キーワードモニターとして登録
- キーワード: `"HEALTHY"` または `"WARNING"` で OK 判定

---

## 13. P2 — Docker Secrets の有効化

### 問題
現状の API キーは環境変数で注入されており、`docker inspect worldmonitor` で平文が見えてしまう。

### 対応
`docker-compose.yml` のコメントアウトを外して Docker Secrets を有効化：

```bash
mkdir -p /home/user/worldmonitor/secrets
echo "your-groq-key"          > secrets/groq_api_key.txt
echo "your-aisstream-key"     > secrets/aisstream_api_key.txt
echo "your-finnhub-key"       > secrets/finnhub_api_key.txt
echo "your-fred-key"          > secrets/fred_api_key.txt
echo "your-nasa-firms-key"    > secrets/nasa_firms_api_key.txt
echo "your-llm-key"           > secrets/llm_api_key.txt
chmod 600 secrets/*
```

`docker-compose.yml` の `secrets:` セクションを有効化し、`docker/entrypoint.sh` でシークレットを環境変数に読み込む処理が必要。

---

## 14. P3 — nginx リバースプロキシ + TLS

### 対応
Let's Encrypt で HTTPS を有効化。VPS に直接 nginx + certbot を立てるか、Cloudflare Proxy を前段に置く。

**Cloudflare 推奨 (最も簡単):**
1. ドメインを Cloudflare に移管またはサブドメインの NS を向ける
2. Cloudflare の Proxy (オレンジ雲) を有効化
3. SSL/TLS モードを "Full (strict)" に設定
4. CAX21 の公開ポートは 80/443 のみ開放

**Certbot 直接の場合:**
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 15. 実装ロードマップ

```
Week 1 (P0)
├── ARM64 プラットフォーム指定追加
├── グレースフルシャットダウン追加
├── Redis パーシスタンス有効化 + maxmemory 拡張
├── Docker ログローテーション追加
└── systemd サービスファイル作成

Week 2 (P1)
├── Swap 設定 (2GB)
├── docker-compose メモリ上限設定
├── シードリトライロジック追加
├── ufw ファイアウォール設定
└── cron シードジョブ設定

Month 1 (P2)
├── 構造化ログ (JSON)
├── ヘルスチェック監視スクリプト
└── Docker Secrets 有効化

Month 2+ (P3)
└── TLS / Cloudflare Proxy 設定
```

---

## 16. 変更ファイル一覧

| ファイル | 変更内容 | 優先度 |
|---------|---------|--------|
| `docker-compose.yml` | platforms, mem_limit, logging, redis persistence | P0 |
| `src-tauri/sidecar/local-api-server.mjs` | SIGTERM/SIGINT グレースフルシャットダウン | P0 |
| `scripts/run-seeders.sh` | リトライロジック (指数バックオフ) | P1 |
| `/etc/systemd/system/worldmonitor.service` | 新規作成 (自動起動) | P0 |
| `scripts/health-check.sh` | 新規作成 (ヘルス監視) | P2 |

---

## 17. 現状評価サマリー

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
| ヘルス監視 | ⚠️ 受動的 | 中 (障害に気づかない) | ✅ 2分周期チェック |
| TLS/HTTPS | ❌ なし | 低 (HTTP のみ) | ✅ Cloudflare Proxy |
