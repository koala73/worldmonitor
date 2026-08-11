# Phase 9 — 命令与退出码记录

工作树：`D:\global-intelligence-earth\worldmonitor-upstream-integration-lf`
分支：`integration/pokieticker-maritime-china-factory`
实施提交：`b9276fab8c592a6942f7e25fbc0e7eb6667517bd`

| 顺序 | 命令/操作 | 退出码或结果 |
|---:|---|---|
| 1 | `node --import tsx --test tests/provider-operations.test.mts` | 0；5 tests passed |
| 2 | `npm run typecheck:all` | 0 |
| 3 | `node --test --test-name-pattern "(SELF_HOSTED_MODE|Docker mode)" src-tauri/sidecar/local-api-server.test.mjs` | 0；4 tests passed |
| 4 | Phase 9 变更路径的 `biome lint` | 0；旧 sidecar 1 warning / 1 info |
| 5 | 应用浏览器打开 `http://127.0.0.1:4185/provider-operations` | 原生页面、九卡、可滚动；保存默认状态截图 |
| 6 | 浏览器点击股票 REST 卡安全重试 | 显示 `SERVER_MANAGED_UNKNOWN`，无 Provider 请求；保存 fail-closed 截图 |
| 7 | `npm run lint:api-contract` | 0；149/114/96 |
| 8 | `npm run sources:check` | 0；533 active hosts |
| 9 | `npm run test:dom` | 0；31 files / 293 tests |
| 10 | `npm run lint`（仅补 Node PATH） | 1；Biome 完成，嵌套 `npm` 找不到；不是 lint 规则失败 |
| 11 | `npm run lint`（Node + npm CLI PATH） | 0；33 warnings / 9 infos 为既有，Safe HTML passed |
| 12 | 发现多模型/新闻 Provider 的凭据应为可替代组合，补充 Groq-only 回归测试后重跑门禁 | 代码修正；未改变 Provider 真值边界 |
| 13 | `node --import tsx --test tests/provider-operations.test.mts`（最终） | 0；5 tests passed |
| 14 | `npm run typecheck:all && npm run test:dom && npm run lint:api-contract && npm run sources:check`（最终） | 全部 0；DOM 31/293，API 149/114/96，source 533 |
| 15 | `npm run lint`（Node + npm CLI PATH，最终） | 0；33 warnings / 9 infos 为既有，Safe HTML passed |
| 16 | `npm run build:full`（Node + npm CLI PATH，最终） | 0；45.2 秒，PWA 254 entries |

构建只报告既有动态导入、空 chunk 和大 chunk 提示；没有 TypeScript、API 合约、来源
清单、DOM、Safe HTML 或生产构建失败。
