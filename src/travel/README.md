# 旅游多 Agent（课 9-12）· 移植说明

来源：飞书文档《…》大纲 + 附录 A「本讲核心代码索引」，源工程 `~/Desktop/projects-v4-ts-9-12`
（`apps/lesson9-12-travel` + `packages/shared`，Node / pnpm workspace）。

本目录把**大纲涉及的那部分代码**接进 AI-Agent（Vite + React 19 + LangGraph.js），
Node 侧能力全部改造成浏览器可运行版本，其余（NestJS 宿主、SSE 通道、评测脚本、
Redis 画像存储、地图 MCP）不在大纲核心代码索引内，未移植。

## 一、大纲章节 → 代码落点

| 大纲章节 | 本仓文件 | 说明 |
|:---|:---|:---|
| 第二段 画像契约（TripProfile） | `shared/travel-types.ts` | `TripProfile` / `Companion` / 三子链产物模型 |
| 第三段 解析管线（LLM 优先、规则兜底、合并归一） | `domain/profile/profile-parser.ts` | `parse` / `tryParseViaLlm` / `ruleExtract` / `sanitize` / `mergeProfile`；额外暴露 `source` / `degradedReason` 让降级可见 |
| 第四段 冲突检测与完整度 | `shared/trip-profile.ts` | `defaultProfile` / `detectConflicts` / `profileCompleteness` / `REQUIRED_FIELDS` / `formatMissingFields` |
| 第五段 三子任务链与领域角色 | `domain/orchestration/worker-protocol.ts`、`domain/workers/*` | 执行者协议（`TravelWorker` / `WorkerResult`）+ `BaseWorker` 模板方法 + 三个执行者实现 |
| 第六段 费用统筹管家 | `domain/workers/budget-worker.ts` | `clampAllocatedToBudget` 预算钳制 + `overBudget` 以主数据估算为准 + 等价替换建议 |
| 第七段 量化验证与端到端演示 | `graph/travel-graph.ts` + `ui/TravelPlannerPage.tsx` | 收口质检 5 项（三链齐全 / 天数一致 / 逐日有内容 / 分摊守恒 / 超支守卫）+ 成本归因 + 端到端页面 |
| 第八段 收口 / 演进路线 | 本文件 + `graph/travel-graph.ts` 的 `sanitizePlan` | 「调度正确性写进代码而不是交给模型」 |

## 二、附录 A 代码索引 → 逐条对应

| # | 原工程路径 | 本仓路径 |
|:-:|:---|:---|
| 1 | `packages/shared/src/travel-types.ts`（TripProfile） | `shared/travel-types.ts` |
| 2 | 同上（RoutePlan / ItineraryPlan / BudgetPlan） | `shared/travel-types.ts` |
| 3 | `packages/shared/src/trip-profile.ts`（defaultProfile / detectConflicts / profileCompleteness） | `shared/trip-profile.ts` |
| 4 | 同上（ProfileParseResult / REQUIRED_FIELDS） | `shared/trip-profile.ts` |
| 5 | `domain/profile/profile-parser.ts` | `domain/profile/profile-parser.ts` |
| 6 | `application/profile-service.ts` | `application/profile-service.ts` |
| 7 | `domain/orchestration/worker-protocol.ts` | `domain/orchestration/worker-protocol.ts` |
| 8 | `domain/workers/worker.ts` | `domain/workers/worker.ts` |
| 9 | `domain/workers/route-worker.ts` / `itinerary-worker.ts` | `domain/workers/route-worker.ts` / `itinerary-worker.ts` |
| 10 | `domain/workers/budget-worker.ts` | `domain/workers/budget-worker.ts` |
| 11 | `domain/travel/travel-knowledge.ts` | `domain/travel-knowledge.ts` |
| 12 | `infrastructure/llm/http-llm-client.ts` | `infrastructure/http-llm-client.ts` |
| 13 | `config/env.ts` | `config/env.ts`（`process.env` → `import.meta.env`） |

## 三、编排层为什么换成 LangGraph

原工程保留命令式 `Supervisor`（`Promise.allSettled`）与 `GraphEngine` 双实现。
本仓是 LangGraph 项目，只保留图这一条路，但**结构完全一致**：

```
START → parse ─┬─(必填缺失)──────────────────────────→ END
                └─(ready) → dispatch ─┬→ routeWorker ───┐
                                      ├→ itineraryWorker ┼→ arbitrate → END
                                      └→ budgetWorker ───┘
```

- `dispatch` 的三条计划由 `sanitizePlan` 依据画像确定性生成 → 「三子链必被调度」是代码不变式；
- 三条边同出 `dispatch`，LangGraph 放进同一 superstep 并行；
- `usage` 用键合并 reducer、`errors` / `checks` 用 concat —— 并行写同一通道不互相覆盖。

## 四、与源工程的差异（如实记录）

| 项 | 源工程 | 本仓 | 原因 |
|:---|:---|:---|:---|
| 运行环境 | Node 22 + pnpm workspace | 浏览器（Vite） | 目标工程是前端项目 |
| 包引用 | `@v4-course/travel-shared` | 相对路径 `shared/*` | 单包工程，无 workspace |
| 环境变量 | `process.env` + zod | `import.meta.env` + 同款 zod 校验 | 浏览器无 `process.env` |
| `thinking` 字段 | 始终下发 | 先下发，400/422 自动去掉重试 | 兼容不同 OpenAI 兼容端点的支持度差异 |
| 强类型写法 | `constructor(private x)` | 显式字段 | 本仓 `erasableSyntaxOnly: true` 禁止参数属性 |
| NestJS / SSE / 评测脚本 / Redis / 地图 MCP | 有 | 无 | 不在大纲核心代码索引内 |
| `detectConflicts` | `days<=0` / `budget<=0` 也报冲突 | 缺失归 `missing`，只在 `days>30` 与「预算 × 住宿档」矛盾时报冲突 | 原版会把「没提天数」误报成「天数不合法: 0」，澄清话术自相矛盾 |
| `ruleExtract` | 目的地 / 天数 / 预算 + 美食 / 科技 | 追加 兴趣 / 住宿档 / 节奏 / 同行人 | 无 Key 时第 4 段的「预算低却要豪华」冲突检不出来，演示等于失效 |
| 强制兜底 | `error: 'fallback(forced)'` | 不记 error（`source: 'fallback'` 已足够） | 兜底是预期路径，不该在收口里算成「异常 3 条」 |

## 五、跑起来

```bash
npm run dev          # 页面默认在「旅游多 Agent」Tab
```

`.env` 里配 `VITE_DEEPSEEK_API_KEY` 走真实模型；不配则自动进入**规则兜底模式**
（页面右上角会标出来），三子链照样出产物，只是 `source` 全部是 `fallback`。
