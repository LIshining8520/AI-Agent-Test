/**
 * 执行者统一契约（第 5 段「执行者协议：一个接口定义执行者」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/orchestration/worker-protocol.ts`
 * （附录 A 第 7 项）。
 *
 * 本文件是**真相唯一**的 worker 协议：三个执行者（Route / Itinerary / Budget）
 * 与编排骨架（LangGraph 图）都只依赖它。接真实 worker 时只需实现 `TravelWorker`，
 * 换掉默认注册即可，编排骨架一行不用改 —— 这就是「分工边界从输入侧切开」的落点。
 *
 * 刻意不含任何 worker 实现。
 */
import type { LlmClient, UsageSnapshot } from '../../shared/llm';
import type { TripProfile } from '../../shared/travel-types';

/** 三种执行者类型（对应三子链：路线 / 行程 / 预算） */
export type WorkerKind = 'route' | 'itinerary' | 'budget';

/** 一次 worker 执行的产物 */
export interface WorkerResult<T = unknown> {
  /** 是否成功；false 表示该子链失败，结果落入 error 汇总而非整体失败 */
  ok: boolean;
  /** 子链结构化产物（route→RoutePlan / itinerary→ItineraryPlan / budget→BudgetPlan） */
  data?: T;
  /** 本次调用的 token/成本快照，供成本归因累计 */
  usage: UsageSnapshot;
  /** 失败/降级原因（如 LLM 报错后走了兜底） */
  error?: string;
  /** 链路 ID，便于在 worker 内部继续追踪子调用 */
  traceId?: string;
  /** 本次产物来源：llm 生成 / 纯逻辑兜底 */
  source?: 'llm' | 'fallback';
}

/** 传给 worker 的上下文：画像 + 链路 ID + LLM 客户端 */
export interface TravelWorkerContext {
  profile: TripProfile;
  traceId: string;
  llm: LlmClient;
  /** 覆盖默认温度（调优/评测可用） */
  temperature?: number;
  /** 强制纯逻辑兜底（无 LLM 也能把动线跑通） */
  forceFallback?: boolean;
}

/**
 * worker 统一契约：每个执行者声明自己的 kind，并实现 run(ctx)。
 * 框架用 kind 做指派与分发，绝不对具体实现硬编码。
 */
export interface TravelWorker {
  readonly kind: WorkerKind;
  run(ctx: TravelWorkerContext): Promise<WorkerResult>;
}

/** 执行者注册表：按 kind 注册/查找 worker */
export interface WorkerRegistry {
  register(kind: WorkerKind, worker: TravelWorker): void;
  getWorker(kind: WorkerKind): TravelWorker | undefined;
}

/** 全部三种 worker 的 kind 列表（遍历 fan-out 用） */
export const ALL_WORKER_KINDS: readonly WorkerKind[] = ['route', 'itinerary', 'budget'];

/** 校验字符串是否为合法 WorkerKind */
export function isWorkerKind(v: unknown): v is WorkerKind {
  return typeof v === 'string' && (ALL_WORKER_KINDS as readonly string[]).includes(v);
}

/** 极简注册表实现（编排层构造时填充，避免把实现硬编码进图节点） */
export function createWorkerRegistry(): WorkerRegistry {
  const map = new Map<WorkerKind, TravelWorker>();
  return {
    register(kind, worker) {
      map.set(kind, worker);
    },
    getWorker(kind) {
      return map.get(kind);
    },
  };
}
