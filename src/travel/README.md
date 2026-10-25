# 旅游多 Agent（课 9-12）· 移植说明

来源：飞书讲义《…》正文 + 附录 A「本讲核心代码索引」，代码包 `projects-v2-9-12-261025`
（`apps/lesson9-12-travel` full 版 + `packages/shared`，Node / pnpm workspace）。

本目录把**讲义涉及的那部分代码**接进 AI-Agent（Vite + React 19 + LangGraph.js），
Node 侧能力全部改造成浏览器可运行版本；其余（NestJS 宿主、SSE 通道、评测脚本、
Redis 画像存储、真实地图 MCP）不在大纲核心代码索引内，未移植。

## 一、大纲章节 → 代码落点

| 大纲章节 | 本仓文件 | 说明 |
|:---|:---|:---|
| 第二段 画像契约（TripProfile） | `shared/travel-types.ts` | `TripProfile` / `Companion` / 三子链产物模型 |
| 第三段 解析管线（LLM 优先、规则兜底、合并归一） | `domain/profile/profile-parser.ts` | `parse` / `tryParseViaLlm` / `ruleExtract` / `sanitize` / `mergeProfile`；额外暴露 `source` / `degradedReason` 让降级可见 |
| 第四段 冲突检测与完整度 | `shared/trip-profile.ts` | `defaultProfile` / `detectConflicts` / `profileCompleteness` / `REQUIRED_FIELDS` / `formatMissingFields` |
| 第五段 三子任务链与领域角色 | `domain/orchestration/worker-protocol.ts`、`domain/workers/*` | 执行者协议（`TravelWorker` / `WorkerResult`）+ `BaseWorker` 模板方法 + 三个执行者实现 |
| 第六段 费用统筹管家 | `domain/workers/budget-worker.ts` | `clampAllocatedToBudget` 预算钳制 + `overBudget` 以主数据估算为准 + 等价替换建议 |
| 第七段 量化验证与端到端演示 | `graph/travel-graph.ts` + `ui/TravelPlannerPage.tsx` | 收口质检 6 项（三链齐全 / 天数一致 / 逐日有内容 / 分摊守恒 / 超支守卫 / 大交通计入预算）+ 成本归因 + 端到端页面 |
| 第八段 收口 / 演进路线 | 本文件 + `graph/travel-graph.ts` | 「调度正确性写进代码而不是交给模型」 |

## 二、课 11/12 增量（本次合并的部分）

讲义 8.4「本课相对 basic 的增量」五条 → 本仓落点：

| 增量能力 | 原工程文件 | 本仓文件 | 落点说明 |
|:---|:---|:---|:---|
| 角色边界（三份 verify + 写权限表） | `domain/workers/{worker,route,itinerary,budget}-worker.ts` | 同名文件 | `MAX_ATTEMPTS=2` 有界循环：生成 → 自检 → 带反馈重生成；`verify` 顺带回写 facts |
| 共享事实（黑板） | `domain/collab/plan-board.ts` | `domain/collab/plan-board.ts` | `PlanBoard` / `WRITE_PERMISSION` / `summaryFor` / 冲突留痕；事实注入点放在 `BaseWorker` 的 user 尾部 |
| 收敛重派 | `domain/safety/{itinerary-quality,convergence}.ts`、`domain/orchestration/{supervisor,graph-engine}.ts` | `domain/safety/*` + `graph/travel-graph.ts` 的 `convergeGate` 节点 | 四维判定 → 只重派被点名角色；拓扑仍是 DAG（重派在节点内部有界循环） |
| 工具自主 | `domain/tools/{map-tool,tool-aware-route-worker}.ts` | 同名文件 + `mock-map-tool.ts` | 能力契约与实现解耦；`verify` 用地图复核最长一段，工具失败不判产物有错 |
| 成本可控（轮次读数） | `domain/orchestration/graph-engine.ts` 的 `rounds/converged/revisions` | `graph/travel-graph.ts` 同名状态通道 + 页面「⑥ 收敛门」面板 | `maxRounds` 由 `VITE_TRAVEL_MAX_ROUNDS` 控制，`0` = 关闭 |

同批一并接进来的、讲义索引里列出的辅助件：

| 原路径 | 本仓路径 | 用途 |
|:---|:---|:---|
| `domain/tools/skill-registry.ts` | 同名 | Skills 渐进加载 + 最保守口径的 token 降幅测量（**未接线**，只在导出层可用） |
| `domain/tools/sub-agent.ts` | 同名 | 景点推荐 SubAgent：嵌套 LangGraph 子图 + 递归下钻双守卫 |
| `humanloop/hitl.ts` | 同名 | 关键决策暂停 + 修订并入画像 + 受影响角色重执行 |

## 三、附录 A 代码索引 → 逐条对应

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
| 9 | `domain/workers/route-worker.ts` / `itinerary-worker.ts` | 同名 |
| 10 | `domain/workers/budget-worker.ts` | `domain/workers/budget-worker.ts` |
| 11 | `domain/travel/travel-knowledge.ts` | `domain/travel-knowledge.ts` |
| 12 | `infrastructure/llm/http-llm-client.ts` | `infrastructure/http-llm-client.ts` |
| 13 | `config/env.ts` | `config/env.ts`（`process.env` → `import.meta.env`） |
| 14 | `domain/collab/plan-board.ts` | `domain/collab/plan-board.ts` |
| 15 | `domain/safety/convergence.ts` | `domain/safety/convergence.ts` |
| 16 | `domain/safety/itinerary-quality.ts` | `domain/safety/itinerary-quality.ts` |
| 17 | `domain/tools/map-tool.ts` | `domain/tools/map-tool.ts` |
| 18 | `domain/tools/tool-aware-route-worker.ts` | `domain/tools/tool-aware-route-worker.ts` |
| 19 | `domain/tools/skill-registry.ts` | `domain/tools/skill-registry.ts` |
| 20 | `domain/tools/sub-agent.ts` | `domain/tools/sub-agent.ts` |
| 21 | `humanloop/hitl.ts` | `humanloop/hitl.ts` |
| 22 | `application/assemble.ts`（装配） | `application/travel-runtime.ts`（浏览器侧等价物） |
| 23 | `domain/orchestration/supervisor.ts` / `graph-engine.ts` | `graph/travel-graph.ts`（只保留图这一条路） |
| 24 | `e2e/eval-lesson11.ts` | 未移植（Node 脚本，页面不消费） |

## 四、编排层为什么换成 LangGraph

原工程保留命令式 `Supervisor`（`Promise.allSettled`）与 `GraphEngine` 双实现。
本仓是 LangGraph 项目，只保留图这一条路，但**结构完全一致**：

```
START → parse ─┬─(必填缺失)───────────────────────────────────────→ END
                └─(ready) → dispatch ─┬→ routeWorker ────┐
                                      ├→ itineraryWorker ┼→ arbitrate → convergeGate → END
                                      └→ budgetWorker ───┘
```

- `dispatch` 的三条计划由 `sanitizePlan` 依据画像确定性生成 → 「三子链必被调度」是代码不变式；
- 三条边同出 `dispatch`，LangGraph 放进同一 superstep 并行；
- `usage` 用键合并 reducer、`errors` 用 concat、`checks`/`summary` 用覆盖 —— 并行写同一通道不互相覆盖；
- `convergeGate` 是**直线上的节点**而不是回边：回边会让同一 worker 节点被多次执行，
  累加型通道必须能区分「第几轮的同一次调用」，那是课12 reducer 的话题。
  本课用「节点内部受限重派（最多 `maxRounds` 轮）」把闭环跑通，拓扑仍是 DAG。

## 五、与源工程的差异（如实记录）

| 项 | 源工程 | 本仓 | 原因 |
|:---|:---|:---|:---|
| 运行环境 | Node 22 + pnpm workspace | 浏览器（Vite） | 目标工程是前端项目 |
| 包引用 | `@v2-course/travel-shared` | 相对路径 `shared/*` | 单包工程，无 workspace |
| 环境变量 | `process.env` + zod | `import.meta.env` + 同款 zod 校验 | 浏览器无 `process.env` |
| `thinking` 字段 | 始终下发 | 先下发，400/422 自动去掉重试 | 兼容不同 OpenAI 兼容端点的支持度差异 |
| 强类型写法 | `constructor(private x)` | 显式字段 | 本仓 `erasableSyntaxOnly: true` 禁止参数属性 |
| **工具上下文隔离** | `node:async_hooks` 的 `AsyncLocalStorage` | 随 `TravelWorkerContext.toolContext` 传值 | 浏览器无 `node:async_hooks`；语义等价且不会跨 run 串台 |
| **地图工具** | 真实地图 MCP（stdio/HTTP，可切 Mock） | 只保留确定性 Mock（`MockMapToolClient`） | 前端拉不起 MCP 进程；能力契约与调用点不变，换 adapter 即可 |
| **收敛门轮数** | CLI `--max-rounds` | `VITE_TRAVEL_MAX_ROUNDS`（默认 1，0 = 关闭） | 浏览器无命令行参数 |
| NestJS / SSE / 评测脚本 / Redis / 观测六件套 | 有 | 无 | 不在本课核心增量内（讲义 8.4 末尾把它列为「下一课」） |
| `detectConflicts` | `days<=0` / `budget<=0` 也报冲突 | 缺失归 `missing`，只在 `days>30` 与「预算 × 住宿档」矛盾时报冲突 | 原版会把「没提天数」误报成「天数不合法: 0」，澄清话术自相矛盾 |
| `ruleExtract` | 目的地 / 天数 / 预算 + 美食 / 科技 | 追加 兴趣 / 住宿档 / 节奏 / 同行人 | 无 Key 时第 4 段的「预算低却要豪华」冲突检不出来，演示等于失效 |
| 强制兜底 | `error: 'fallback(forced)'` | 不记 error（`source: 'fallback'` 已足够） | 兜底是预期路径，不该在收口里算成「异常 3 条」 |

## 六、跑起来

```bash
npm run dev          # 页面默认在「旅游多 Agent」Tab
```

`.env` 里配 `VITE_DEEPSEEK_API_KEY` 走真实模型；不配则自动进入**规则兜底模式**
（页面右上角会标出来），三子链照样出产物，只是 `source` 全部是 `fallback`。

可选开关：

| 变量 | 默认 | 作用 |
|:---|:---|:---|
| `VITE_TRAVEL_MAX_ROUNDS` | `1` | 收敛门局部重派轮数上限（首轮之外）；`0` = 关闭，退化为课10 行为 |
| `VITE_TRAVEL_MAP_TOOL` | `mock` | `off` = route 不挂地图工具（用裸 `RouteWorker`） |

### 实测记录（兜底 / Fake LLM 两条路径）

| 场景 | 观测 |
|:---|:---|
| 无 Key 兜底 | `rounds=1`、`converged=true`、黑板只有 `budgetCap`（兜底产物不自检，符合设计） |
| Fake LLM 首轮 200min 单段 | `route` 自检跑 2 轮（`attempts=2`）→ 第 2 轮 60min 通过；黑板写入 `nights=4` / `dayAnchors{1:翠湖公园}` / `budgetCap=15000`（写权限表按角色生效） |
| Fake LLM 每轮都 200min | 自检 2 轮不过 → 错误按 kind 归口 → 收敛门点名 `route` 重派（`rounds=2`、`converged=false`、`revisions=1`），`suggestions` 同时留「点名」与「未通过」两条 |

`npm run build`（`tsc -b && vite build`）通过。
