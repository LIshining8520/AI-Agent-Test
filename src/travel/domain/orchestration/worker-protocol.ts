/**
 * 执行者统一契约（第二部分「角色边界」+ 第三/四/五部分的协作扩展点）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/orchestration/worker-protocol.ts`
 * （附录 A · domain.orchestration）。
 *
 * 本文件是**真相唯一**的 worker 协议：三个执行者（Route / Itinerary / Budget）
 * 与编排骨架（LangGraph 图）都只依赖它。接真实 worker 时只需实现 `TravelWorker`，
 * 换掉默认注册即可，编排骨架一行不用改 —— 这就是「分工边界从输入侧切开」的落点。
 *
 * 刻意不含任何 worker 实现。
 *
 * ## 为什么新增字段全部是可选的
 *
 * 多 Agent 升级（角色内循环 + 共享黑板 + 收敛门）只发生在 full 版；basic 用的是同一套
 * 协议语义，但**不实现 verify、不传 board、不读 attempt/feedback**。
 * 把 board/attempt/feedback/taskDescription/verify/attempts 全部声明为可选，就能保证：
 * basic 的 worker 与调用方一行不改，编译与运行时行为都与升级前完全一致；
 * 升级能力由实现方按需接管，而不是靠一份「basic 专用协议」分叉出两个真相。
 */
import type { LlmClient, UsageSnapshot } from '../../shared/llm';
import type { TripProfile } from '../../shared/travel-types';
import type { PlanBoard, PlanBoardFacts } from '../collab/plan-board';

/** 三种执行者类型（对应三子链：路线 / 行程 / 预算） */
export type WorkerKind = 'route' | 'itinerary' | 'budget';

/** 一次 worker 执行的产物 */
export interface WorkerResult<T = unknown> {
  /** 是否成功；false 表示该子链失败，结果落入 error 汇总而非整体失败 */
  ok: boolean;
  /** 子链结构化产物（route→RoutePlan / itinerary→ItineraryPlan / budget→BudgetPlan） */
  data?: T;
  /** 本次调用的 token/成本快照，供成本归因累计（跨轮已累加） */
  usage: UsageSnapshot;
  /** 失败/降级原因（如 LLM 报错后走了兜底，或 verify 到上限仍未通过） */
  error?: string;
  /** 链路 ID，便于在 worker 内部继续追踪子调用 */
  traceId?: string;
  /** 本次产物来源：llm 生成 / 纯逻辑兜底 */
  source?: 'llm' | 'fallback';
  /** 本角色实际跑了几轮（含首轮）；未开启角色内循环时不填，成本归因按 1 处理 */
  attempts?: number;
}

/**
 * 角色内循环的校验结果。
 *
 * `facts` 是 verify 顺带确认的共享事实：只有当角色真的把结果核过一遍，
 * 它写进黑板的值才有分量——所以事实回写挂在 verify 而不是 run 的返回值上。
 */
export interface VerificationResult {
  ok: boolean;
  /** 不通过时给下一轮 prompt 的修正提示；通过时可为空 */
  feedback?: string;
  /** 本轮可确认的事实，交给 PlanBoard.write（受各自写权限约束） */
  facts?: Partial<PlanBoardFacts>;
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
  /** 共享黑板；不传表示未启用协作，worker 只能看到 profile */
  board?: PlanBoard;
  /** 当前是第几轮，从 1 开始；不传等价于首轮（1） */
  attempt?: number;
  /** 上一轮 verify / 收敛门的反馈文本，首轮为空；拼进 prompt 用于自我修正 */
  feedback?: string;
  /**
   * 编排层给本角色下达的任务描述。
   *
   * 首轮派发与收敛重派都带同一份描述：重派改的是「哪里不自洽」，
   * 不是把角色换成另一件事——任务边界在整次编排里不变。
   */
  taskDescription?: string;
  /**
   * 工具上下文（本仓对原工程 AsyncLocalStorage 的等价替代）。
   *
   * 由 ToolAwareRouteWorker 在**它那一次 run** 里写入（地图工具返回的路线文案），
   * `buildPrompt` 从同一份 ctx 读取。不传等价于「本次未挂载工具」。
   */
  toolContext?: string;
}

/**
 * worker 统一契约：每个执行者声明自己的 kind，并实现 run(ctx)。
 * 框架用 kind 做指派与分发，绝不对具体实现硬编码。
 */
export interface TravelWorker {
  readonly kind: WorkerKind;
  run(ctx: TravelWorkerContext): Promise<WorkerResult>;
  /**
   * 可选的自检钩子：不实现即退化为「跑一次就交付」的旧行为。
   * 实现后由 BaseWorker 的循环在每轮生成之后调用，ok=false 则带上 feedback 再跑一轮。
   */
  verify?(data: unknown, ctx: TravelWorkerContext): VerificationResult | Promise<VerificationResult>;
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
