# Phase 9 — Provider 统一控制中心验收证据

**实施日期：** 2026-08-11
**实施提交：** `b9276fab8c592a6942f7e25fbc0e7eb6667517bd`
(`feat(ops): add truthful provider control center`)

## 已交付的本地功能

- 新增拥有式、非 iframe 的 `/provider-operations` 全屏工作区；Market 面板有
  原生 `Provider 控制中心` 入口。
- `src/services/provider-operations.ts` 定义九类受控操作：股票 REST 缺口修复、
  分钟 K 线流/REST 补缺、公司新闻增量、新闻 Layer 1、AIS relay、PortWatch、
  Comtrade、中国海关合规导入和模型评估。每一项有 cadence、幂等键域、锁域、最小
  重试间隔和真实性边界。
- 操作面显示配置就绪度、注册执行器状态、执行器成功/失败、连续失败、速率限制、
  quota、队列/死信、AIS 消息/验证后船舶数等字段；当前没有实际可观察值时显示
  `未观测`，而非零或样例数据。
- “安全重试 / 重新检查”默认严格 fail-closed：没有已注册、受保护执行器时不发出
  Provider 请求，并写入会话审计事件。调度器回调完成与 Provider 成功被单独记录，
  所以前者不会伪造来源成功。
- `SELF_HOSTED_MODE=true` 令 sidecar 强制关闭到
  `api.worldmonitor.app` 的 cloud fallback；既有全局 `LOCAL_API_TOKEN` 门禁仍为
  本地管理接口的默认拒绝认证。默认部署未设置此变量时保持原有权限/回退路径。

## 浏览器验收

本地开发服务 `http://127.0.0.1:4185/provider-operations` 在 1280×720 的应用
浏览器中实际检查：

1. 页面显示本地品牌、原生仪表盘/股票入口、默认部署说明和密钥边界；全部九类
   操作卡均显示 `服务器端状态不可观测`，没有 `LIVE`、已连通或样例数据声明。
2. 工作区使用自身 `height: 100vh` / `overflow-y: auto`，实际滚动后可继续看到
   新闻、AIS、PortWatch 等操作卡和每项的锁/幂等信息。
3. 点击“股票 REST 缺口修复”的 `安全重试 / 重新检查`。页面显示
   `Safe retry not executed: readiness is SERVER_MANAGED_UNKNOWN.`；该结果是
   `NOT_CONFIGURED` 的本地审计状态，未调用 Provider，未产生市场数据。

截图：

- `phase9-provider-operations-default-1280x720.png`
- `phase9-safe-retry-no-executor-1280x720.png`

## 已执行门禁

| 命令 | 结果 |
|---|---|
| `node --import tsx --test tests/provider-operations.test.mts` | 退出 0；5/5 通过 |
| `node --test --test-name-pattern "(SELF_HOSTED_MODE|Docker mode)" src-tauri/sidecar/local-api-server.test.mjs` | 退出 0；4/4 通过 |
| `npm run typecheck:all` | 退出 0 |
| Phase 9 文件的 `biome lint` | 退出 0；仅报告 sidecar 中既有 1 warning / 1 info |
| `npm run lint:api-contract` | 退出 0；149 API 文件、114 manifest、96 参数 |
| `npm run sources:check` | 退出 0；533 active hosts |
| `npm run test:dom` | 退出 0；31 文件、293/293 |
| `npm run lint`（首次） | DOM 已通过；随后嵌套 `npm` 未在 PATH，退出 1；此为环境调用失败，保留记录 |
| `npm run lint`（补齐 npm PATH 后） | 退出 0；既有 33 warnings / 9 infos，Safe HTML 0 个 legacy sinks |
| `npm run build:full`（最终代码） | 退出 0；约 45.2 秒，PWA 254 precache 条目 |

## 严格未声明项

本阶段没有配置任何市场、AIS、PortWatch、Comtrade、中国海关或模型 Provider
凭据，也没有注册真实后台执行器。因此不声明实时/延迟 K 线、Provider health、
配额、新闻队列深度、AIS 消息/船舶数、贸易数值、模型训练完成或回测指标。控制
中心是这些事实未来进入系统时的受控、可观察接口；当前可验证状态仅是安全降级。
