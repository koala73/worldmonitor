# Phase 6 命令、退出码与重试记录

日期：2026-08-11
工作目录：`D:\global-intelligence-earth\worldmonitor-upstream-integration-lf`

| 命令或动作 | 退出码 | 结果 |
|---|---:|---|
| `npm run typecheck:all` | 0 | TypeScript 全量检查通过。 |
| `node --import tsx --test tests/maritime-logistics-route.test.mts tests/stock-workspace-route.test.mts tests/stock-news-evidence.test.mts` | 0 | 7/7 通过。 |
| `biome lint`（Phase 6 路由、界面、入口和测试的 scoped 集合） | 0 | 通过。 |
| `node --test tests/ais-relay-health-no-secret-recon.test.mjs tests/ais-relay-reconnect-health.test.mjs` | 0 | 20/20 通过；无密钥时 relay 健康路径不重连泄密。 |
| `npm run test:dom` | 0 | 31 个文件、293 个测试通过。 |
| `npm run lint:api-contract` | 0 | 149 个 API 文件、114 个 manifest 条目、96 个 query 参数通过。 |
| `npm run sources:check` | 0 | 533 个 active hosts 归因检查通过。 |
| `node --import tsx --test tests/shipping-v2-handler.test.mjs tests/portwatch-upstream.test.mjs` | 0 | 61/61 通过。首次用裸 `node --test` 无法解析 TypeScript 扩展，不计为代码失败；按项目既有 `tsx` loader 重跑后全绿。 |
| `npm run lint` | 0 | 3308 文件检查完成；33 warning、9 info 为既有基线，Safe HTML guard 通过。 |
| `npm run build:full`（直接命令） | 未记录最终退出码 | 生产构建超过单次命令通道 60 秒上限，被工具中断；只观察到 Vite 产物尾段，未计为通过。 |
| 后台 `phase6-build-gate.cmd` 第一次 | 1 | 包装器没有为嵌套 npm 子命令传递 PATH；日志保留为环境级失败记录，未计为代码失败或通过。 |
| 修正 PATH 后后台 `phase6-build-gate.cmd` | 0 | `security:vite-env-secrets --strict-local`、OpenAPI、agent skills、blog、crawlable corpus、sitemap、`tsc`、Vite 和 PWA 生产构建完成。Vite 动态导入/大 chunk 警告存在，但没有错误。 |
| 浏览器实际滚动与焦点切换 | 通过 | 1440x900：工作区从 0 滚至 504，霍尔木兹焦点 URL/标题同步；无 Provider 时船位点为零。 |

后台最终生产构建的 stdout、stderr 和 exit-code 文件保存在本目录，文件名前缀为 `phase6-build-full-gate2`。第一次 PATH 失败的 `phase6-build-full-gate` 输出也被保留以便审计。它们不含 Provider 密钥。
