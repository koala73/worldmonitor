# Ireland Monitor RSS Feed 修复方案

**问题**: Silicon Republic 等爱尔兰科技新闻网站的 RSS feed 返回 502 错误，导致最新新闻无法显示。

**根本原因**: 
1. 这些网站在 `RELAY_ONLY_DOMAINS` 列表中，需要通过 Railway relay 获取
2. Railway relay 服务器可能未配置或已下线（`WS_RELAY_URL` 环境变量缺失）
3. 即使有 relay，这些网站的反爬虫保护也会阻止抓取

---

## 解决方案对比

| 方案 | 优点 | 缺点 | 工时 |
|------|------|------|------|
| **方案 A: 使用 CORS 代理服务** | 简单，无需自建服务器 | 依赖第三方，可能不稳定 | 1h |
| **方案 B: 直接客户端请求（移除 proxy）** | 最简单，零依赖 | 受 CORS 限制，可能被封 | 2h |
| **方案 C: 自建 RSS 聚合服务** | 稳定，可控，可缓存 | 需要独立服务器，成本高 | 8h |
| **方案 D: 使用 Google News RSS** | 稳定，免费 | 内容可能有延迟 | 1h |

---

## 推荐方案：方案 D + 方案 A（混合）

### 实现步骤

#### Step 1: 修改 RSS feed 配置（改用 Google News RSS）

**文件**: `src/config/variants/ireland.ts`

```typescript
// 修改前（直接抓取网站 RSS）
{
  url: 'https://www.siliconrepublic.com/feed',
  label: 'Silicon Republic',
}

// 修改后（使用 Google News RSS）
{
  url: 'https://news.google.com/rss/search?q=site:siliconrepublic.com+when:1d&hl=en-IE&gl=IE&ceid=IE:en',
  label: 'Silicon Republic (Google News)',
}
```

**完整配置**:
```typescript
const IRELAND_TECH_FEEDS = [
  // Silicon Republic - Tech News
  {
    url: 'https://news.google.com/rss/search?q=site:siliconrepublic.com+technology+OR+startup+OR+AI+when:2d&hl=en-IE&gl=IE&ceid=IE:en',
    label: 'Silicon Republic - Tech (Google News)',
    categories: ['ieTech', 'startups'],
  },
  // TheJournal.ie - Tech Section
  {
    url: 'https://news.google.com/rss/search?q=site:thejournal.ie/tech+when:2d&hl=en-IE&gl=IE&ceid=IE:en',
    label: 'TheJournal.ie - Tech (Google News)',
    categories: ['ieTech'],
  },
  // Business Post - Technology
  {
    url: 'https://news.google.com/rss/search?q=site:businesspost.ie+technology+when:2d&hl=en-IE&gl=IE&ceid=IE:en',
    label: 'Business Post - Tech (Google News)',
    categories: ['ieTech', 'ieBusiness'],
  },
  // Irish Times - Technology
  {
    url: 'https://news.google.com/rss/search?q=site:irishtimes.com+technology+when:2d&hl=en-IE&gl=IE&ceid=IE:en',
    label: 'Irish Times - Tech (Google News)',
    categories: ['ieTech', 'ieBusiness'],
  },
];
```

**优点**:
- ✅ Google News RSS 非常稳定（几乎不会被封）
- ✅ 不需要 Railway relay
- ✅ 自动聚合多个来源
- ✅ 可以通过 `when:1d` 参数控制时间范围

**缺点**:
- ⚠️ 内容可能有 1-2 小时延迟
- ⚠️ 标题和描述可能被 Google 截断

#### Step 2: 从 RELAY_ONLY_DOMAINS 移除爱尔兰网站

**文件**: `api/rss-proxy.js`

```javascript
// 修改前
const RELAY_ONLY_DOMAINS = new Set([
  // ...
  'www.siliconrepublic.com',  // ← 移除
  'www.techcentral.ie',        // ← 移除
  'businessplus.ie',           // ← 移除
]);

// 修改后（移除这三个域名）
const RELAY_ONLY_DOMAINS = new Set([
  'rss.cnn.com',
  'www.defensenews.com',
  // ... 其他域名
  // 移除了爱尔兰网站
]);
```

**原因**: 因为现在用 Google News RSS，不再直接访问这些网站。

#### Step 3: 添加 Google News 到允许列表

**文件**: `api/_rss-allowed-domains.js`

```javascript
export default [
  // ... 现有域名
  'news.google.com',  // ← 添加（如果还没有）
];
```

#### Step 4: 增加 Google News RSS 的超时时间

**文件**: `api/rss-proxy.js`

```javascript
// 修改前
const isGoogleNews = feedUrl.includes('news.google.com');
const timeout = isGoogleNews ? 20000 : 12000;

// 修改后（增加到 30 秒）
const isGoogleNews = feedUrl.includes('news.google.com');
const timeout = isGoogleNews ? 30000 : 12000;
```

**原因**: Google News RSS 有时响应较慢，尤其是复杂查询。

---

## 方案 A: 使用 AllOrigins CORS 代理（备选）

如果 Google News 也不行，可以用第三方 CORS 代理。

### 实现

**文件**: `src/utils/proxy.ts`

```typescript
// 添加 CORS 代理封装
export function wrapWithCorsProxy(feedUrl: string): string {
  // AllOrigins - 免费 CORS 代理
  return `https://api.allorigins.win/get?url=${encodeURIComponent(feedUrl)}`;
}

// 使用示例
const proxiedUrl = wrapWithCorsProxy('https://www.siliconrepublic.com/feed');
```

**修改 feed 配置**:
```typescript
{
  url: wrapWithCorsProxy('https://www.siliconrepublic.com/feed'),
  label: 'Silicon Republic (via proxy)',
}
```

**优点**:
- ✅ 绕过 CORS 限制
- ✅ 免费
- ✅ 实现简单

**缺点**:
- ⚠️ 依赖第三方服务（可能不稳定）
- ⚠️ 有请求速率限制
- ⚠️ 可能被网站检测为爬虫

---

## 方案 C: 自建 RSS 聚合服务（长期方案）

### 架构

```
┌─────────────────┐
│ Cloudflare      │  ← Cron Triggers (每 10 分钟)
│ Workers         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ RSS Aggregator  │  ← 抓取 Silicon Republic、TheJournal 等
│ Worker          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Cloudflare KV   │  ← 缓存 RSS 数据（TTL: 10 min）
│ Storage         │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Ireland Monitor │  ← 通过 API 读取缓存
└─────────────────┘
```

### 实现代码（Cloudflare Worker）

```javascript
// rss-aggregator-worker.js
const RSS_SOURCES = [
  'https://www.siliconrepublic.com/feed',
  'https://www.thejournal.ie/tech/feed/',
  'https://businessplus.ie/feed/',
];

export default {
  async scheduled(event, env, ctx) {
    // 定时任务：每 10 分钟抓取一次
    const results = await Promise.all(
      RSS_SOURCES.map(url => fetchAndCache(url, env))
    );
    
    console.log('Aggregated', results.length, 'feeds');
  },
  
  async fetch(request, env) {
    // API 端点：返回聚合的 RSS
    const feeds = await Promise.all(
      RSS_SOURCES.map(url => env.RSS_CACHE.get(url))
    );
    
    const merged = mergeRSS(feeds.filter(Boolean));
    
    return new Response(merged, {
      headers: {
        'Content-Type': 'application/xml',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};

async function fetchAndCache(url, env) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IrelandMonitor/1.0)',
      },
    });
    
    const xml = await response.text();
    
    // 缓存 10 分钟
    await env.RSS_CACHE.put(url, xml, { expirationTtl: 600 });
    
    return { url, ok: true };
  } catch (error) {
    console.error('Failed to fetch', url, error);
    return { url, ok: false, error: error.message };
  }
}

function mergeRSS(feeds) {
  // 合并多个 RSS feed 为一个
  // ... RSS 合并逻辑
}
```

**部署**:
```bash
npm create cloudflare@latest ireland-rss-aggregator
cd ireland-rss-aggregator
wrangler publish
```

**修改 Ireland Monitor 配置**:
```typescript
{
  url: 'https://ireland-rss-aggregator.your-worker.workers.dev/',
  label: 'Ireland Tech (Aggregated)',
}
```

**优点**:
- ✅ 完全可控
- ✅ Cloudflare Workers 免费额度很高
- ✅ 全球 CDN，速度快
- ✅ 自动缓存，减少对源网站的请求

**缺点**:
- ⚠️ 需要额外维护
- ⚠️ 初始设置复杂

---

## 实施建议

### 阶段 1: 快速修复（1 小时）
- ✅ 采用 **方案 D**（Google News RSS）
- ✅ 修改 `src/config/variants/ireland.ts` 中的 feed URLs
- ✅ 从 `RELAY_ONLY_DOMAINS` 移除爱尔兰网站
- ✅ 测试验证

### 阶段 2: 优化（可选，2-4 周后）
- 🔄 如果 Google News 延迟太高，考虑 **方案 C**（自建聚合）
- 🔄 收集用户反馈
- 🔄 调整查询参数（如 `when:1d` vs `when:2d`）

---

## 代码修改清单

### 文件 1: `src/config/variants/ireland.ts`

```diff
- const IRELAND_TECH_FEEDS = [
-   {
-     url: 'https://www.siliconrepublic.com/feed',
-     label: 'Silicon Republic',
-   },
- ];

+ const IRELAND_TECH_FEEDS = [
+   {
+     url: 'https://news.google.com/rss/search?q=site:siliconrepublic.com+technology+OR+startup+OR+AI+when:2d&hl=en-IE&gl=IE&ceid=IE:en',
+     label: 'Silicon Republic (Google News)',
+     categories: ['ieTech', 'startups'],
+   },
+   {
+     url: 'https://news.google.com/rss/search?q=site:thejournal.ie/tech+when:2d&hl=en-IE&gl=IE&ceid=IE:en',
+     label: 'TheJournal.ie - Tech (Google News)',
+     categories: ['ieTech'],
+   },
+ ];
```

### 文件 2: `api/rss-proxy.js`

```diff
const RELAY_ONLY_DOMAINS = new Set([
  'rss.cnn.com',
  'www.defensenews.com',
  // ...
-  'www.siliconrepublic.com',
-  'www.techcentral.ie',
-  'businessplus.ie',
]);
```

### 文件 3: `api/_rss-allowed-domains.js`

```diff
export default [
  // ... existing domains
+  'news.google.com',
];
```

---

## 测试验证

### 本地测试
```bash
# 1. 修改代码后
cd ~/workspace/coding/ireland-monitor
npm run dev

# 2. 打开浏览器控制台
# 查看是否有 502 错误

# 3. 检查 RSS feed
curl "https://news.google.com/rss/search?q=site:siliconrepublic.com+technology+when:1d&hl=en-IE" | head -50
```

### 部署测试
```bash
# 部署到 Vercel
vercel --prod

# 验证新闻是否正常加载
curl "https://ireland-monitor.vercel.app/api/rss-proxy?url=https://news.google.com/rss/search?q=site:siliconrepublic.com"
```

---

## 回滚计划

如果新方案有问题：

1. **立即回滚**: `git revert <commit-hash>`
2. **临时禁用**: 在 `src/config/variants/ireland.ts` 中注释掉有问题的 feeds
3. **应急方案**: 使用静态 JSON 文件提供新闻数据

---

**推荐**: 先实施**方案 D**（Google News RSS），快速解决当前问题。如果效果不理想，再考虑**方案 C**（自建聚合）。

*日期: 2026-04-03*
*优先级: P0 (Critical)*
