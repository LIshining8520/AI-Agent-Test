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

打开 Vite 输出的本地地址即可。页面内置了一个
“意图分类 → 条件路由 → 生成回复”工作流演示：

- `src/graph/workflow.ts`：LangGraph 图定义（`StateGraph`、`Annotation.Root`、
  `addConditionalEdges`、`stream` / `invoke`）
- `src/App.tsx`：React 组件，用 `streamMode: "updates"` 逐节点渲染执行过程

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
