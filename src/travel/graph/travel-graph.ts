/**
 * 旅游多 Agent 编排图（LangGraph.js）
 *
 * 对应原工程的 `domain/orchestration/graph-engine.ts` + `supervisor.ts`，
 * 换成 AI-Agent 项目主线的 LangGraph 实现，与既有 `src/graph/workflow.ts` 同一套写法。
 *
 * 图结构（一眼看出「哪三步并行、哪一步收口」）：
 *
 *   START ─▶ parse ─┬─(必填缺失)──────────────────────────────▶ END
 *                   └─(ready)─▶ dispatch ─┬─▶ routeWorker ────┐
 *                                         ├─▶ itineraryWorker ─┼─▶ arbitrate ─▶ END
 *                                         └─▶ budgetWorker ───┘
 *
 * 三个 worker 边同出 `dispatch`，LangGraph 会把它们放进同一个 superstep **并行执行**，
 * 三份产物写各自的状态通道、互不覆盖（这就是「不串行、也不互相污染」的框架级保证）。
 *
 * 为什么把调度正确性写在代码里而不是交给模型：
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
  /** 每角色用量快照：三个并行分支写同一通道 → 键合并，不互相覆盖 */
  usage: Annotation<Record<string, UsageSnapshot>>({
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
  checks: Annotation<CheckItem[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  cost: Annotation<{ buckets: CostBucket[]; totalCostUsd: number; totalTokens: number } | undefined>({
    reducer: (_prev, next) => next,
  }),
  summary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});

export type TravelState = typeof TravelStateAnnotation.State;

/** 把画像确定性拆成三条计划（有效计划数恒为 3，过滤不了任何一条） */
export function sanitizePlan(profile: TripProfile): Assignment[] {
  return [
    {
      kind: 'route',
      task: `为 ${profile.destination} ${profile.days} 天规划城际/景点间路线，节奏 ${profile.preferences.pace}`,
    },
    {
      kind: 'itinerary',
      task: `编排 ${profile.destination} ${profile.days} 天逐日早/午/晚行程，同行 ${profile.companions.length} 人`,
    },
    {
      kind: 'budget',
      task: `把 ${profile.budget} 元按类别分摊到 ${profile.days} 天，超支给等价替换建议`,
    },
  ];
}

/** 质检：三份产物是否满足画像的硬约束（第 7 段「量化验证」的页内版） */
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
  const lines = [
    `${profile.destination} · ${profile.days} 天 · 预算 ${profile.budget} 元 · 画像完整度 ${completeness}%`,
    `质检 ${passed}/${checks.length} 项通过${errors.length > 0 ? `，降级/异常 ${errors.length} 条` : ''}`,
  ];
  if (budget) {
    lines.push(
      budget.overBudget
        ? `预算结论：**超支**，已给 ${budget.suggestions.length} 条等价替换建议`
        : '预算结论：估算未超总预算，富余可并入备用金',
    );
  }
  lines.push(`本次 token ${cost.totalTokens}，估算成本 $${cost.totalCostUsd.toFixed(4)}`);
  return lines.join('\n');
}

/**
 * 构造编排图。
 * @param runtime 装配好的运行时（LLM + 解析器 + 三执行者）
 */
export function createTravelGraph(runtime: TravelRuntime) {
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
    const result = await worker.run({
      profile,
      traceId: state.traceId,
      llm: runtime.llm,
      forceFallback: state.forceFallback,
    });
    const patch: Partial<TravelState> = {
      usage: { [result.usage.role]: result.usage },
      sources: { [kind]: result.source ?? (result.error ? 'fallback' : 'llm') },
      errors: result.error ? [{ kind, message: result.error }] : [],
    };
    if (kind === 'route') patch.route = result.data as RoutePlan;
    if (kind === 'itinerary') patch.itinerary = result.data as ItineraryPlan;
    if (kind === 'budget') patch.budget = result.data as BudgetPlan;
    return patch;
  };

  const routeNode = (state: TravelState) => runChain('route', state);
  const itineraryNode = (state: TravelState) => runChain('itinerary', state);
  const budgetNode = (state: TravelState) => runChain('budget', state);

  /** 收口：一致性校验 + 预算守卫 + 成本归因 + 摘要 */
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
    .addEdge('arbitrate', END)
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
export function describeRuntime(): { provider: string | null; degraded: boolean; kinds: string } {
  const rt = getTravelRuntime();
  return {
    provider: rt.providerName,
    degraded: rt.forceFallback,
    kinds: ALL_WORKER_KINDS.join(' / '),
  };
}

/** 待澄清提示语（中文渲染：契约字段名不该直接甩给用户） */
export function clarifyPrompt(missing: string[]): string {
  return `还需要补充：${formatMissingFields(missing)}。补齐后我再开始并行编排。`;
}
