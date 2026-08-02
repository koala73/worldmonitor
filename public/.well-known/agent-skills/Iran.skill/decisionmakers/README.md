# Iran Crisis Decision Makers Reference

## 使用指南

本目录包含 11 位关键决策者的**条件驱动行为模型**，设计用于危机模拟、谈判预测和政策分析。

### 核心原则

**模型回答的问题不是「他想要什么」，而是「什么条件下他会做什么」。**

每个文件采用 YAML 格式，包含以下关键字段：

#### 必读字段

| 字段 | 用途 | 调用场景 |
|------|------|---------|
| **known_triggers** | 升级/降级的具体信号条件 | 预测他的下一步行动 |
| **red_lines** | 不可跨越的边界 + 触发后的必然反应 | 判断冲突是否进入不可控区 |
| **power_base** | 权力来源 + 失去后果 | 理解他的行为为何相对刚硬或灵活 |
| **negotiation_style** | 谈判中的让步模式、如何定义「胜利」 | 设计可行的谈判方案 |
| **known_bluffs** | 公开威胁与实际行动的落差规律 | 区分真实底线和虚张声势 |
| **authorization_limit** | 自主决策权限 + 需上报的决定 | 判断谈判对手有无真正权力成交 |
| **key_unknowns** | 数据缺口和高风险不确定性 | 识别情报盲点 |

#### 证据等级

- **★★★** 本人公开声明 + 近期行为双重印证
- **★★☆** 可靠二手来源 + 部分行为印证
- **★☆☆** 类比推断 / 有理由假设
- **☆☆☆** 纯推测，使用时需谨慎

### 文件索引与优先级

#### 【美方】

| 文件 | 决策者 | 优先级 | 关键决定权 |
|------|-------|--------|----------|
| `trump.yaml` | Donald Trump | P0 | 是否继续对伊行动、谈判上限、制裁执行 |
| `witkoff.yaml` | Steve Witkoff | P1 | 谈判机制设计、「可签字的交易」范围 |
| `vance.yaml` | JD Vance | P2 | 特朗普对伊政策的重要解读、谈判立场微调 |

**分析文档：** `rubio_witkoff_tension.md` — Rubio 与 Witkoff 核计划政策的内部张力

#### 【伊朗方】

| 文件 | 决策者 | 优先级 | 关键决定权 |
|------|-------|--------|----------|
| `mojtaba_khamenei.yaml` | Mojtaba Khamenei | P0 | 是否回应导弹/谈判、维持强硬姿态的压力 |
| `araghchi.yaml` | Abbas Araghchi | P1 | 谈判立场表述、执行指令的灵活度 |
| `irgc_command.yaml` | IRGC 最高指挥 | P1 | 军事行动授权、导弹发射决定 |

#### 【中俄方】

| 文件 | 决策者 | 优先级 | 关键决定权 |
|------|-------|--------|----------|
| `xi_jinping.yaml` | 习近平 | P1 | 对伊军援范围、能源合作强度、地区政策基调 |
| `putin.yaml` | 普京 | P2 | 俄伊军事合作力度、是否公开站队 |

#### 【地区轴心】

| 文件 | 决策者 | 优先级 | 关键决定权 |
|------|-------|--------|----------|
| `netanyahu.yaml` | Benjamin Netanyahu | P1 | 停火条件、报复强度、与美协调深度 |
| `mbs.yaml` | Mohammad bin Salman | P2 | 沙特防守立场、调停空间、与伊合作红线 |

### 使用场景

#### 场景 1：预测谈判破裂

1. 打开 **Vance** 的 `known_triggers.escalate`
2. 检查今天是否有触发条件成立
3. 查看 Araghchi 的 `authorization_limit` → 确认他能否代表伊朗做出新承诺
4. 参考 `rubio_witkoff_tension.md` → 判断美方是否有内部共识

#### 场景 2：评估红线触发风险

1. 查看 **Mojtaba** 的 `red_lines` → 什么军事行动会被视为「侵犯伊朗主权」
2. 检查 **Netanyahu** 的 `current_position` → 以色列近期是否靠近这条红线
3. 监控 `IRGC_command.watch_for` → 导弹发射的前期信号

#### 场景 3：识别虚张声势

1. 查看 **Trump** 的 `known_bluffs` → 他过去多少次宣布最后期限但延期
2. 对比 Witkoff 的 `negotiation_style` → 他是否在释放降温信号
3. 参考 `known_triggers.deescalate` → 什么条件下他会收手

### 数据有效期与更新策略

**基准日期：2026-04-14**

当发生以下事件时，应优先更新相关文件：

- **高层人事变化** → 重写 power_base / authorization_limit
- **公开声明与行为矛盾扩大** → 更新 known_bluffs 和 evidence_quality
- **新的谈判轮次** → 更新 current_position 和 negotiation_style
- **红线被触及或回避** → 更新 red_lines 的触发状态

### 局限性

#### Mojtaba Khamenei（★★☆ 数据质量警告）

- 上任仅 35 天，历史行为记录极稀缺
- 依赖 IRGC 拱卫而非宗教合法性
- key_unknowns 特别长，应定期补充新信息

#### Araghchi（执行者 vs 决策者）

- 他的谈判立场常需向上确认授权
- Vance 评论「他们没有授权签字」(2026-04-12) 是关键参照
- 他的任何「妥协」都应检查背后是否有 Mojtaba 支持

### 方法论警告

1. **勿用西方理性判断非西方决策者**
   - Mojtaba 的「理性」≠ Trump 的「理性」
   - 每个文件都明确标注参照系（个人生存 / 权力竞争 / 意识形态）

2. **勿忽视权力基础的脆弱性**
   - Mojtaba 依赖 IRGC，但 IRGC 内部是否有「够了，谈吧」派系？
   - Xi 的台海优先，伊朗战争是否开始绑架他的决策？

3. **勿过信公开声明**
   - 查看 evidence_quality，只有 ★★★ 才能用于核心判断
   - known_bluffs 列出过去的虚张声势百分比

---

**维护者注记：** 本参考库设计为动态文档，每个文件的 `last_updated` 日期应反映最后验证时间。如发现与现实严重偏差，请立即更新。
