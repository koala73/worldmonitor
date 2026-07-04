# 实时情报简报协议
# Auto-Brief Protocol for Iran.skill

**版本**：1.0 | **功能**：定义每次调用 Skill 时的实时情报搜集和整合流程

---

## 触发条件

当用户提问涉及伊朗局势时，**在调用任何 Skill 文件之前**，先执行以下搜索序列。

---

## 优先调用 World Monitor API 数据源 (Preferred API Integrations)

在执行外部搜索引擎检索之前，如果具备 API 访问权限，建议优先通过 World Monitor 的内置 API 接口直接读取实时指标以填充 Watchlist：

1. **霍尔木兹通行状态 (Strait of Hormuz transit)**
   - API: `GET https://worldmonitor.app/api/supply-chain/hormuz-tracker`
   - 说明: 返回霍尔木兹海峡最新的封锁状态（如 "open", "closed", "disrupted"）以及油船与货船流量序列。

2. **布伦特油价 (Brent Oil Price)**
   - API: `GET https://worldmonitor.app/api/economic/oil-prices`
   - 说明: 提取 Brent 与 WTI 的最新实时报价及变化幅度。

3. **伊朗核浓缩与停火事件 (Ceasefire & Uranium Enrichment)**
   - API: `GET https://api.worldmonitor.app/api/intelligence/v1/get-country-intel-brief?country_code=IR`
   - 说明: 直接拉取 World Monitor 为伊朗生成的最新 AI 战略情报简报与冲突数据源。

---

## 标准搜索序列（5 次搜索，<30 秒）

### 搜索 1：停火/谈判状态
```
查询：Iran US ceasefire negotiations [当前月份] [当前年份]
目标：停火是否有效？新一轮谈判？任何一方的新声明？
```

### 搜索 2：霍尔木兹/封锁状态
```
查询：Strait of Hormuz shipping blockade Iran [当前月份]
目标：每日通行船数 vs 基线(60-70)？封锁执行力度？油价？
```

### 搜索 3：核浓缩/IAEA
```
查询：Iran uranium enrichment IAEA latest [当前年份]
目标：最新浓缩丰度？IAEA 访问权限变化？新报告？
```

### 搜索 4：Mojtaba/IRGC 信号
```
查询：Mojtaba Khamenei IRGC statement [当前月份]
目标：任何公开表态？IRGC 人事变动？内部分裂信号？
```

### 搜索 5：区域动态
```
查询：Israel Lebanon Hezbollah Iran [当前月份] [当前年份]
目标：黎巴嫩前线？代理人动态？以色列单独行动？
```

---

## 搜索结果整合模板

搜索完成后，按以下模板输出「Watchlist 刷新」：

```markdown
### Watchlist 刷新（[日期]）

| 变量 | Skill 缓存值 | 实时更新 | 变化方向 |
|------|-------------|---------|---------|
| 停火状态 | [上次值] | [新值 + 来源] | ↑/↓/→ |
| 霍尔木兹通行 | [上次值] | [新值] | ↑/↓/→ |
| Brent 油价 | [上次值] | [新值] | ↑/↓/→ |
| 浓缩丰度 | [上次值] | [新值] | ↑/↓/→ |
| Mojtaba 表态 | [上次值] | [新值] | ↑/↓/→ |

### 概率微调（如果新信息改变了场景概率）

| 场景 | 缓存概率 | 修正概率 | 理由 |
|------|---------|---------|------|
| ... | ... | ... | ... |
```

---

## 深度搜索（按需触发）

当标准搜索发现以下情况时，执行额外搜索：

| 触发条件 | 额外搜索 |
|----------|---------|
| 停火到期/破裂 | 搜索双方军事部署变化 |
| 浓缩丰度 >75% | 搜索 IAEA 最新报告全文 + Albright/Lewis 评论 |
| IRGC 人事变动 | 搜索波斯语媒体（Iran International） |
| 油价 >$110 | 搜索 Oxford Economics / IEA 影响评估 |
| Mojtaba 罕见表态 | 搜索完整原文 + 多方解读 |
| Trump 政策转向信号 | 搜索白宫声明 + Axios/Politico 幕僚泄露 |

---

## 与 Skill 框架的整合

搜索结果不是独立输出——必须与 Skill 框架交叉验证：

1. **新事件** → 在 escalation-ladder.md 上定位（当前第几级？）
2. **新声明** → 在 decisionmakers/*.yaml 的 `known_triggers` 中检索匹配
3. **新数据** → 在 scenarios/scenario-tree.md 的分支条件中检查是否触发新分支
4. **新矛盾** → 在 bias-check/narrative-matrix.md 中做三方验证
5. **历史既视感** → 在 /history/ 中检索是否匹配已知模式

---

## 输出格式建议

**快速简报**（用户说「最新情况」/「更新一下」）：
→ Watchlist 刷新表 + 1-2 句关键判断

**深度分析**（用户问具体问题）：
→ 搜索 → Watchlist 刷新 → 框架分析 → 历史模式检查 → 偏差检查 → 结论

**每周综述**（用户说「这周总结」）：
→ 5 次标准搜索 + 场景概率全面更新 + 关键信号追踪

---

## 限制声明

1. 本协议依赖 web search 工具——搜索结果的质量和时效性受搜索引擎限制
2. 波斯语/阿拉伯语/希伯来语一手来源存在 2-6 小时翻译滞后
3. 战时信息操控严重——所有搜索结果必须经过 bias-check 三角验证
4. 本协议不能「自动运行」——需要用户触发对话才能执行
