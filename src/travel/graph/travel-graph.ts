/**
 * 旅游多 Agent 编排图（LangGraph.js）
 *
 * 对应原工程的 `domain/orchestration/graph-engine.ts` + `supervisor.ts`，
 * 用 AI-Agent 项目主线的 LangGraph 实现，与既有 `src/graph/workflow.ts` 同一套写法。
 *
 * 图结构（一眼看出「哪三步并行、哪一步收口、哪一步重派」）：
 *
 *   START ─▶ parse ─┬─(必填缺失)──────────────────────────────────────────────▶ END
 *                   └─(ready)─▶ dispatch ─┬─▶ routeWorker ────┐
 *                                         ├─▶ itineraryWorker ─┼─▶ arbitrate ─▶ convergeGate ─▶ END
 *                                         └─▶ budgetWorker ───┘
 *
 * 三个 worker 边同出 `dispatch`，LangGraph 会把它们放进同一个 superstep **并行执行**，
 * 三份产物写各自的状态通道、互不覆盖（这就是「不串行、也不互相污染」的框架级保证）。
 *
 * ## 收敛门为什么是「直线上的一个节点」而不是一条回边
 *
 * 回边会让同一 worker 节点被多次执行，usage/errors 这些累加型通道必须能区分
 * 「第几轮的同一次调用」，checkpoint 也要能重放中间轮 —— 那是课12 reducer 的话题。
 * 本课先用「节点内部受限重派（最多 `maxRounds` 轮）」把闭环跑通：
 * 拓扑仍是 DAG，不需要任何 reducer/checkpoint 改造，学员看到的边与执行顺序一一对应。
 *
 * ## 为什么把调度正确性写在代码里而不是交给模型
 *
 * `dispatch` 的三条计划由 `sanitizePlan` 依据画像**确定性**生成，模型只负责各自子链内容，
 * 因此「三子链必被调度」是代码不变式，而不是看模型心情。
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { UsageSnapshot } from '../shared/llm';
import type {
  BudgetPlan,
  ItineraryPlan,
  RoutePlan,
  TripProfile,
} from '../shared/travel-types';
import type { ProfileParseResult } from '../shared/trip-profile';
import { formatMissingFields, profileCompleteness } from '../shared/trip-profile';
import { accumulate, summarize, type CostBucket } from '../shared/cost-model';
import { ALL_WORKER_KINDS, type WorkerKind } from '../domain/orchestration/worker-protocol';
import { PlanBoard, type ConflictEvent, type PlanBoardFacts } from '../domain/collab/plan-board';
import { converge, type RevisionDirective } from '../domain/safety/convergence';
import type { FeasibilityReport } from '../domain/safety/itinerary-quality';
import type { TravelRuntime } from '../application/travel-runtime';
import { getTravelRuntime } from '../application/travel-runtime';

/** 一条指派计划（kind + 任务描述），由画像确定性推导 */
export interface Assignment {
  kind: WorkerKind;
  task: string;
}

/** 收口质检项 */
export interface CheckItem {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** 子链错误/降级记录 */
export interface ChainError {
  kind: WorkerKind | 'parse';
  message: string;
}

/** 收敛门的一次重派事件（页面按轮次展示） */
export interface GateEvent {
  round: number;
  kind: WorkerKind;
  reason: string;
  ok: boolean;
}

export type TravelStatus = 'idle' | 'parsing' | 'pending-clarification' | 'planning' | 'done';

const TravelStateAnnotation = Annotation.Root({
  /** 用户原始输入 */
  input: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  traceId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** 强制兜底（无 Key 或用户手动勾选） */
  forceFallback: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  status: Annotation<TravelStatus>({
    reducer: (_prev, next) => next,
    default: () => 'idle',
  }),
  /** 画像解析结果（含 missing / conflicts / source） */
  profileResult: Annotation<ProfileParseResult | undefined>({
    reducer: (_prev, next) => next,
  }),
  profile: Annotation<TripProfile | undefined>({
    reducer: (_prev, next) => next,
  }),
  /** 三份子链产物 */
  route: Annotation<RoutePlan | undefined>({
    reducer: (_prev, next) => next,
  }),
  itinerary: Annotation<ItineraryPlan | undefined>({
    reducer: (_prev, next) => next,
  }),
  budget: Annotation<BudgetPlan | undefined>({
    reducer: (_prev, next) => next,
  }),
  /** 必被调度的三条计划（dispatch 产出） */
  assignments: Annotation<Assignment[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /**
   * 本次 run 的共享黑板（**per-run**，由 dispatch 节点注入）。
   *
   * 为什么走状态通道而不是实例字段：图实例是长生命周期单例（页面多次运行共用），
   * 实例字段会把「上一次 run 的事实」漏进下一次 run。通道值随一次 invoke 生灭，
   * 三个 worker 节点与 convergeGate 读到的必定是同一实例。
   * `maxRounds <= 0` 时 dispatch 不注入，通道保持 undefined ⇒ 与旧版一致。
   */
  board: Annotation<PlanBoard | undefined>({
    reducer: (_prev, next) => next,
    default: () => undefined,
  }),
  /** 黑板事实快照（供页面展示「三方共享了什么」）。黑板是可变对象，快照才可序列化 */
  boardFacts: Annotation<PlanBoardFacts | undefined>({
    reducer: (_prev, next) => next,
  }),
  /** 黑板冲突留痕（写权限之外的撞车在这里可见） */
  boardConflicts: Annotation<ConflictEvent[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** 每角色用量快照：三个并行分支写同一通道 → 键合并，不互相覆盖 */
  usage: Annotation<Record<string, UsageSnapshot>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  /**
   * 按角色归口的未解决错误（值 `undefined` = 该角色已无错误）。
   *
   * 为什么不是字符串数组：重派成功后必须能**撤销**旧错误，否则 `ok` 永远为 false，
   * 「已修好」仍被判成失败。数组只能追加、无法稳定定位某角色的条目（并行完成顺序可变），
   * map 的 key 天然是角色名，用 undefined 覆盖即完成清除。
   */
  errorsByKind: Annotation<Record<string, string | undefined>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  /** 子链产物来源：llm / fallback（降级要如实可见） */
  sources: Annotation<Record<string, 'llm' | 'fallback'>>({
    reducer: (prev, next) => ({ ...prev, ...next }),
    default: () => ({}),
  }),
  errors: Annotation<ChainError[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  /** 收口质检项（收敛门会用最终产物覆盖一次，故这里是「覆盖」而非「追加」） */
  checks: Annotation<CheckItem[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  cost: Annotation<{ buckets: CostBucket[]; totalCostUsd: number; totalTokens: number } | undefined>({
    reducer: (_prev, next) => next,
  }),
  summary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  /** 收敛门结论：是否自洽（门关闭或一次通过时恒为 true） */
  converged: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => true,
  }),
  /** 派发轮数（含首轮）；门关闭或一次通过时恒为 1 */
  rounds: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 1,
  }),
  /** 最后一轮收敛门的待改角色数 */
  revisions: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  /** 收敛门逐条重派记录 */
  gateTrace: Annotation<GateEvent[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  /** 最后一轮四维质检报告（时序/距离/预算/可达性） */
  gateReport: Annotation<FeasibilityReport | undefined>({
    reducer: (_prev, next) => next,
  }),
  /** 收敛过程产生的提示（点名理由 / 未收敛原因） */
  suggestions: Annotation<string[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
});

export type TravelState = typeof TravelStateAnnotation.State;

/** 把画像确定性拆成三条计划（有效计划数恒为 3，过滤不了任何一条） */
export function sanitizePlan(profile: TripProfile): Assignment[] {
  const from = profile.origin ? `从 ${profile.origin} 到 ` : '';
  return [
    {
      kind: 'route',
      task: `${from}${profile.destination} ${profile.days} 天规划往返大交通与城际/景点间路线，节奏 ${profile.preferences.pace}`,
    },
    {
      kind: 'itinerary',
      task: `编排 ${profile.destination} ${profile.days} 天逐日早/午/晚行程，同行 ${profile.companions.length} 人`,
    },
    {
      kind: 'budget',
      task: `把 ${profile.budget} 元按类别分摊到 ${profile.days} 天（含往返大交通），超支给等价替换建议`,
    },
  ];
}

/**
 * 把按角色归口的错误 map 摊平成 `converge()` 需要的字符串数组。
 * map 顺序由首次写入决定（并行节点顺序可变），故按固定角色顺序输出，保证结果可复现。
 */
function unresolvedErrors(errorsByKind: Record<string, string | undefined>): string[] {
  const order = ['route', 'itinerary', 'budget'];
  const kinds = [
    ...order.filter((k) => k in errorsByKind),
    ...Object.keys(errorsByKind).filter((k) => !order.includes(k)),
  ];
  return kinds
    .map((k) => errorsByKind[k])
    .filter((e): e is string => typeof e === 'string' && e.length > 0);
}

/** 降级提示不算「产物有错」（否则每次兜底都会凭空多一条失败） */
function isFallbackNotice(error: string | undefined): boolean {
  return typeof error === 'string' && error.startsWith('fallback');
}

/** 同一角色跨轮用量累加（收敛重派会让一次 run 对同一角色产生多次计费调用） */
function addUsage(into: UsageSnapshot, extra: UsageSnapshot): UsageSnapshot {
  return {
    role: into.role,
    inputTokens: into.inputTokens + extra.inputTokens,
    outputTokens: into.outputTokens + extra.outputTokens,
    totalTokens: into.totalTokens + extra.totalTokens,
    costUsd: into.costUsd + extra.costUsd,
  };
}

/** 质检：三份产物是否满足画像的硬约束（第七部分「量化验证」的页内版） */
function runChecks(
  profile: TripProfile,
  route?: RoutePlan,
  itinerary?: ItineraryPlan,
  budget?: BudgetPlan,
): CheckItem[] {
  const days = Math.max(profile.days, 1);
  const allocatedSum = (budget?.allocated ?? []).reduce((s, a) => s + a.amount, 0);
  const emptyDays = (itinerary?.planByDay ?? []).filter((d) => d.activities.length === 0).length;
  const routeDaysOk = (route?.routes ?? []).every((r) => r.day >= 1 && r.day <= days);
  const itineraryDaysOk = (itinerary?.planByDay ?? []).every((d) => d.day >= 1 && d.day <= days);
  // 大交通：路线侧算出来的往返总额，必须原样出现在预算里（否则「加到预算」就是假的）
  const routeIntercity = (route?.intercity ?? []).reduce((s, l) => s + (l.totalCost || 0), 0);
  const budgetIntercity = budget?.intercityCost ?? 0;

  return [
    {
      id: 'chains',
      label: '三子链齐全',
      ok: !!route && !!itinerary && !!budget,
      detail: `路线 ${route ? '✓' : '✗'} · 行程 ${itinerary ? '✓' : '✗'} · 预算 ${budget ? '✓' : '✗'}`,
    },
    {
      id: 'days',
      label: '天数一致',
      ok:
        !!route &&
        !!itinerary &&
        route.days === days &&
        itinerary.days === days &&
        routeDaysOk &&
        itineraryDaysOk,
      detail: `画像 ${days} 天 / 路线 ${route?.days ?? '-'} 天 / 行程 ${itinerary?.days ?? '-'} 天，day 越界 ${routeDaysOk && itineraryDaysOk ? '无' : '有'}`,
    },
    {
      id: 'coverage',
      label: '逐日有内容',
      ok: !!itinerary && emptyDays === 0 && (itinerary.planByDay ?? []).length === days,
      detail: `${(itinerary?.planByDay ?? []).length} / ${days} 天有编排，空白天 ${emptyDays}`,
    },
    {
      id: 'budget-sum',
      label: '预算分摊守恒',
      ok: !!budget && allocatedSum === budget.totalBudget,
      detail: `分配合计 ${allocatedSum} 元 vs 总额 ${budget?.totalBudget ?? '-'} 元`,
    },
    {
      id: 'intercity',
      label: '大交通计入预算',
      ok: !!route && routeIntercity === budgetIntercity,
      detail:
        routeIntercity > 0
          ? `路线侧往返 ${routeIntercity} 元 / 预算内 ${budgetIntercity} 元`
          : '未提供出发地，跳过往返大交通',
    },
    {
      id: 'over-budget',
      label: '超支守卫',
      ok: !!budget && (!budget.overBudget || budget.suggestions.length > 0),
      detail: budget?.overBudget
        ? `已判超支，给出 ${budget.suggestions.length} 条替换建议`
        : '估算未超预算',
    },
  ];
}

/** 收口摘要：说清「成了什么、哪条链降级、钱花在哪」 */
function buildSummary(
  profile: TripProfile,
  checks: CheckItem[],
  errors: ChainError[],
  cost: { totalTokens: number; totalCostUsd: number },
  budget?: BudgetPlan,
): string {
  const completeness = Math.round(profileCompleteness(profile) * 100);
  const passed = checks.filter((c) => c.ok).length;
  const where = profile.origin ? `${profile.origin} → ${profile.destination}` : profile.destination;
  const lines = [
    `${where} · ${profile.days} 天 · 预算 ${profile.budget} 元 · 画像完整度 ${completeness}%`,
    `质检 ${passed}/${checks.length} 项通过${errors.length > 0 ? `，降级/异常 ${errors.length} 条` : ''}`,
  ];
  if (budget) {
    lines.push(
      budget.overBudget
        ? `预算结论：**超支**，已给 ${budget.suggestions.length} 条等价替换建议`
        : '预算结论：估算未超总预算，富余可并入备用金',
    );
  }
  if (budget?.intercityCost && budget.intercityCost > 0) {
    lines.push(`往返大交通：¥${budget.intercityCost} 已计入预算（${where}）`);
  }
  lines.push(`本次 token ${cost.totalTokens}，估算成本 $${cost.totalCostUsd.toFixed(4)}`);
  return lines.join('\n');
}

/** 缺产物时的同形状空计划：让「worker 失败」表现为维度不通过，而不是图直接抛错 */
function emptyRoute(profile: TripProfile): RoutePlan {
  return { destination: profile.destination, days: profile.days, routes: [] };
}
function emptyItinerary(profile: TripProfile): ItineraryPlan {
  return {
    destination: profile.destination,
    days: profile.days,
    planByDay: [],
    pace: profile.preferences.pace,
  };
}
function emptyBudget(profile: TripProfile): BudgetPlan {
  return {
    destination: profile.destination,
    totalBudget: profile.budget,
    allocated: [],
    byDay: [],
    overBudget: false,
    suggestions: [],
  };
}

/**
 * 构造编排图。
 * @param runtime 装配好的运行时（LLM + 解析器 + 执行者 + 收敛门轮数）
 */
export function createTravelGraph(runtime: TravelRuntime) {
  /** 收敛门允许的局部重派轮数上限（首轮不计）；`0` = 关闭（不建黑板、不重派） */
  const maxRounds = Math.max(0, runtime.maxRounds);

  const parseNode = async (state: TravelState) => {
    const outcome = await runtime.profileService.resolve(state.input);
    if (outcome.status === 'pending-clarification') {
      return {
        status: 'pending-clarification' as TravelStatus,
        profileResult: outcome.result,
        profile: outcome.result.profile,
      };
    }
    return {
      status: 'parsing' as TravelStatus,
      profileResult: outcome.result,
      profile: outcome.result.profile,
    };
  };

  const dispatchNode = async (state: TravelState) => {
    const profile = state.profile;
    if (!profile) return { status: 'done' as TravelStatus };
    return {
      status: 'planning' as TravelStatus,
      assignments: sanitizePlan(profile),
      // 黑板 per-run：随本次 invoke 的初始状态进入图，run 结束即失去引用。
      // `maxRounds <= 0` 不建（不传 board 键，旧行为逐字节不变）。
      ...(maxRounds > 0 ? { board: new PlanBoard(profile) } : {}),
    };
  };

  /** 三个 worker 节点共用同一套包装：拿 ctx → 跑执行者 → 写状态通道 */
  const runChain = async (kind: WorkerKind, state: TravelState) => {
    const profile = state.profile;
    if (!profile) {
      return {
        errors: [{ kind, message: '画像缺失，跳过该子链' }] as ChainError[],
      };
    }
    const worker = runtime.workers[kind];
    // 任务描述来自 PlanAct 的同一份派发结果：重派改的是「哪里不自洽」，不是换一件事做
    const task = state.assignments.find((a) => a.kind === kind)?.task;
    const result = await worker.run({
      profile,
      traceId: state.traceId,
      llm: runtime.llm,
      forceFallback: state.forceFallback,
      ...(state.board ? { board: state.board } : {}),
      ...(task ? { taskDescription: task } : {}),
    });

    /** 自检跑到上限仍未通过时 ok 仍为 true、原因挂在 error —— 必须写进 errorsByKind，
     *  否则「角色自己都说没过」在编排层看不见，收敛门永远不会点名它。 */
    const selfCheckFailed = result.error && !isFallbackNotice(result.error);
    const patch: Record<string, unknown> = {
      usage: { [result.usage.role]: result.usage },
      sources: { [kind]: result.source ?? (result.error ? 'fallback' : 'llm') },
      errors: selfCheckFailed ? [{ kind, message: result.error! }] : [],
      errorsByKind: { [kind]: selfCheckFailed ? `${kind}: ${result.error}` : undefined },
    };
    if (kind === 'route') patch.route = result.data as RoutePlan;
    if (kind === 'itinerary') patch.itinerary = result.data as ItineraryPlan;
    if (kind === 'budget') patch.budget = result.data as BudgetPlan;
    return patch;
  };

  const routeNode = (state: TravelState) => runChain('route', state);
  const itineraryNode = (state: TravelState) => runChain('itinerary', state);
  const budgetNode = (state: TravelState) => runChain('budget', state);

  /** 收口：四维质检 + 预算守卫 + 成本归因 + 摘要 */
  const arbitrateNode = async (state: TravelState) => {
    const profile = state.profile;
    if (!profile) {
      return { status: 'done' as TravelStatus, summary: '画像缺失，无法收口。' };
    }
    const checks = runChecks(profile, state.route, state.itinerary, state.budget);

    const buckets = new Map<string, CostBucket>();
    for (const usage of Object.values(state.usage)) accumulate(buckets, usage);
    const cost = summarize(buckets);

    const summary = buildSummary(profile, checks, state.errors, cost, state.budget);
    return { status: 'done' as TravelStatus, checks, cost, summary };
  };

  /**
   * 收敛门节点：四维判定 → 只重派被点名的角色 → 重新判定（节点内有界循环）。
   *
   * 关闭（maxRounds <= 0）时完全透传：连 converge 都不调，返回空更新 ⇒
   * 通道保持默认（converged=true / rounds=1），图行为与没有这个节点时一致。
   */
  const convergeGateNode = async (state: TravelState) => {
    if (maxRounds <= 0) return {};
    const profile = state.profile;
    if (!profile) return {};

    const board = state.board;
    // 缺产物时用同形状空计划占位：表现为维度不通过并被点名重派，而不是在此处抛错
    let route = state.route ?? emptyRoute(profile);
    let itinerary = state.itinerary ?? emptyItinerary(profile);
    let budget = state.budget ?? emptyBudget(profile);

    // 按 kind 归口的未解决错误：首轮 worker 已写入同一通道，这里取快照继续维护。
    // 重派成功即用 undefined 清除该角色的旧错误——不清账会让「已修好」仍判成失败。
    const errorsByKind: Record<string, string | undefined> = { ...state.errorsByKind };
    const unresolved = () => unresolvedErrors(errorsByKind);

    // 未解决错误一并交给收敛门：四维看不到角色自检失败（如单段超时但日累计未超阈值），
    // 只按四维放行会把「角色自己都说没过」的方案判成收敛，定点回派永远不会被触发。
    let gate = converge({ route, itinerary, budget, profile, errors: unresolved() });
    let rounds = 1;
    const usagePatch: Record<string, UsageSnapshot> = {};
    const suggestions: string[] = [];
    const gateTrace: GateEvent[] = [];

    /**
     * 每轮：先点名，再只重派被点名的角色，重派完重新 converge。
     * `maxRounds` 是**首轮之外**的轮数上限，故条件是 `rounds - 1 < maxRounds`。
     *
     * 为什么循环放在节点内部而不是画回边：见文件头注释（避免 DAG 变环、checkpoint 重放歧义）。
     */
    while (!gate.ok && gate.revisions.length > 0 && rounds - 1 < maxRounds) {
      rounds += 1;
      suggestions.push(
        ...gate.revisions.map((r: RevisionDirective) => `收敛门点名（${r.kind}）：${r.reason}`),
      );

      for (const rev of gate.revisions) {
        // 反馈先落黑板再执行：页面随时能看到「正被要求改什么」。
        // attempts/ok 由 worker 自己记，编排层只写 lastFeedback，避免覆盖它的轮次/结论
        const st = board?.state[rev.kind];
        board?.recordAttempt(rev.kind, {
          attempts: st?.attempts ?? 1,
          ok: st?.ok ?? true,
          lastFeedback: rev.reason,
        });

        // 重派沿用首轮的任务描述：收敛门只改「哪里不自洽」，不让角色在修正轮换一件事做
        const task = state.assignments.find((a) => a.kind === rev.kind)?.task;
        const res = await runtime.workers[rev.kind].run({
          profile,
          traceId: state.traceId,
          llm: runtime.llm,
          forceFallback: state.forceFallback,
          ...(board ? { board } : {}),
          attempt: rounds,
          feedback: `${rev.reason}。修正方向：${rev.hint}`,
          ...(task ? { taskDescription: task } : {}),
        });
        gateTrace.push({ round: rounds, kind: rev.kind, reason: rev.reason, ok: res.ok });

        // 同一角色跨轮成本累加：一次 run 里它可能被调用多次（首轮 + 修正轮），
        // 只留最后一次会系统性少算成本
        const prev = usagePatch[rev.kind] ?? state.usage[rev.kind];
        usagePatch[rev.kind] = prev ? addUsage(prev, res.usage) : res.usage;

        if (!res.ok) {
          // 重派失败：保留原产物，只登记错误。清空通道会把「带病可用」变成「彻底没有」
          errorsByKind[rev.kind] = `${rev.kind}: ${res.error ?? '重派未产出可用产物'}`;
          continue;
        }
        /**
         * 与首轮 worker 同一判据：重派回来的产物若自检仍未通过，用**新错误替换旧错误**
         * （同 kind 不得两条并存）；通过则清除旧错误。
         * `fallback*` 是降级提示，不算错误（否则重派落到兜底会凭空多一条失败）。
         */
        errorsByKind[rev.kind] =
          res.error && !isFallbackNotice(res.error) ? `${rev.kind}: ${res.error}` : undefined;
        if (rev.kind === 'route') route = res.data as RoutePlan;
        else if (rev.kind === 'itinerary') itinerary = res.data as ItineraryPlan;
        else if (rev.kind === 'budget') budget = res.data as BudgetPlan;
      }

      // 重新判定一次，只为给出真实的 converged：重派可能只是「改动了但没改对」。
      // errors 传的是**清除后**的未解决错误，已修好的角色不会再把门卡住。
      gate = converge({ route, itinerary, budget, profile, errors: unresolved() });
    }

    // 轮数用尽仍不自洽：把剩余问题显式留在 suggestions 里，别让「已尝试」看起来像「已解决」
    if (!gate.ok) {
      suggestions.push(
        ...gate.revisions.map((r) => `收敛未通过（${r.kind}）：${r.reason}`),
      );
    }

    // 用**最终产物**重算质检与摘要：arbitrate 在收敛门之前，它那版已可能过时
    const checks = runChecks(profile, route, itinerary, budget);
    const mergedUsage: Record<string, UsageSnapshot> = { ...state.usage, ...usagePatch };
    const buckets = new Map<string, CostBucket>();
    for (const usage of Object.values(mergedUsage)) accumulate(buckets, usage);
    const cost = summarize(buckets);
    const finalErrors: ChainError[] = unresolvedErrors(errorsByKind).map((message) => {
      const kind = (message.split(':')[0] ?? 'route') as WorkerKind;
      return { kind, message };
    });
    const summary = buildSummary(profile, checks, finalErrors, cost, budget);

    return {
      route,
      itinerary,
      budget,
      usage: usagePatch,
      errorsByKind,
      converged: gate.ok,
      rounds,
      revisions: gate.revisions.length,
      gateTrace,
      gateReport: gate.report,
      suggestions,
      checks,
      cost,
      summary,
      boardFacts: board?.facts,
      boardConflicts: board?.conflicts ?? [],
    };
  };

  /** 解析后分流：必填缺失 → 直接结束（省掉三子链算力），齐备 → 派发 */
  const routeAfterParse = (state: TravelState) =>
    state.profileResult?.ok ? 'dispatch' : END;

  return new StateGraph(TravelStateAnnotation)
    .addNode('parse', parseNode)
    .addNode('dispatch', dispatchNode)
    .addNode('routeWorker', routeNode)
    .addNode('itineraryWorker', itineraryNode)
    .addNode('budgetWorker', budgetNode)
    .addNode('arbitrate', arbitrateNode)
    .addNode('convergeGate', convergeGateNode)
    .addEdge(START, 'parse')
    .addConditionalEdges('parse', routeAfterParse)
    // fan-out：三条边同出 dispatch → 同一 superstep 并行
    .addEdge('dispatch', 'routeWorker')
    .addEdge('dispatch', 'itineraryWorker')
    .addEdge('dispatch', 'budgetWorker')
    // fan-in：三条边同入 arbitrate → 全部完成才收口
    .addEdge('routeWorker', 'arbitrate')
    .addEdge('itineraryWorker', 'arbitrate')
    .addEdge('budgetWorker', 'arbitrate')
    // 收敛门：收口之后、结束之前，只重派被点名的角色
    .addEdge('arbitrate', 'convergeGate')
    .addEdge('convergeGate', END)
    .compile();
}

/** 页面直接消费的图实例（单例，避免每次渲染重建 provider 链） */
export const travelGraph = createTravelGraph(getTravelRuntime());

/** 一次性跑完（非流式调用/脚本验证用） */
export async function runTravelPlan(
  input: string,
  opts: { forceFallback?: boolean } = {},
): Promise<TravelState> {
  const result = await travelGraph.invoke({
    input,
    traceId: runtimeTraceId(),
    forceFallback: opts.forceFallback ?? getTravelRuntime().forceFallback,
  });
  return result as TravelState;
}

function runtimeTraceId(): string {
  return getTravelRuntime().newTraceId();
}

/** 便于页面提示「为什么这次没调模型」 */
export function describeRuntime(): {
  provider: string | null;
  degraded: boolean;
  kinds: string;
  maxRounds: number;
  toolAware: boolean;
} {
  const rt = getTravelRuntime();
  return {
    provider: rt.providerName,
    degraded: rt.forceFallback,
    kinds: ALL_WORKER_KINDS.join(' / '),
    maxRounds: rt.maxRounds,
    toolAware: rt.toolAware,
  };
}

/** 待澄清提示语（中文渲染：契约字段名不该直接甩给用户） */
export function clarifyPrompt(missing: string[]): string {
  return `还需要补充：${formatMissingFields(missing)}。补齐后我再开始并行编排。`;
}
