/**
 * 共享黑板（第四部分「从共享状态到共享事实」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/collab/plan-board.ts`（附录 A · domain.collab）。
 *
 * 三个执行者在同一轮协作里各自只看得到 profile，于是会各写各的：route 认定第 2 天住大理，
 * itinerary 却按 4 晚排房，budget 又按另一种上限分摊——最后「三方不自洽」。
 * 黑板就是把**已确认的事实**从各自上下文里提出来，变成一份大家都能读的公共状态；
 * 下一轮 prompt 注入 `summaryFor(kind)`，角色看到的是彼此的口径，而不是各自脑补。
 *
 * 只存事实、不存产物：产物（RoutePlan / ItineraryPlan / BudgetPlan）仍在各自子链里，
 * 黑板一旦变成「第二个结果仓库」，冲突规则就无从谈起。
 *
 * 与课12 Reducer 的关系：这里是同一件事的运行时版本——哪个字段归谁写、后写如何覆盖，
 * 都是 Reducer「同一状态只有一条合法变迁路径」的具象化。
 */
import type { TripProfile } from '../../shared/travel-types';
import type { WorkerKind } from '../orchestration/worker-protocol';

/** 黑板承载的共享事实。字段粒度就是「一个角色能独立确认的一件事」 */
export interface PlanBoardFacts {
  /** 住宿晚数，itinerary 写 */
  nights: number;
  /** 第 N 天所在地，route 写 */
  dayAnchors: Record<number, string>;
  /** 预算上限，budget 写 */
  budgetCap: number;
  /** 必去景点，只读（来自 profile） */
  mustVisit: string[];
}

/** 一次字段撞车：谁在哪个字段上把什么改成了什么 */
export interface ConflictEvent {
  kind: WorkerKind;
  field: keyof PlanBoardFacts;
  from: unknown;
  to: unknown;
}

/** 单个角色在本次协作中的执行状态（轮次 / 是否通过 / 上轮反馈） */
export interface KindState {
  attempts: number;
  ok: boolean;
  lastFeedback?: string;
}

/**
 * 写权限表：字段 → 唯一有权写它的角色。
 *
 * 为什么用白名单而不是黑名单：角色边界是这张表唯一的真相来源，
 * 新增角色/字段时漏配的后果是「写不进去」（可见、可测），而不是「谁都能改」（不可见）。
 * `mustVisit` 刻意不在任何一行里——它由 profile 带入，是输入而非协作产物。
 */
const WRITE_PERMISSION: Record<WorkerKind, ReadonlyArray<keyof PlanBoardFacts>> = {
  route: ['dayAnchors'],
  itinerary: ['nights'],
  budget: ['budgetCap'],
};

/**
 * 判断两个字段值是否相同。
 * dayAnchors 是对象，直接 !== 永远为真，会把「重复写同一份锚点」误记成冲突；
 * 其余字段是原始值/数组，按值比较即可。
 */
function sameValue(field: keyof PlanBoardFacts, prev: unknown, next: unknown): boolean {
  if (field === 'dayAnchors') {
    const a = (prev ?? {}) as Record<number, string>;
    const b = (next ?? {}) as Record<number, string>;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => a[Number(k)] === b[Number(k)]);
  }
  if (Array.isArray(prev) && Array.isArray(next)) {
    return prev.length === next.length && prev.every((v, i) => v === next[i]);
  }
  return Object.is(prev, next);
}

export class PlanBoard {
  readonly facts: PlanBoardFacts;
  readonly state: Partial<Record<WorkerKind, KindState>> = {};
  readonly conflicts: ConflictEvent[] = [];

  /**
   * 记录「该字段已被写过」。冲突只在**后写覆盖前写**时发生，
   * 首轮把默认值（0 / 空表 / profile 预算）填成真实值不算撞车——
   * 否则每条正常链路都会先冒出三条假冲突，教学信号被噪声淹没。
   */
  private readonly written = new Set<keyof PlanBoardFacts>();

  constructor(profile: TripProfile, facts?: Partial<PlanBoardFacts>) {
    this.facts = {
      nights: facts?.nights ?? 0,
      // 拷贝而非持有入参引用：黑板一旦被外部对象改掉，「事实」就不再可信
      dayAnchors: { ...(facts?.dayAnchors ?? {}) },
      budgetCap: facts?.budgetCap ?? profile.budget,
      mustVisit: [...(facts?.mustVisit ?? profile.constraints.mustVisit ?? [])],
    };
  }

  /**
   * 写入事实。无权限的字段**静默丢弃**而不是抛错：
   * 黑板处在每轮循环的热路径上，一个越权字段不应该让整次编排失败；
   * 角色边界由写权限表保证（写不进去），越权本身通过 conflicts/测试暴露，不靠异常。
   */
  write(kind: WorkerKind, patch: Partial<PlanBoardFacts>): void {
    const allowed = WRITE_PERMISSION[kind];
    for (const field of Object.keys(patch) as Array<keyof PlanBoardFacts>) {
      if (!allowed.includes(field)) continue;
      const next = patch[field];
      if (next === undefined) continue;

      const prev = this.facts[field];
      const isConflict = this.written.has(field) && !sameValue(field, prev, next);

      switch (field) {
        case 'nights':
          this.facts.nights = next as number;
          break;
        case 'dayAnchors':
          this.facts.dayAnchors = { ...(next as Record<number, string>) };
          break;
        case 'budgetCap':
          this.facts.budgetCap = next as number;
          break;
        default:
          // mustVisit 等只读字段已在上面被白名单拦掉，这里不会被走到
          continue;
      }

      if (isConflict) {
        this.conflicts.push({ kind, field, from: prev, to: next });
      }
      this.written.add(field);
    }
  }

  /** 记录某个角色本轮的执行结果；后写覆盖前写，只保留最新一次 */
  recordAttempt(kind: WorkerKind, s: KindState): void {
    this.state[kind] = s;
  }

  /**
   * 生成可直接拼进 prompt 的中文事实摘要。
   *
   * 确定性要求（评测要能复现）：字段顺序固定，dayAnchors 按天升序，
   * 不含时间戳/随机数；没有的事实**整句不输出**，不写「未知」占位——
   * 占位会被模型当成已知条件，反而制造幻觉。
   *
   * `_kind` 预留给「按角色裁剪措辞」（例如对 route 强调天数、对 budget 强调上限），
   * 当前所有角色读同一份事实：共享黑板的意义就是口径一致。
   * 参数保留是为了调用点形状稳定（将来裁剪措辞时不用改所有调用方）。
   */
  summaryFor(_kind: WorkerKind): string {
    const parts: string[] = [];

    if (this.facts.nights > 0) parts.push(`住宿 ${this.facts.nights} 晚`);

    const days = Object.keys(this.facts.dayAnchors)
      .map(Number)
      .filter((d) => Number.isFinite(d))
      .sort((a, b) => a - b);
    for (const day of days) {
      parts.push(`第 ${day} 天在${this.facts.dayAnchors[day]}`);
    }

    if (this.facts.budgetCap > 0) parts.push(`预算上限 ${this.facts.budgetCap} 元`);
    if (this.facts.mustVisit.length > 0) parts.push(`必去：${this.facts.mustVisit.join('、')}`);

    return parts.length > 0 ? `已确认：${parts.join('；')}` : '';
  }
}
