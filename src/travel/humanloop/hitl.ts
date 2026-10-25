/**
 * HITL 人工改计划闭环（第五部分 5.4「人触发与判定触发，是同一件事的两种入口」）
 *
 * 移植自 `apps/lesson9-12-travel/src/humanloop/hitl.ts`（附录 A · humanloop）。
 *
 * 人机协作规则（ADR）：HITL 不是「每步都问人」，而是只在**关键决策点**暂停等确认——
 * 改目的地、超支触发重规划、路线不可达属关键；其余步骤自动通过不打断。
 *
 * 闭环四步：
 *  1. checkpoint(关键决策) —— 需要人确认的节点在此暂停；
 *  2. 默认 approver 自动放行（演示可复现）；真实场景可注入人工确认函数（页面弹窗）；
 *  3. applyRevision —— 把人的修改并入画像，得修订画像 + 受影响子链 kind 清单；
 *  4. reexecuteAffectedWorkers —— 受影响成员按新计划重执行（校准闭环），
 *     并用 isRecalibratedConsistent 校验「重执行结果与新计划输入一致」。
 */
import type { LlmClient } from '../shared/llm';
import type { TripProfile } from '../shared/travel-types';
import type { TravelWorker, WorkerKind } from '../domain/orchestration/worker-protocol';

/** 关键决策类型（仅这些才触发人工确认） */
export type KeyDecisionType =
  | 'change_destination'
  | 'overbudget_replan'
  | 'route_infeasible'
  | 'confirm_sub_agent';

/** 一个被提出等待确认或已放行的关键决策 */
export interface KeyDecision {
  id: string;
  type: KeyDecisionType;
  label: string;
  detail: string;
  reason: string;
  current: TripProfile;
}

/** 人对某个决策的回复：批准 +（可选）修订画像 */
export interface HumanRevision {
  decisionId: string;
  approved: boolean;
  /** 人的修改（仅包含要改的画像字段，如 days/budget/destination） */
  revised?: Partial<TripProfile>;
  note?: string;
}

/** 非关键步骤的直接放行回复 */
function autoPassThrough(decision: KeyDecision): HumanRevision {
  return { decisionId: decision.id, approved: true, revised: {} };
}

/** 哪些类型属于「必须人工确认」的关键决策点 */
const KEY_TYPES: KeyDecisionType[] = [
  'change_destination',
  'overbudget_replan',
  'route_infeasible',
];

export function isKeyDecisionType(t: KeyDecisionType): boolean {
  return KEY_TYPES.includes(t);
}

/** 人的确认函数（真实场景实现为弹窗/卡片；演示用默认自动放行） */
export type HumanApprover = (decision: KeyDecision) => HumanRevision | Promise<HumanRevision>;

const defaultApprover: HumanApprover = (d) => autoPassThrough(d);

/**
 * HITL 协调器：只在关键决策点暂停等确认，非关键自动放行；
 * 记录每次决策（决策日志供可观测/复盘）；合并修订并派发重执行。
 */
export class HitlCoordinator {
  /** 决策日志（可观测/复盘） */
  readonly decisions: KeyDecision[] = [];

  private readonly approver: HumanApprover;

  constructor(approver: HumanApprover = defaultApprover) {
    this.approver = approver;
  }

  /** 提出一个决策：关键则等人工，非关键自动放行；返回人的回复（含合并修订） */
  async checkpoint(
    type: KeyDecisionType,
    current: TripProfile,
    opts: { reason?: string; label?: string } = {},
  ): Promise<HumanRevision> {
    const decision: KeyDecision = {
      id: `hitl-${this.decisions.length + 1}-${type}`,
      type,
      label: opts.label ?? humanLabel(type),
      detail: `${current.destination}｜${current.days}天｜预算${current.budget}元`,
      reason: opts.reason ?? '默认关键决策点',
      current,
    };
    this.decisions.push(decision);
    // ADR: 非关键步骤绝不打断，只有 key type 才暂停
    if (!isKeyDecisionType(type)) return autoPassThrough(decision);
    return this.approver(decision);
  }

  /** 把人的修订并入画像，返回修订画像 + 受影响子链 kind 清单 */
  static applyRevision(
    profile: TripProfile,
    rev: HumanRevision,
  ): { revised: TripProfile; changedKinds: WorkerKind[] } {
    if (!rev.approved) return { revised: profile, changedKinds: [] };
    const patch = (rev.revised ?? {}) as Partial<TripProfile>;
    const revised: TripProfile = {
      ...profile,
      ...(patch.destination !== undefined && patch.destination !== profile.destination
        ? { destination: patch.destination }
        : {}),
      ...(patch.days !== undefined ? { days: patch.days } : {}),
      ...(patch.budget !== undefined ? { budget: patch.budget } : {}),
      companions: profile.companions,
      preferences: {
        ...profile.preferences,
        ...(patch.preferences ?? {}),
      },
      constraints: { ...profile.constraints, ...(patch.constraints ?? {}) },
    };

    const changed = new Set<WorkerKind>();
    if (patch.destination && patch.destination !== profile.destination) {
      changed.add('route');
      changed.add('itinerary');
      changed.add('budget');
    }
    if (patch.days && patch.days !== profile.days) {
      changed.add('itinerary');
      changed.add('route');
    }
    if (patch.budget !== undefined && patch.budget !== profile.budget) changed.add('budget');
    return { revised, changedKinds: [...changed] };
  }
}

/** 受影响的成员按新计划（修订画像）重执行——校准闭环，确定性（兜底）或真 worker 均可 */
export async function reexecuteAffectedWorkers(
  workers: Map<WorkerKind, TravelWorker> | Array<[WorkerKind, TravelWorker]>,
  revised: TripProfile,
  changedKinds: WorkerKind[],
  opts: { traceId?: string; forceFallback?: boolean; llm?: LlmClient } = {},
): Promise<Map<WorkerKind, { ok: boolean; data?: unknown }>> {
  const map = workers instanceof Map ? workers : new Map(workers);
  const out = new Map<WorkerKind, { ok: boolean; data?: unknown }>();
  for (const kind of changedKinds) {
    const w = map.get(kind);
    if (!w) continue;
    const res = await w.run({
      profile: revised,
      traceId: opts.traceId ?? `hitl-rerun-${kind}`,
      // forceFallback=true 时不会真正访问 llm，这里仍提供可用的客户端实例保持协议完整
      llm: opts.llm ?? ({ generate: null, stream: null, generateJson: null } as unknown as LlmClient),
      forceFallback: opts.forceFallback ?? true,
    });
    out.set(kind, { ok: res.ok, data: res.data });
  }
  return out;
}

/** 校验：重执行结果是否与「新计划输入」一致（天数/预算/目的地对齐） */
export function isRecalibratedConsistent(
  revised: TripProfile,
  results: Map<WorkerKind, { ok: boolean; data?: unknown }>,
): { pass: boolean; violations: string[] } {
  const v: string[] = [];
  const itinerary = results.get('itinerary')?.data as
    | { planByDay?: Array<unknown> }
    | undefined;
  if (itinerary?.planByDay && itinerary.planByDay.length !== revised.days) {
    v.push(`行程计划天数 ${itinerary.planByDay.length} ≠ 修订天数 ${revised.days}`);
  }
  const budget = results.get('budget')?.data as { totalBudget?: number } | undefined;
  if (budget && budget.totalBudget !== undefined && budget.totalBudget !== revised.budget) {
    v.push(`预算总额 ${budget.totalBudget} ≠ 修订预算 ${revised.budget}`);
  }
  const route = results.get('route')?.data as { destination?: string } | undefined;
  if (route && route.destination && route.destination !== revised.destination) {
    v.push(`路线目的地 ${route.destination} ≠ 修订目的地 ${revised.destination}`);
  }
  return { pass: v.length === 0, violations: v };
}

function humanLabel(t: KeyDecisionType): string {
  const map: Record<KeyDecisionType, string> = {
    change_destination: '更改目的地',
    overbudget_replan: '超预算 · 触发重新规划',
    route_infeasible: '路线不可达 · 需人工调整',
    confirm_sub_agent: '确认景点推荐下钻',
  };
  return map[t];
}
