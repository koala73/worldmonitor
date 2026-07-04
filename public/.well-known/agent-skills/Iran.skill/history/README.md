# /history/ 模块 · README

**版本**：1.0.0 | **创建日期**：2026-04-14
**功能**：为 Iran.skill 提供 2500 年波斯帝国经验的结构性分析层

---

## 模块结构

```
/history/
├── README.md                              ← 本文件
├── READING_LIST.md                        ← 推荐书目（29 本）
├── /leaders/                              ← 历史领导人心智模型（6 个 YAML）
│   ├── cyrus_the_great.yaml               ← 「包容性帝国」模型
│   ├── darius_i.yaml                      ← 「制度化统治」模型
│   ├── shah_abbas_i.yaml                  ← 「教派国家建构者」模型
│   ├── qajar_dynasty.yaml                 ← 「屈辱记忆」模型
│   ├── mosaddegh.yaml                     ← 「民主中断」模型
│   └── khomeini.yaml                      ← 「革命意志」模型
│   └── nader_reza_strongmen.yaml          ← 「军事强人」双人模型
└── /frameworks/                           ← 分析框架（3 个）
    ├── shahnameh-psychology.md             ← Shahnameh 文化心理学
    ├── historical-pattern-matrix.md       ← 历史模式→当代映射矩阵
    └── imperial-cycle.md                  ← 帝国更替周期框架
```

**总计**：10 个文件（7 YAML/MD 数据文件 + 3 框架文件）

---

## 与现有模块的关系

本模块是 Iran.skill 的**第四层**：

| 层级 | 模块 | 回答的问题 | 时间尺度 |
|------|------|-----------|---------|
| 第一层 | /sources/ + /decisionmakers/ | 「具体的人在具体条件下会做什么」 | 天-周 |
| 第二层 | /frameworks/ + /scenarios/ | 「结构性压力的方向和概率」 | 周-月 |
| 第三层 | /bias-check/ + /perspectives/ | 「我们可能遗漏了什么视角」 | 验证层 |
| **第四层** | **/history/** | **「为什么他们这样想而不是那样想」** | **世纪-千年** |

**关键原则**：/history/ 不替代任何现有模块——它为现有模块提供「为什么」的深层解释。

---

## 调用流程（整合进主 SKILL.md 的 Step 1-4）

### 新增 Step 1.5：历史模式匹配（在问题分类之后）

对于以下类型的问题，在 Step 1 分类后、Step 2 三角验证前，增加一个历史模式检索：

| 问题类型 | 历史模块调用 |
|----------|------------|
| 「伊朗为什么不接受 X 条件」 | → qajar_dynasty.yaml（主权创伤）+ mosaddegh.yaml |
| 「Mojtaba 的权力会稳固吗」 | → imperial-cycle.md 阶段三 + darius_i.yaml（篡位者叙事重构） |
| 「伊朗会不会投降/屈服」 | → khomeini.yaml（「喝毒酒」）+ shahnameh-psychology.md（Rostam 原型）|
| 「IRGC 会不会分裂」 | → shah_abbas_i.yaml（ghulam→IRGC 类比）+ nader_reza_strongmen.yaml |
| 「施压能不能改变伊朗行为」 | → historical-pattern-matrix.md 矩阵二（主权创伤递归）|
| 「长期走向如何」 | → imperial-cycle.md（六阶段模型）|

### Step 2 升级：四角验证（加入历史维度）

在原有的三角验证（美方/伊朗/第三方）之上，加入第四角：

1. **美方叙事**（RAND / CSIS / 华盛顿研究所）
2. **伊朗/区域叙事**（Iran International波斯语 / Al Jazeera / 伊朗官方）
3. **第三方叙事**（ICG / Oxford Economics / 华黎明 / Trenin）
4. **历史模式验证**（/history/ 模块）← **新增**

历史模式验证的作用是回答：**当前场景在伊朗历史中有没有先例？如果有，结果是什么？**

---

## YAML 格式说明

历史领导人 YAML 与 /decisionmakers/ 的格式有以下区别：

| 字段 | /decisionmakers/ | /history/leaders/ |
|------|-----------------|-------------------|
| `known_triggers` | 当前可验证的触发-反应对 | 历史记录的触发-反应对 |
| `red_lines` | 当前红线 | 历史红线 |
| `evidence_quality` | ★★★ 到 ☆☆☆ | 主要为 ★☆☆-★★☆（历史类比） |
| **`contemporary_mapping`** | 无 | **核心字段：历史→当代映射** |
| **`mental_model`** | 由 `decision_style` 代替 | **核心字段：心智模型的深层逻辑** |
| **`strategic_blind_spots`** | 由 `key_unknowns` 代替 | **核心字段：历史教训** |

---

## 诚实边界（适用于整个 /history/ 模块）

1. **所有历史→当代映射都是类比推理**，不是因果关系。类比的价值在于启发，风险在于过度简化。
2. **文化心理变量无法量化**——它与结构性变量的交互方式未知。不要给出数值权重。
3. **主要基于英文学术来源**——波斯语/阿拉伯语一手资料的补充仍是优先级。
4. **不同社会阶层对历史的感知不同**——城市知识分子 vs 农村民众 vs IRGC 军人。
5. **不要把波斯文化本质化**——避免「波斯人天生如此」的错误。
6. **历史模块不预测具体事件**——它提供「为什么」和「在什么框架下思考」，不提供「何时」。

---

## 主 SKILL.md 需要修改的位置

以下是将 /history/ 整合进主 SKILL.md 所需的具体修改清单：

### 修改 1：模块架构图（第三节）

在现有架构末尾添加：
```
└── /history/                   ← 模块四：2500年波斯帝国历史心智模型库
    ├── /leaders/               ← 7个历史领导人YAML
    ├── /frameworks/            ← 3个历史分析框架
    └── READING_LIST.md         ← 29本推荐书目
```

### 修改 2：模块功能说明（第三节）

添加：
- 模块四（/history/）回答：**为什么他们这样想——2500年帝国经验如何塑造当代决策心理**

### 修改 3：调用流程（第四节）

在 Step 1 和 Step 2 之间添加 Step 1.5（历史模式匹配）
在 Step 2 中将「三角验证」升级为「四角验证」

### 修改 4：文件索引（第六节）

添加 /history/ 的完整文件清单

### 修改 5：当前战场快照

无需修改——/history/ 不包含实时数据

### 修改 6：总文件数

从约 83 个更新为约 93 个
