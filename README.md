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

> ⚠️ 安全提示：`VITE_` 变量会在构建时被**字符串内联**进 `dist/assets/*.js`，
> 任何人 F12 搜 `sk-` 就能抄走。所以本地开发可以直连，**线上必须走下面的代理**。

## 部署到线上（Vercel）

线上用一层 Serverless 函数把 Key 挡在服务端，前端只调同源 `/api/llm`：

```
浏览器 ──POST /api/llm/chat/completions──▶ api/llm/chat/completions.ts ──Bearer Key──▶ api.deepseek.com
```

**1. 平台侧环境变量（Vercel → Settings → Environment Variables）**

| 变量 | 是否必填 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | ✅ 必填 | 真正的 Key。**注意没有 `VITE_` 前缀** |
| `DEEPSEEK_BASE_URL` | 可选 | 默认 `https://api.deepseek.com/v1` |
| `LLM_ALLOWED_MODELS` | 可选 | 模型白名单，逗号分隔 |
| `VITE_DEEPSEEK_API_KEY` | ❌ **千万不要配** | 一配就会被打进前端产物 |

前端会自动进入代理模式：生产构建且没有 `VITE_DEEPSEEK_API_KEY` 时即走 `/api/llm`。
需要强制指定时用 `VITE_LLM_PROXY=1`（强制开）/ `VITE_LLM_PROXY=0`（强制关）。

**2. 部署**

```bash
npx vercel            # 首次会引导登录与关联项目
npx vercel --prod     # 发布到生产环境
```

或在 Vercel 控制台导入 Git 仓库，框架预设选 **Vite**，构建命令 `npm run build`，
输出目录 `dist`（`vercel.json` 已写好，一般无需手动填）。

**3. 验证 Key 没漏**

```bash
npm run build && grep -ro "sk-[a-zA-Z0-9]\{20,\}" dist/ || echo "干净：产物里没有 Key"
```

代理函数自带三道护栏：模型白名单、`max_tokens` 钳到 8192、单 IP 30 次/分钟限流
（内存级，仅对同一函数实例生效）。要应对真实流量，建议在 Vercel 侧再叠加
Firewall / 限流规则。

## 常用命令

```bash
npm run dev      # 本地开发
npm run build    # 类型检查 + 构建
npm run preview  # 预览构建产物
npm run lint     # oxlint 检查
```
