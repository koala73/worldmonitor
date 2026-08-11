# Phase 6 海运物流、AIS 与供应链证据

日期：2026-08-11
分支：`integration/pokieticker-maritime-china-factory`
实现提交：`d361ee8a48e449f73be916e3a6a992cb66c9f8be`

## 已交付的原生功能

- 新增受本地路由拥有的 `/maritime-logistics` 工作区，并从主市场面板提供“海运物流”入口；没有嵌入任何上游网页或 iframe。
- 工作区默认聚焦苏伊士，并可切换苏伊士、巴拿马、马六甲、霍尔木兹、曼德海峡和多佛。每一个可选区域都被限制为不大于 10 度的经纬边界；切换霍尔木兹后浏览器 URL 为 `/maritime-logistics?focus=hormuz`，标题为“霍尔木兹海峡 · AIS 船位”。
- 仅当 Maritime v1 返回同时具备九位 MMSI、有限经纬度、正观测时间且位于当前边界内的报告时，前端才显示船位点。相同 MMSI 只保留最新报告，最多显示 250 条。无效 MMSI、过期/缺少时间、边界外报告和全局固定船列一律拒绝。
- 在当前没有经授权的 AIS relay 快照时，界面显示“未收到可验证 AIS 快照”，船位数为零；不会创造随机船只、航线、ETA、目的港、吃水、货物、产地、买方、最终卸货港或提单事实。
- PortWatch/供应链状态、官方通航告警和 Shipping v2 航线智能被分成独立面板。无响应时显示不可用而不是零；航线智能明确标为模型/登记册估计，绝不等同于实际船舶轨迹或货物事实。
- `.maritime-logistics-workspace` 拥有 `height: 100vh` 和 `overflow-y: auto`，修复仪表板外壳禁止文档滚动时的页面纵向滚动问题。

## 真实性边界

AIS 报文可支持的仅是其接收到的自报字段：MMSI、名称（若提供）、船型（若提供）、位置、速度、航向、航迹向和报文时间。它不能证明货物、原产地、买方、价值、最终卸货港或提单。现有 Maritime v1 契约不返回 IMO、目的港、ETA 或吃水；界面明确写为“当前契约未提供”，不做猜测。

本阶段未收到 `AISSTREAM_API_KEY`、`WS_RELAY_URL` 或 relay 共享鉴权配置，也未把任何浏览器值称作实时 AIS。截图是受控的无 Provider 降级验收，不是 live ship-tracking 验收。

## 浏览器验收

| 检查 | 真实观测 | 结果 |
|---|---|---|
| 路由和入口 | 在 1440x900 本地页面打开 `/maritime-logistics?focus=suez`，原生工作区存在 | PASS |
| 无 Provider 降级 | `vesselDots=0`，页面包含“未收到可验证 AIS 快照”和货物边界说明 | PASS |
| 没有合成船只 | `.maritime-logistics-vessel-dot` 为 0；没有静态/随机船列 | PASS |
| 垂直滚动 | `overflowY=auto`，`scrollHeight=1404`，`clientHeight=900`；真实滚轮后 `scrollTop=504`（底部） | PASS |
| 焦点切换 | 点击“霍尔木兹海峡”后 URL、面板标题与边界同步 | PASS |
| 移动视口截图 | 本轮 Browser 会话没有提供可变视口 capability；未把桌面截图伪称移动验收 | NOT CLAIMED |

截图：

- `phase6-maritime-logistics-no-provider-1440x900.png`
- `phase6-maritime-logistics-hormuz-scroll-bottom-1440x900.png`

## 自动化门禁

精确命令、退出码和环境级重试记录在 `phase6-command-log.md`。所有与本阶段代码相关的测试、类型、契约、归因、DOM、lint、relay 健康和最终生产构建均通过。全仓 lint 仍有 33 个既有 warning、9 个 info，但退出码为 0，且本阶段 scoped Biome 为 0。

## 可复现的实际数据验收

若未来由用户在服务器/平台 secret store 中配置授权 Provider，应先在 relay 配置 `AISSTREAM_API_KEY`，将服务端 `WS_RELAY_URL` 指向该 relay，并配置 server-to-relay 鉴权。随后在至少两个不同焦点边界中捕获：原始 Provider/relay 身份、请求边界、接收/观测时间、延迟/过期状态、真实 MMSI 去重结果和截图。不得将密钥、Cookie、CAPTCHA 或购买信息写入聊天、Git、截图或本文件。
