/**
 * 旅游多 Agent · 环境配置（浏览器版）
 *
 * 移植自 `apps/lesson9-12-travel/src/config/env.ts`（附录 A 第 13 项）。
 *
 * 原版跑在 Node 上，用 zod 解析 `process.env`；这里跑在浏览器里，改成
 * `import.meta.env` + 同样的 zod schema 校验思路：
 *  - 只有 VITE_ 前缀的变量会进前端产物，所以键名全部带 VITE_；
 *  - 装配出**供应商故障转移链**（顺序即优先级），供 HttpLlmClient 逐级降级。
 *
 * ⚠️ 安全提示：VITE_ 变量会打进前端产物，任何访问页面的人都能看到，
 * 只适合本地/内部开发。部署到公网请把 Key 放到后端代理。
 */
import { z } from 'zod';
import { DEFAULT_MAX_TOKENS, DEFAULT_TEMPERATURE } from '../shared/llm';
import {
  PROXY_PLACEHOLDER_KEY,
  isProxyMode,
  proxyBaseUrl,
} from '../../config/llm-endpoint';

/** 浏览器与 Node 双兼容的 env 读取（与项目既有 src/graph/llm.ts 口径一致） */
function readEnv(key: string): string | undefined {
  const metaEnv = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fromMeta = metaEnv?.[key];
  if (fromMeta != null && fromMeta !== '') return fromMeta;
  if (typeof process !== 'undefined') {
    const fromProcess = process.env?.[key];
    if (fromProcess) return fromProcess;
  }
  return undefined;
}

const optionalStr = z.string().min(1).optional();

const EnvSchema = z.object({
  deepseekKey: optionalStr,
  deepseekBaseUrl: z.string().min(1).default('https://api.deepseek.com/v1'),
  deepseekModel: z.string().min(1).default('deepseek-v4-flash'),

  // 第二供应商（可选）：用于演示故障转移链
  backupName: z.string().min(1).default('backup'),
  backupKey: optionalStr,
  backupBaseUrl: optionalStr,
  backupModel: optionalStr,

  openaiKey: optionalStr,
  openaiBaseUrl: z.string().min(1).default('https://api.openai.com/v1'),
  openaiModel: z.string().min(1).default('gpt-4o-mini'),
});

export type TravelEnv = z.infer<typeof EnvSchema>;

/** 一个 LLM 供应商端点（故障转移链的一节） */
export interface LlmProviderEndpoint {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** 是否显式关闭思维链：DeepSeek 推理模型默认开启，会吃满 max_tokens 导致正文为空 */
  disableThinking?: boolean;
  /**
   * 经同源代理转发：真正的 Key 在服务端（`DEEPSEEK_API_KEY`），
   * 前端既不带 Authorization，产物里也不会有任何 Key。
   */
  viaProxy?: boolean;
}

let cached: TravelEnv | null = null;

/** 读取并校验环境变量（失败时退回默认值，不让页面白屏） */
export function loadTravelEnv(): TravelEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse({
    deepseekKey: readEnv('VITE_DEEPSEEK_API_KEY'),
    deepseekBaseUrl: readEnv('VITE_DEEPSEEK_BASE_URL'),
    deepseekModel: readEnv('VITE_DEEPSEEK_MODEL'),
    backupName: readEnv('VITE_LLM_BACKUP_NAME'),
    backupKey: readEnv('VITE_LLM_BACKUP_API_KEY'),
    backupBaseUrl: readEnv('VITE_LLM_BACKUP_BASE_URL'),
    backupModel: readEnv('VITE_LLM_BACKUP_MODEL'),
    openaiKey: readEnv('VITE_OPENAI_API_KEY'),
    openaiBaseUrl: readEnv('VITE_OPENAI_BASE_URL'),
    openaiModel: readEnv('VITE_OPENAI_MODEL'),
  });
  cached = parsed.success
    ? parsed.data
    : (EnvSchema.parse({}) as TravelEnv);
  return cached;
}

/**
 * 装配供应商链（顺序 = 优先级）。
 *
 * 没有 Key 的供应商直接不入链 —— 与服务端「无 Key 跳过该 provider」同口径，
 * 由上层执行者的纯逻辑兜底接管，保证无 Key 也能跑通整条动线。
 */
export function getLlmProviders(): LlmProviderEndpoint[] {
  const env = loadTravelEnv();
  const chain: LlmProviderEndpoint[] = [];

  // 线上模式：只挂代理这一节，前端不持有 Key
  if (isProxyMode()) {
    chain.push({
      name: 'deepseek',
      baseUrl: proxyBaseUrl(),
      apiKey: PROXY_PLACEHOLDER_KEY,
      model: env.deepseekModel,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      disableThinking: true,
      viaProxy: true,
    });
    return chain;
  }

  if (env.deepseekKey) {
    chain.push({
      name: 'deepseek',
      baseUrl: env.deepseekBaseUrl,
      apiKey: env.deepseekKey,
      model: env.deepseekModel,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
      disableThinking: true,
    });
  }

  if (env.backupKey && env.backupBaseUrl && env.backupModel) {
    chain.push({
      name: env.backupName,
      baseUrl: env.backupBaseUrl,
      apiKey: env.backupKey,
      model: env.backupModel,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  }

  if (env.openaiKey) {
    chain.push({
      name: 'openai',
      baseUrl: env.openaiBaseUrl,
      apiKey: env.openaiKey,
      model: env.openaiModel,
      temperature: DEFAULT_TEMPERATURE,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
  }

  return chain;
}

/** 是否配置了可用 LLM（页面用来提示「当前是 Mock/兜底模式」） */
export function hasLlmProvider(): boolean {
  return getLlmProviders().length > 0;
}

/**
 * 收敛门允许的局部重派轮数上限（首轮之外）。`0` = 关闭。
 *
 * 默认 1：讲义第五部分把它当「降级开关」——关掉就是课10 basic 的行为。
 * 读不到/非法值一律回落到 1，避免页面上出现「配错就悄悄不重派」。
 */
export function travelMaxRounds(): number {
  const raw = readEnv('VITE_TRAVEL_MAX_ROUNDS');
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n < 0) return 1;
  return Math.trunc(n);
}

/** 是否给 route 挂地图工具（默认开）。`VITE_TRAVEL_MAP_TOOL=off` 时退回无工具的 RouteWorker */
export function travelToolAware(): boolean {
  return (readEnv('VITE_TRAVEL_MAP_TOOL') ?? 'mock').toLowerCase() !== 'off';
}
