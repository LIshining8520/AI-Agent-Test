/**
 * LLM 端点解析：**本地直连** 与 **线上同源代理** 两种模式的唯一判据。
 *
 * 背景：Vite 会把 `VITE_` 前缀变量在构建时**字符串内联**进 JS 产物。
 * 只要构建环境里存在 `VITE_DEEPSEEK_API_KEY`，这个 Key 就会明文躺在
 * `dist/assets/*.js` 里，任何人 F12 都能抄走刷额度。
 *
 * 所以线上部署的正确姿势是：
 *  - 托管平台（如 Vercel）侧 **不要** 配置 `VITE_DEEPSEEK_API_KEY`；
 *  - 改用服务端环境变量 `DEEPSEEK_API_KEY`，由 `api/llm/chat/completions.ts` 注入；
 *  - 前端只调同源 `/api/llm/chat/completions`，不持有任何 Key。
 *
 * 判定规则（优先级从高到低）：
 *  1. `VITE_LLM_PROXY=1|0` 显式开关，谁配谁赢；
 *  2. 生产构建且没有前端 Key → 自动走代理（防止"忘了配就泄露"）；
 *  3. 其余情况（本地 dev、本地带 Key 构建）→ 直连。
 */

/** 同源代理路径（与服务端函数 `api/llm/chat/completions.ts` 对应） */
export const LLM_PROXY_PATH = "/api/llm";

/** 走代理时前端携带的占位 Key：服务端会丢弃它并换成真正的服务端 Key */
export const PROXY_PLACEHOLDER_KEY = "proxy-server-side-key";

type MetaEnv = Record<string, string | boolean | undefined>;

function metaEnv(): MetaEnv {
  const env = (import.meta as unknown as { env?: MetaEnv }).env;
  return env ?? {};
}

export function readViteEnv(key: string): string | undefined {
  const value = metaEnv()[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 当前是否走同源代理 */
export function isProxyMode(): boolean {
  const flag = readViteEnv("VITE_LLM_PROXY");
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;

  const isProd = metaEnv().PROD === true;
  return isProd && !readViteEnv("VITE_DEEPSEEK_API_KEY");
}

/**
 * 代理模式的 baseURL。
 *
 * 必须是**绝对地址**：`@langchain/openai` 底层用 `new URL(path, baseURL)`
 * 拼接，相对地址在部分环境会直接抛错。浏览器端补成同源绝对地址。
 */
export function proxyBaseUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return `${window.location.origin}${LLM_PROXY_PATH}`;
  }
  return LLM_PROXY_PATH;
}
