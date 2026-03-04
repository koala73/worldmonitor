# Omni Sentinel — 执行手册

> 按顺序执行。每个步骤标明了在哪个 terminal、什么时间点开始。

---

## 前置准备

```bash
# 确认 upstream remote 存在
cd /Users/maxwsy/workspace/omni-sentinel
git remote -v
# 应该看到:
# origin   https://github.com/maxwangsongyuan/omni-sentinel.git
# upstream https://github.com/koala73/worldmonitor.git

# 确认在 main 分支且干净
git status
git pull origin main
```

---

## Phase 1: 基础设施 (顺序执行)

### Terminal 1 — Module 0: Infrastructure

```bash
cd /Users/maxwsy/workspace/omni-sentinel
claude
```

给 Claude 的 prompt:

```
按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 0 (Infrastructure Foundation) 执行所有任务 (Task 0.1 到 0.11)。

按 TDD 流程: 写测试 → 跑测试确认 fail → 写实现 → 跑测试确认 pass → commit。

每完成一个 Task 就 commit 一次。全部完成后告诉我。
```

### Terminal 2 — Module 7: RSS Expansion (同时开)

Module 7 是纯配置改动，不依赖 Module 0，可以同时做。

```bash
cd /Users/maxwsy/workspace/omni-sentinel
git checkout -b module-7-rss
claude
```

给 Claude 的 prompt:

```
按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 7 (RSS Expansion) 执行所有任务。

这是配置改动：
1. 读 src/config/feeds.ts 找出已有的 feeds
2. 确认哪些是真正缺失的
3. 添加缺失的 feeds 到 sentinel-feeds.ts
4. 更新 api/rss-proxy.js 的 ALLOWED_DOMAINS

完成后 commit 并告诉我。
```

### Phase 1 合并

等两个 terminal 都完成后:

```bash
# Terminal 1 已经在 main 上 commit 了 Module 0

# 合并 Module 7
cd /Users/maxwsy/workspace/omni-sentinel
git merge module-7-rss
git branch -d module-7-rss
git push origin main
```

---

## Phase 2: 五个模块并行 (Worktree)

### 创建 Worktrees

Module 0 完成并 push 后，创建 5 个 worktree:

```bash
cd /Users/maxwsy/workspace/omni-sentinel

# 创建 worktree 目录
mkdir -p .claude/worktrees

# 创建 5 个 worktree (每个基于最新 main)
git worktree add .claude/worktrees/wt-claude   -b module-1-claude   main
git worktree add .claude/worktrees/wt-social   -b module-2-social   main
git worktree add .claude/worktrees/wt-govdata  -b module-4-govdata  main
git worktree add .claude/worktrees/wt-trajectory -b module-5-trajectory main
git worktree add .claude/worktrees/wt-prediction -b module-6-prediction main

# 验证
git worktree list
```

### Terminal 1 — Module 1: Claude AI Provider

```bash
cd /Users/maxwsy/workspace/omni-sentinel/.claude/worktrees/wt-claude
claude
```

Prompt:

```
你在 omni-sentinel 的 worktree 分支 module-1-claude 上。

按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 1 (Claude AI Provider) 执行所有任务 (Task 1.1 到 1.9)。

关键点:
- Proto 文件需要 sebuf.http 注解
- Summarize 用 Haiku 模型，Analyze/Predict 用 Sonnet 模型
- 测试用 node:test + node:assert/strict (.test.mts 文件)
- 组件用 .ts vanilla DOM，不用 .tsx JSX
- 每完成一个 Task 就 commit

全部完成后告诉我。
```

### Terminal 2 — Module 2: Social Media

```bash
cd /Users/maxwsy/workspace/omni-sentinel/.claude/worktrees/wt-social
claude
```

Prompt:

```
你在 omni-sentinel 的 worktree 分支 module-2-social 上。

按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 2 (Social Media Integration) 执行所有任务 (Task 2.1 到 2.10)。

关键点:
- Reddit 必须用 OAuth2 client credentials
- Twitter 用 adapter pattern (TwitterApiIoAdapter 为默认)
- Bluesky limit = Math.min(limit, 25)
- YouTube 是新平台 (Data API v3)
- SocialFeedPanel 是 .ts 文件 (extends Panel, 用 h() DOM helper)
- 测试用 node:test (.test.mts)
- 每完成一个 Task 就 commit

全部完成后告诉我。
```

### Terminal 3 — Module 4: Government Data

```bash
cd /Users/maxwsy/workspace/omni-sentinel/.claude/worktrees/wt-govdata
claude
```

Prompt:

```
你在 omni-sentinel 的 worktree 分支 module-4-govdata 上。

按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 4 (Government Data) 执行所有任务。

关键点:
- NOTAM: FAA API + AviationStack
- NAVTEX: 不要创建新服务，检查现有的 maritime warnings 服务是否足够
- Sanctions: OpenSanctions API (免费)
- Proto 需要 sebuf.http 注解
- 测试用 node:test (.test.mts)
- 每完成一个 Task 就 commit

全部完成后告诉我。
```

### Terminal 4 — Module 5: Historical Trajectory

```bash
cd /Users/maxwsy/workspace/omni-sentinel/.claude/worktrees/wt-trajectory
claude
```

Prompt:

```
你在 omni-sentinel 的 worktree 分支 module-5-trajectory 上。

按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 5 (Historical Trajectory) 执行所有任务。

关键点:
- Phase 1 只用 OpenSky REST API (/api/tracks/all)，只能拿到最近 ~1 小时的轨迹
- 真正的历史数据 (Impala DB) 需要 SSH，留到 Phase 2
- icao24 必须用 validateHexParam 验证
- 数据量大时用 Ramer-Douglas-Peucker 降采样
- 测试用 node:test (.test.mts)
- 每完成一个 Task 就 commit

全部完成后告诉我。
```

### Terminal 5 — Module 6: Prediction Markets

```bash
cd /Users/maxwsy/workspace/omni-sentinel/.claude/worktrees/wt-prediction
claude
```

Prompt:

```
你在 omni-sentinel 的 worktree 分支 module-6-prediction 上。

按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 6 (Prediction Markets) 执行所有任务。

关键点:
- 不要修改现有的 prediction/v1 proto
- 创建独立的 proto/worldmonitor/kalshi/v1/ 和 proto/worldmonitor/metaculus/v1/
- Kalshi API: https://trading-api.kalshi.com/trade-api/v2/markets
- Metaculus API: https://www.metaculus.com/api2/questions/
- Proto 需要 sebuf.http 注解
- 测试用 node:test (.test.mts)
- 每完成一个 Task 就 commit

全部完成后告诉我。
```

---

## Phase 2 合并

5 个 terminal 全部完成后，逐个合并到 main:

```bash
cd /Users/maxwsy/workspace/omni-sentinel

# 1. 先合并 Module 1 (Claude) — Module 3 依赖它
git merge module-1-claude
# 如有冲突，解决后 git add + git commit

# 2. 合并 Module 2 (Social)
git merge module-2-social

# 3. 合并 Module 4 (Government Data)
git merge module-4-govdata

# 4. 合并 Module 5 (Trajectory)
git merge module-5-trajectory

# 5. 合并 Module 6 (Prediction)
git merge module-6-prediction

# 清理 worktrees
git worktree remove .claude/worktrees/wt-claude
git worktree remove .claude/worktrees/wt-social
git worktree remove .claude/worktrees/wt-govdata
git worktree remove .claude/worktrees/wt-trajectory
git worktree remove .claude/worktrees/wt-prediction

# 推送
git push origin main
```

---

## Phase 3: JP 3-60 Analyst

所有模块合并后，最后做 Module 3:

```bash
cd /Users/maxwsy/workspace/omni-sentinel
claude
```

Prompt:

```
按照 docs/plans/2026-03-03-omni-sentinel-implementation-v2.md 的 Module 3 (JP 3-60 Military Analysis Agent) 执行所有任务。

Module 1 (Claude AI Provider) 已经完成，可以直接导入使用。

关键点:
- 单次 Claude API call (不是 6 次)
- JP 3-60 system prompt 用 Anthropic prompt caching
- Sonnet 模型
- AnalystPanel 是 .ts 文件 (extends Panel)
- 必须有 ethical disclaimer: "AI-generated estimate, not a prediction"
- 测试用 node:test (.test.mts)
- 每完成一个 Task 就 commit

全部完成后 push。
```

---

## 完成后检查清单

```bash
cd /Users/maxwsy/workspace/omni-sentinel

# 1. 所有测试通过
npx tsx --test

# 2. Proto 生成无报错
buf generate proto/

# 3. Feature flags 工作 (每个模块可独立开关)
grep -r 'MODULE_.*_ENABLED' .env.example

# 4. Fork 安全: 核心文件改动最小
git diff upstream/main -- src/config/panels.ts src/services/summarization.ts \
  src/services/runtime-config.ts server/gateway.ts | head -50

# 5. 无遗漏的 i18n key
grep -r 'sentinel\.' src/locales/sentinel-en.json | wc -l

# 6. 推送
git push origin main
```

---

## 时间线预估

| 阶段 | 耗时 | 并行度 |
|------|------|--------|
| Phase 1 (Module 0 + 7) | ~1-2h | 2 terminals |
| Phase 2 (Module 1,2,4,5,6) | ~3-5h | 5 terminals |
| Phase 2 合并 | ~30min | 1 terminal |
| Phase 3 (Module 3) | ~2-3h | 1 terminal |
| 最终检查 | ~30min | 1 terminal |
| **总计** | **~7-10h** | 最多 5 并行 |

> 时间取决于 Claude Code 的响应速度和是否遇到 codebase 问题需要调试。

---

*Created: 2026-03-04. Follow this playbook exactly for execution.*
