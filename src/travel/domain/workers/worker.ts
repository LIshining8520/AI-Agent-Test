/**
 * Worker 基类：模板方法封装「LLM 优先、失败兜底」（第 5 段执行者实现）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/workers/worker.ts`（附录 A 第 8 项）。
 *
 * 三个执行者共用同一套骨架，只实现三个钩子：
 *  - buildPrompt：构造结构化生成的指令（含 role 供成本归因）
 *  - normalize：把 LLM 原始 JSON 清洗成领域产物（容错、给默认值）
 *  - fallback：纯逻辑兜底，保证无 LLM 也能产出最小可用产物
 *
 * 这样「三子链并行」不是靠三份复制代码，而是靠同一个契约的三个实现。
 */
import type { GenerateRequest, LlmClient, UsageSnapshot } from '../../shared/llm';
import type { TripProfile } from '../../shared/travel-types';
import type {
  TravelWorker,
  TravelWorkerContext,
  WorkerResult,
} from '../orchestration/worker-protocol';

/** WorkerContext 别名：三大执行者的 buildPrompt(profile, ctx) 第二参用它 */
export type WorkerContext = TravelWorkerContext;

/** 零用量快照（兜底路径：无 LLM 调用，成本为 0） */
function zeroUsage(role: string): UsageSnapshot {
  return { role, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

/**
 * Worker 基类。
 * 注意：本仓 tsconfig 开了 `erasableSyntaxOnly`，不能用构造参数属性（`constructor(private x)`），
 * 所以这里用显式字段声明 —— 功能等价。
 */
export abstract class BaseWorker<T> implements TravelWorker {
  protected readonly roleId: string;
  protected readonly llm: LlmClient;
  abstract readonly kind: TravelWorker['kind'];

  protected constructor(llm: LlmClient, role: string) {
    this.llm = llm;
    this.roleId = role;
  }

  /** 构造结构化生成的 prompt（含 role 供成本归因） */
  abstract buildPrompt(profile: TripProfile, context: WorkerContext): GenerateRequest;

  /** 把 LLM 原始 JSON 清洗/校验为领域产物 */
  abstract normalize(data: unknown, profile: TripProfile): T;

  /** 纯逻辑兜底：基于主数据经验规则产出最小可用产物 */
  abstract fallback(profile: TripProfile): T;

  /** 协议统一入口 */
  async run(ctx: TravelWorkerContext): Promise<WorkerResult<T>> {
    const profile = ctx.profile;
    const role = this.roleId;
    const llm = ctx.llm ?? this.llm;

    // 演示/评测强制兜底：跳过 LLM（这是**预期路径**，不是异常，所以不记 error）
    if (ctx.forceFallback) {
      return {
        data: this.fallback(profile),
        usage: zeroUsage(role),
        ok: true,
        source: 'fallback',
        traceId: ctx.traceId,
      };
    }

    try {
      const { data, usage } = await llm.generateJson<unknown>({
        ...this.buildPrompt(profile, ctx),
        role,
        json: true,
      });
      return {
        data: this.normalize(data, profile),
        usage,
        ok: true,
        source: 'llm',
        traceId: ctx.traceId,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        data: this.fallback(profile),
        usage: zeroUsage(role),
        ok: true,
        error: `fallback: ${reason}`,
        source: 'fallback',
        traceId: ctx.traceId,
      };
    }
  }
}

/**
 * 把 `day` 收敛到 `[1, days]`（**路线与行程两个子链共用，单一来源**）。
 *
 * 为什么必须收敛：LLM 给的 `day` 不可信 —— 偶发越界（5 天行程给 day=6）或 0 基序号，
 * 会让下游「行程合理性」的时序校验直接判否。本仓实测：只修路线侧、漏修行程侧时，
 * 同一套评测出现 100/100/66.7 的间歇失败；两侧共用本函数后口径一致。
 *
 * ⚠️ 非正数视为「缺失」按序号补位，不能夹到 1：
 * LLM 常见 0 基序号（第 3 天给 day=0 会被夹成 1，与第 1 天重复）。
 */
export function clampDay(raw: number | undefined, fallback: number, days: number): number {
  const upper = Math.max(days, 1);
  const d =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
  return Math.min(Math.max(d, 1), upper);
}
