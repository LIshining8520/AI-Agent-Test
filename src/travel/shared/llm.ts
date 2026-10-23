/**
 * 旅游多 Agent · LLM 客户端契约
 *
 * 移植自 `packages/shared/src/llm.ts`（课 9-12 共享层）。
 * 业务模块（画像解析 / 三个执行者）只依赖本文件的 `LlmClient` 接口，
 * 不感知具体供应商 —— 换 DeepSeek / 硅基流动 / OpenAI 都不用改业务代码。
 */

/** 角色模型配置（对应 .env 的 VITE_LLM_*） */
export interface ModelConfig {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  /** 生成温度；评测用 judge 应为 0 */
  temperature?: number;
  maxTokens?: number;
}

/** 角色 → 模型配置映射。多 Agent 场景每个角色可配不同模型（成本分级的关键） */
export type RoleModelMap = Record<string, ModelConfig>;

/** 文本生成请求 */
export interface GenerateRequest {
  /** role id，用于成本归因（'PROFILE' | 'ROUTE' | 'ITINERARY' | 'BUDGET'） */
  role: string;
  system: string;
  user: string;
  messages?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** 期望返回 JSON，底层走结构化输出（response_format=json_object） */
  json?: boolean;
}

/** 流式生成（本项目暂未接真流式，保留接口形状） */
export interface StreamRequest extends Omit<GenerateRequest, 'json'> {
  onToken: (token: string) => void;
}

/** 一次 LLM 生成的用量快照，供成本归因 */
export interface UsageSnapshot {
  role: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** 统一 LLM 客户端 */
export interface LlmClient {
  generate(req: GenerateRequest): Promise<{ text: string; usage: UsageSnapshot }>;
  stream(req: StreamRequest): Promise<{ text: string; usage: UsageSnapshot }>;
  /** 结构化 JSON 输出（画像解析 / 三子链产物都走这里） */
  generateJson<T>(req: GenerateRequest): Promise<{ data: T; usage: UsageSnapshot }>;
}

/**
 * 缺省输出预算（含推理模型的思维链 + 正文）。
 * 推理模型把 `reasoning_content` 与正文计入同一份 `max_tokens`：预算偏小时
 * 推理先吃满额度、正文为空，会被误判成「模型返回空内容」。
 */
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.2;

/** 各角色 token 单价（美元 / 1M）—— 成本归因使用 */
export const DEFAULT_PRICE_PER_1M = {
  input: 0.5,
  output: 1.5,
} as const;
