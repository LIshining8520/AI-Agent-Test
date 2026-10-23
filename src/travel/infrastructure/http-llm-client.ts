/**
 * OpenAI 兼容 HTTP LLM 客户端（浏览器版）
 *
 * 移植自 `apps/lesson9-12-travel/src/infrastructure/llm/http-llm-client.ts`
 * （附录 A 第 12 项）。原版用原生 fetch 调 /chat/completions，这里保持零 SDK 依赖，
 * 同样支持**多 Provider 故障转移**：按链逐级尝试，前一个 4xx/5xx/网络错就降级到下一个，
 * 全链失败抛最后错误，由上层执行者的纯逻辑兜底接管（编排整体不失败）。
 *
 * 与原版的两处浏览器适配：
 *  1) 90s AbortController 超时保留（浏览器同样支持）；
 *  2) `thinking:{type:'disabled'}` 先带上试一次，若供应商不认这个字段（400/422）
 *     自动去掉重试一次 —— 不同兼容端点的支持度不一致，硬带会让整条链全挂。
 */
import {
  DEFAULT_PRICE_PER_1M,
  type GenerateRequest,
  type LlmClient,
  type StreamRequest,
  type UsageSnapshot,
} from '../shared/llm';
import { estimateCostUsd } from '../shared/cost-model';
import type { LlmProviderEndpoint } from '../config/env';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: ChatUsage;
  error?: { message?: string };
}

/** 单次请求超时上限（与原版一致：90s） */
const REQUEST_TIMEOUT_MS = 90_000;

/** 把 generate 请求拍平成 messages 数组 */
function toMessages(req: GenerateRequest): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: req.system }];
  if (req.messages) msgs.push(...req.messages);
  msgs.push({ role: 'user', content: req.user });
  return msgs;
}

/** 从 usage 快照生成用量（成本按默认单价估算） */
function toUsage(role: string, u?: ChatUsage): UsageSnapshot {
  const inputTokens = u?.prompt_tokens ?? 0;
  const outputTokens = u?.completion_tokens ?? 0;
  const totalTokens = u?.total_tokens ?? inputTokens + outputTokens;
  return {
    role,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: estimateCostUsd(inputTokens, outputTokens, DEFAULT_PRICE_PER_1M),
  };
}

/**
 * 剥掉 Markdown 代码块包裹并截取首个花括号块（结构化输出容错）。
 * 模型常返回 ```json {...} ``` 或前后带解释文字，这里统一兜住。
 */
export function extractJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?|```$/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('响应中未找到合法 JSON 对象');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** 故障转移链的调用结果（provider 名用于观测「最终是谁答的」） */
export interface FailoverResult {
  text: string;
  usage: ChatUsage;
  provider: string;
  /** 尝试过的 provider 与失败原因，便于排查「为什么降级了」 */
  attempts: Array<{ provider: string; error?: string }>;
}

export class HttpLlmClient implements LlmClient {
  private readonly providers: LlmProviderEndpoint[];

  constructor(providers: LlmProviderEndpoint[]) {
    this.providers = providers;
  }

  /** 是否有可用供应商（无 Key 时页面走兜底动线） */
  get hasProvider(): boolean {
    return this.providers.some((p) => !!p.apiKey || !!p.viaProxy);
  }

  /**
   * 按链逐 provider 发起一次请求。
   * @returns text + usage + 命中的 provider + 尝试轨迹
   */
  private async callWithFailover(
    messages: ChatMessage[],
    cfg: { temperature?: number; maxTokens?: number; json?: boolean },
  ): Promise<FailoverResult> {
    let lastError: unknown = new Error('无可用 LLM Provider');
    const attempts: Array<{ provider: string; error?: string }> = [];

    for (const p of this.providers) {
      // 代理模式下前端没有真 Key，靠 viaProxy 放行
      if (!p.apiKey && !p.viaProxy) continue;
      // thinking 字段先带、失败再去掉重试（兼容不支持该字段的端点）
      const thinkingModes: Array<boolean> = p.disableThinking ? [true, false] : [false];
      for (const withThinking of thinkingModes) {
        try {
          const payload: Record<string, unknown> = {
            model: p.model,
            messages,
            temperature: cfg.temperature ?? p.temperature ?? 0.2,
            max_tokens: cfg.maxTokens ?? p.maxTokens ?? 4096,
            stream: false,
            ...(cfg.json ? { response_format: { type: 'json_object' } } : {}),
          };
          if (withThinking) payload.thinking = { type: 'disabled' };

          const url = p.baseUrl.replace(/\/+$/, '') + '/chat/completions';
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          // 代理模式下不带 Authorization：Key 只存在于服务端环境变量
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (!p.viaProxy && p.apiKey) {
            headers.Authorization = `Bearer ${p.apiKey}`;
          }
          let res: Response;
          try {
            res = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(payload),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);
          }

          if (!res.ok) {
            const body = await res.text().catch(() => '');
            const msg = `[${p.name}] LLM ${res.status}: ${body.slice(0, 160) || '空响应'}`;
            // 400/422 且刚才是带 thinking 的请求 → 去掉 thinking 再试同 provider
            if (withThinking && (res.status === 400 || res.status === 422)) {
              attempts.push({ provider: `${p.name}(no-thinking-retry)`, error: msg });
              continue;
            }
            throw new Error(msg);
          }

          const data = (await res.json()) as ChatResponse;
          if (data.error?.message) throw new Error(`[${p.name}] ${data.error.message}`);
          const text = data.choices?.[0]?.message?.content ?? '';
          // 空内容视为该 provider 不可用，切下一个
          if (!text.trim()) throw new Error(`[${p.name}] 空响应`);

          attempts.push({ provider: p.name });
          return { text, usage: data.usage ?? {}, provider: p.name, attempts };
        } catch (err) {
          lastError = err;
          attempts.push({
            provider: withThinking ? `${p.name}(thinking)` : p.name,
            error: err instanceof Error ? err.message : String(err),
          });
          break; // 该 provider 失败 → 直接换下一个
        }
      }
    }

    const err = lastError instanceof Error ? lastError : new Error(String(lastError));
    (err as Error & { attempts?: unknown }).attempts = attempts;
    throw err;
  }

  async generate(req: GenerateRequest): Promise<{ text: string; usage: UsageSnapshot }> {
    const { text, usage } = await this.callWithFailover(toMessages(req), {
      temperature: req.temperature,
    });
    return { text, usage: toUsage(req.role, usage) };
  }

  /** 流式：走非流式再逐字符回调（保留接口形状，教学阶段够用） */
  async stream(req: StreamRequest): Promise<{ text: string; usage: UsageSnapshot }> {
    const { text, usage } = await this.callWithFailover(toMessages(req), {
      temperature: req.temperature,
    });
    for (const ch of [...text]) req.onToken(ch);
    return { text, usage: toUsage(req.role, usage) };
  }

  async generateJson<T>(req: GenerateRequest): Promise<{ data: T; usage: UsageSnapshot }> {
    const { text, usage } = await this.callWithFailover(toMessages(req), {
      temperature: req.temperature,
      json: true,
    });
    return { data: extractJson(text) as T, usage: toUsage(req.role, usage) };
  }
}

/**
 * 零供应商时的哑客户端：所有调用都抛错，交给上层执行者走纯逻辑兜底。
 * 这样「没配 Key」不会让页面崩，而是明确降级（与原版无 Key 行为一致）。
 */
export function createNoopLlmClient(): LlmClient {
  const fail = async (): Promise<never> => {
    throw new Error('未配置 LLM Provider（.env 里没有 VITE_DEEPSEEK_API_KEY）');
  };
  return {
    generate: fail,
    stream: fail,
    generateJson: fail,
  };
}
