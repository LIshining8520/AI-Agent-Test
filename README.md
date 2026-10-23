# AI-Agent（React × LangGraph）

一个同时支持 **React 19** 与 **LangGraph.js（TypeScript）** 的前端项目，
基于 Vite 8 模板初始化。

## 技术栈

- React 19 + TypeScript
- Vite 8
- `@langchain/langgraph` 1.4.x（LangGraph.js，浏览器端可直接运行）
- `@langchain/core` 1.x（LangChain 基础类型与工具）

## 快速开始

```bash
npm install
npm run dev
```

打开 Vite 输出的本地地址即可。顶部有两个 Tab：

### Tab 1 · 旅游多 Agent（课 9-12，默认）

移植自 `projects-v4-ts-9-12`（Node / pnpm workspace），按课程大纲把
**画像契约 → 解析管线 → 三子链并行 → 收口质检** 这条动线接进本工程：

```
START → parse ─┬─(必填缺失)───────────────────────────→ END
                └─(ready) → dispatch ─┬→ routeWorker ───┐
                                      ├→ itineraryWorker ┼→ arbitrate → END
                                      └→ budgetWorker ───┘
```

- `src/travel/graph/travel-graph.ts`：LangGraph 编排（fan-out 三链并行 / fan-in 收口）
- `src/travel/ui/TravelPlannerPage.tsx`：画像面板、三链卡片、5 项质检、成本归因
- 章节与代码的逐条映射、以及和源工程的差异，见 **`src/travel/README.md`**
- 没配 Key 时自动进入「规则兜底模式」（页面右上角标注），三链照样出产物

三句内置示例分别演示：正常画像 / 缺必填（待澄清，不空跑算力）/ 字段冲突（入口拦下）。

### Tab 2 · 天气助手

“意图分类 → 条件路由 → 生成回复”工作流演示：

- `src/graph/workflow.ts`：LangGraph 图定义（`StateGraph`、`Annotation.Root`、
  `addConditionalEdges`、`stream` / `invoke`）
- `src/pages/WeatherPage.tsx`：React 组件，用 `streamMode: "updates"` 逐节点渲染执行过程

## 接入真实 LLM 节点

项目已接入 `@langchain/openai`。浏览器端没有 `process.env`，Vite 通过
`import.meta.env` 注入 `.env` 中 **`VITE_` 开头** 的变量：

```bash
cp .env.example .env   # 然后在 .env 里填入真实 Key
```

`src/graph/workflow.ts` 会优先使用 DeepSeek 的结构化输出判断输入是否为代码 bug；
没有 Key 时自动退回本地规则匹配（Mock 模式），页面依然可用。

> ⚠️ 安全提示：`VITE_` 变量会打进前端产物，任何访问页面的人都能看到，
> 所以只适合本地开发。部署到公网时请把 Key 放在后端，通过代理转发请求。
> 之前出现在对话或示例文件里的 Key 建议尽快在对应平台吊销并重新生成。

## 常用命令

```bash
npm run dev      # 本地开发
npm run build    # 类型检查 + 构建
npm run preview  # 预览构建产物
npm run lint     # oxlint 检查
```
