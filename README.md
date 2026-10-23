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

### 国内访问（`*.vercel.app` 打不开）

`*.vercel.app` 在中国大陆被 DNS 污染，打不开/极慢是常态，**与代码无关**。
三条路，官方限制已核实（2026-09）：

| 方案 | 国内可达 | 是否备案 | 成本 | 见效 |
|---|---|---|---|---|
| Vercel + 自有域名 | 能，速度一般 | ❌ 不需要 | 域名约 ¥10-15/年 | 分钟级 |
| 腾讯云 EdgeOne Makers | 快（国内节点） | ✅ 必须 | 免费额度充足 | 备案 1-3 周 |
| Zeabur（`*.zeabur.app`） | 能 | ❌ 不需要 | 免费额度 $5/月 | 半小时 |

> ⚠️ EdgeOne 的**默认域名在大陆只能用 3 小时有效的预览链接**（过期 401），
> 官方明确「默认域名只适合自己看，不能拿去分享」。要稳定访问必须绑自定义域名，
> 而绑域名 + 用国内节点 = **必须 ICP 备案**。所以「免备案 + 国内高速」无解，
> 二选一。

**Vercel 绑自有域名（推荐，免备案）**

1. 买域名（腾讯云/阿里云，`.top` `.xyz` 等冷门后缀首年十几元；**务必先完成实名认证**，
   未认证域名会被 ServerHold，解析不生效）
2. Vercel → Project → Settings → **Domains** → 添加 `example.com` 与 `www.example.com`
3. 按面板给出的记录到域名商配 DNS（**以面板显示为准**）：
   - 根域名：`A` → Vercel 提供的 IP（常见 `76.76.21.21`）
   - `www`：`CNAME` → `cname.vercel-dns.com`
4. 回 Vercel 点 Verify，等自动签发 HTTPS 证书（1-5 分钟）

注意：**不要在域名商那边开 CDN/代理加速**，否则回源绕到国内节点又触发备案要求；
DNS 在国内注册商托管、解析指向境外 IP，本身**不需要备案**（备案针对的是网站接入
国内服务器/国内 CDN）。

### 景点配图（`/api/image`）

行程子链会给每个**景点**附上 `imageUrl`，前端懒加载显示缩略图。图片走本站代理
`GET /api/image?q=浅草寺&w=360`，不直接引用图床，原因有三个：

1. Wikimedia 的域名在境内访问不稳定，走自己的域名能把图和页面一起送达；
2. 三级回退与缓存放在服务端，换图源时前端一行都不用改；
3. 将来若换成需要 Key 的图源，Key 也不会进前端产物。

解析顺序：**Wikipedia REST 摘要**（一次请求，最快）→ **Wikidata P18**（跨语言命中率高）
→ **Commons 文件搜索**（兜底）。命中缓存 12 小时，未命中只缓存 10 分钟，
避免一次网络抖动把某个景点永久判成"没图"。查不到图时前端渲染文字占位块，不留破图标。

> ⚠️ 本地 `vite dev` / `vite preview` 不会提供 `/api/image`，缩略图会退化成文字块。
> 想看真实效果，部署到 Vercel，或自己起一个挂着 `api/image.ts` 的静态服务。

## 常用命令

```bash
npm run dev      # 本地开发
npm run build    # 类型检查 + 构建
npm run preview  # 预览构建产物
npm run lint     # oxlint 检查
```
