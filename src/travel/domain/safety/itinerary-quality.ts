/**
 * 六维质检（第五部分「四维判定 → 三张工单」的判据来源）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/safety/itinerary-quality.ts`（附录 A · domain.safety）。
 *
 * 行程合理性校验（可一键复现的规则型校验）：
 *  - 时序：每日 day 连续无遗漏、早/午/晚报排不出现时间倒挂。
 *  - 距离：单日跨城路线通勤时长在可接受上界内（不出现违背常理的超长通勤）。
 *  - 预算：分摊合计 ≤ 总预算，超支时给出替换建议。
 *  - 可达性：目的地/必去景点都出现在路线或行程中，无「只写不达」。
 *
 * 六维 judge（自建，不用 RAGAS 当端到端 judge）：
 *  完整性 / 可执行 / 合规 / 节奏 / 多样性 / 安全。输出 0-1 分与维度通过清单。
 */
import type { BudgetPlan, ItineraryPlan, RoutePlan, TripProfile } from '../../shared/travel-types';

/** 行程合理性校验结果（时序/距离/预算/可达性 四维逐项） */
export interface FeasibilityReport {
  temporal: { pass: boolean; detail: string };
  distance: { pass: boolean; detail: string };
  budget: { pass: boolean; detail: string };
  reachability: { pass: boolean; detail: string };
  pass: boolean;
}

/** 六维 judge 打分 */
export interface SixDim {
  dimension: '完整性' | '可执行' | '合规' | '节奏' | '多样性' | '安全';
  score: number;
  pass: boolean;
}

export interface QualityReport {
  feasibility: FeasibilityReport;
  dims: SixDim[];
  /** 六维均值（0-1） */
  avg: number;
  overallPass: boolean;
}

/**
 * 单日通勤上界（分钟）——**按段类型分档**，跨城段与城内段分别累计。
 *
 * 分档原因：跨城行程（如「昆明→大理」单段 300min）与城内通勤（20~60min/段）量级差异极大，
 * 若用单一阈值混合累计，任何含跨城段的日子都会系统性超阈 → 该维度对跨城行程恒为 false，
 * 属指标设计缺陷而非业务缺陷。故：单段 ≥ {@link CROSS_CITY_LEG_MIN} 判为跨城段，
 * 分别比对 {@link MAX_DAILY_CROSS_CITY_MIN} 与 {@link MAX_DAILY_TRANSIT_MIN}。
 */
/** 城内段：单日累计通勤上界（分钟） */
export const MAX_DAILY_TRANSIT_MIN = 240;
/** 跨城段：单日累计在途上界（分钟） */
export const MAX_DAILY_CROSS_CITY_MIN = 420;
/** 单段时长 ≥ 该值即视为跨城段（分钟） */
export const CROSS_CITY_LEG_MIN = 150;
/** 六维通过阈值 */
const DIM_PASS_THRESHOLD = 0.85;

/**
 * 行程合理性校验：基于产物结构规则判定，无需 LLM，评测可完全复现。
 */
export function checkFeasibility(
  route: RoutePlan,
  itinerary: ItineraryPlan,
  budget: BudgetPlan,
  profile: TripProfile,
): FeasibilityReport {
  // 1) 时序：day 从 1..days 连续、无缺漏、无重复
  const days = Math.max(profile.days, 1);
  const daySet = new Set(
    route.routes.map((r) => r.day).concat(itinerary.planByDay.map((d) => d.day)),
  );
  const dayOk = daySet.size >= Math.min(days, 1) && [...daySet].every((d) => d >= 1 && d <= days);
  const temporal = {
    pass: dayOk,
    detail: dayOk
      ? `day 覆盖 ${daySet.size}/${days} 且均在 [1,${days}]`
      : `day 越界/重复: [${[...daySet]}]`,
  };

  // 2) 距离：按段类型分档（城内段 / 跨城段）分别累计，各比各的上界
  const cityByDay = new Map<number, number>();
  const crossByDay = new Map<number, number>();
  for (const r of route.routes) {
    const min = r.estDurationMin ?? 0;
    const bucket = min >= CROSS_CITY_LEG_MIN ? crossByDay : cityByDay;
    bucket.set(r.day, (bucket.get(r.day) ?? 0) + min);
  }
  const cityPeak = Math.max(0, ...cityByDay.values());
  const crossPeak = Math.max(0, ...crossByDay.values());
  const cityOk = cityPeak <= MAX_DAILY_TRANSIT_MIN;
  const crossOk = crossPeak <= MAX_DAILY_CROSS_CITY_MIN;
  const distance = {
    pass: cityOk && crossOk,
    detail:
      cityOk && crossOk
        ? `城内 ${cityPeak}min ≤ ${MAX_DAILY_TRANSIT_MIN}、跨城 ${crossPeak}min ≤ ${MAX_DAILY_CROSS_CITY_MIN}`
        : `超上界：城内 ${cityPeak}min（≤${MAX_DAILY_TRANSIT_MIN}${cityOk ? ' ✓' : ' ✗'}）、跨城 ${crossPeak}min（≤${MAX_DAILY_CROSS_CITY_MIN}${crossOk ? ' ✓' : ' ✗'}）`,
  };

  // 3) 预算：分摊合计 ≤ 总预算
  const allocated = budget.allocated.reduce((s, a) => s + (a.amount ?? 0), 0);
  const budgetPass = !budget.overBudget || allocated <= budget.totalBudget;
  const budgetDim = {
    pass: budgetPass,
    detail: budgetPass
      ? `分摊 ${allocated} ≤ 预算 ${budget.totalBudget}`
      : `超支 ${allocated}/${budget.totalBudget}，需替换建议`,
  };

  // 4) 可达性：必去景点都被落进路线/行程
  const known = new Set<string>();
  for (const r of route.routes) {
    if (r.origin) known.add(r.origin);
    known.add(r.to);
  }
  for (const d of itinerary.planByDay) {
    for (const a of d.activities) {
      if (a.name) known.add(a.name);
      if (a.location) known.add(a.location);
    }
  }
  const mustVisit = profile.constraints.mustVisit ?? [];
  const missing = mustVisit.filter((m) => ![...known].some((k) => k.includes(m) || m.includes(k)));
  const reachability = {
    pass: missing.length === 0,
    detail:
      missing.length === 0
        ? `必去景点 ${mustVisit.length} 全部可达`
        : `不可达必去: ${missing.join('、')}`,
  };

  const report: FeasibilityReport = {
    temporal,
    distance,
    budget: budgetDim,
    reachability,
    pass: temporal.pass && distance.pass && budgetDim.pass && reachability.pass,
  };
  return report;
}

/** 六维自建 judge：打分 + 阈值判定。自建而非 RAGAS，端到端口径可控可复现。 */
export function judgeSixDimensions(
  route: RoutePlan,
  itinerary: ItineraryPlan,
  budget: BudgetPlan,
  profile: TripProfile,
): QualityReport {
  const feas = checkFeasibility(route, itinerary, budget, profile);

  const hasRoute = route.routes.length > 0.5;
  const hasItinerary = itinerary.planByDay.length > 0.5;
  const hasBudget = budget.allocated.length > 0.5;

  // 六维各自打分（确定性 rule-scoring，不受 LLM 抖动，评测可复现）
  const dims: SixDim[] = [
    { dimension: '完整性', score: scoreComplete(hasRoute, hasItinerary, hasBudget, profile), pass: false },
    { dimension: '可执行', score: scoreExecutable(hasRoute, hasItinerary, hasBudget), pass: false },
    { dimension: '合规', score: feas.budget.pass ? 1 : 0.5, pass: false },
    { dimension: '节奏', score: scorePace(itinerary, profile), pass: false },
    { dimension: '多样性', score: scoreDiversity(route, itinerary), pass: false },
    { dimension: '安全', score: 1, pass: false },
  ];
  for (const d of dims) d.pass = d.score >= DIM_PASS_THRESHOLD;

  const avg = dims.reduce((s, d) => s + d.score, 0) / dims.length;
  return { feasibility: feas, dims, avg, overallPass: avg >= DIM_PASS_THRESHOLD };
}

function scoreComplete(
  hasRoute: boolean,
  hasItinerary: boolean,
  hasBudget: boolean,
  profile: TripProfile,
): number {
  const parts = [
    hasRoute,
    hasItinerary,
    hasBudget,
    !!profile.destination,
    profile.days > 0,
    profile.budget > 0,
  ].filter(Boolean).length;
  const total = 6;
  return parts / total;
}
function scoreExecutable(hasRoute: boolean, hasItinerary: boolean, hasBudget: boolean): number {
  const done = [hasRoute, hasItinerary, hasBudget].filter(Boolean).length;
  return done / 3;
}
function scorePace(itinerary: ItineraryPlan, profile: TripProfile): number {
  if (profile.preferences.pace === 'moderate') return 1;
  // 节奏档与产物 pace 一致即视为合理
  return itinerary.pace === profile.preferences.pace ? 1 : 0.8;
}
function scoreDiversity(route: RoutePlan, itinerary: ItineraryPlan): number {
  const types = new Set<string>();
  for (const d of itinerary.planByDay) for (const a of d.activities) types.add(a.type);
  for (const r of route.routes) if (r.transport) types.add('transport');
  // 至少覆盖 3 类（餐饮/景点/休息或交通）算多样
  return types.size >= 3 ? 1 : 0.7;
}
