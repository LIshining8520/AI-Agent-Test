/**
 * 收敛门（第五部分「局部重派，谁改谁负责」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/safety/convergence.ts`（附录 A · domain.safety）。
 *
 * 三方产物（route / itinerary / budget）是否自洽，以及「不自洽时该让谁去改」。
 *
 * 设计取舍：
 *  - **判据不重写**。四维判定全部委托 {@link checkFeasibility}，本模块只做「维度 → 责任角色」
 *    的分派。否则质检口径会分叉：质检说通过、收敛门说不通过，学员无从判断信谁。
 *  - **四维之外还看角色自检错误**：四维只判「产物之间是否自洽」，判不了「角色自己说没过」
 *    （如单段超时但日累计未超阈值）。`errors` 按 `kind:` 前缀归口到角色，与四维指令合并去重；
 *    无前缀的编排级错误只影响 `ok`，不产生派发指令。
 *  - **只产出指令、不执行重派**。`revisions` 是给编排层的输入（`kind` 精确到角色），
 *    重派轮数、调用预算由编排层控制；本模块保持纯函数，可离线复现、可单测。
 *  - **不调 LLM、不读环境、不打日志、无时间戳**：同一输入永远同一输出。
 *
 * 映射规则（为什么这么分派）：
 *  | 维度 | 不过时派给 | 理由 |
 *  |:---|:---|:---|
 *  | temporal | itinerary | 时序是「每天排什么、排在第几天」，载体是 itinerary 的 planByDay。
 *  |          | 注意 temporal 的判定取 route.routes 与 planByDay 的**并集**，越界可能来自路线侧；
 *  |          | 但 distance / reachability 各自独立成条，只要路线侧真有问题，route 那条会同时出现，
 *  |          | 所以这里不重复把 temporal 归给 route——否则同一根因会派两次。 |
 *  | distance | route | 通勤时长/距离来自 route.routes[].estDurationMin，只有路线侧能改。 |
 *  | budget   | budget | 分摊合计与 reserve 是 budget.allocated 的事，其他角色无权改。 |
 *  | reachability | route | 必去景点靠 route 的节点（origin → to）落地；行程里的活动名
 *  |          | 只是「提到」，不等于「到得了」。补一段抵达路线才是修复。 |
 */
import type { BudgetPlan, ItineraryPlan, RoutePlan, TripProfile } from '../../shared/travel-types';
import { checkFeasibility, type FeasibilityReport } from './itinerary-quality';

/** 一条局部重派指令：改哪个角色、为什么（引用质检原文）、怎么改 */
export interface RevisionDirective {
  kind: 'route' | 'itinerary' | 'budget';
  reason: string;
  hint: string;
}

/** 收敛结论：是否自洽 + 待重派指令 + 原始质检报告（供观测/评测留证） */
export interface ConvergeResult {
  ok: boolean;
  revisions: RevisionDirective[];
  report: FeasibilityReport;
}

/** 距离类问题的修法：落在「单段时长」上，而不是笼统说「优化路线」 */
const HINT_ROUTE_DISTANCE =
  '把单段通勤压到 90 分钟内：合并同区域景点、把跨城段挪到当天不排景点的时段，或改乘公共交通；改完同步 route.routes 的 estDurationMin';
/** 可达性类问题的修法：必须补「抵达段」，而非只在行程里写名字 */
const HINT_ROUTE_REACHABILITY =
  '把未落地的必去景点补进 route.routes：为它补一段 origin → to 的抵达段，或调整当天顺序让它顺路可达';
/** 时序类问题的修法：日号连续 + 时段不倒挂 */
const HINT_ITINERARY =
  '按 day=1..N 补齐每日 planByDay，保证每天的路线与活动落在同一天，且早/午/晚不出现时间倒挂';
/** 预算类问题的修法：压分摊 + 保正 reserve */
const HINT_BUDGET =
  '把分摊合计压到预算上限内：住宿/交通降一档或替换等价项，并确保 reserve 不为负';
/**
 * 自检失败类问题的修法：只按失败原因改被点名的字段。
 * 与四维 hint 并列，避免把「自检没通过」误写成「重做整个产物」。
 */
const HINT_SELF_CHECK = '按上述自检失败原因修正产物后重新输出；只改被点名的字段';

/** 错误文本的 kind 前缀（`route: ...` / `itinerary: ...` / `budget: ...`） */
const KIND_ERROR = /^(route|itinerary|budget):\s*([\s\S]+)$/;

/** 派发指令的固定顺序：与四维映射表一致，保证输出可断言 */
const KIND_ORDER: Record<RevisionDirective['kind'], number> = {
  route: 0,
  itinerary: 1,
  budget: 2,
};

/**
 * 收敛门：复用 `checkFeasibility` 四维，把不通过的维度映射成定点重派指令。
 *
 * `revisions` 顺序固定 route → itinerary → budget，且同 kind 只出现一次
 * （避免编排层对同一角色重复计费调用）；同 kind 多个维度不过时，
 * `reason` 用「；」拼接各维度 `detail` 原文，不自行改写质检措辞。
 */
export function converge(input: {
  route: RoutePlan;
  itinerary: ItineraryPlan;
  budget: BudgetPlan;
  profile: TripProfile;
  /**
   * 编排层当前的未解决错误（`kind: 原因` 形状）。
   *
   * 为什么收敛门必须看它：四维质检只能判「产物之间是否自洽」，
   * 看不到角色内自检的失败（例如单段 150min 超过 90min 上限，但日累计未超阈值——
   * 四维全过、自检却明确说了不合格）。只按四维放行，等于把「角色自己都说没通过」
   * 的方案判成收敛，定点回派永远不会被触发。
   *
   * 无 kind 前缀的错误（如 `worker 异常: ...`）无法归责到角色，**解析时忽略**；
   * 但只要有错误文本，`ok` 就不会为真（存在未解决问题 ≠ 自洽）。
   */
  errors?: string[];
}): ConvergeResult {
  const { route, itinerary, budget, profile } = input;

  // 单一事实来源：四维判定与 `pass` 聚合都在这里，本模块不重算
  const report = checkFeasibility(route, itinerary, budget, profile);

  const revisions: RevisionDirective[] = [];

  // 1) route：distance（通勤时长）与 reachability（必去点落地）都归路线侧，
  //    两个维度可能同时不过，合并成一条指令，避免同角色被派两次
  const routeReasons: string[] = [];
  const routeHints: string[] = [];
  if (!report.distance.pass) {
    routeReasons.push(report.distance.detail);
    routeHints.push(HINT_ROUTE_DISTANCE);
  }
  if (!report.reachability.pass) {
    routeReasons.push(report.reachability.detail);
    routeHints.push(HINT_ROUTE_REACHABILITY);
  }
  if (routeReasons.length > 0) {
    revisions.push({
      kind: 'route',
      reason: routeReasons.join('；'),
      hint: routeHints.join('；'),
    });
  }

  // 2) itinerary：时序/节奏。day 号越界或重复意味着「排期」错了，由行程侧重排
  if (!report.temporal.pass) {
    revisions.push({
      kind: 'itinerary',
      reason: report.temporal.detail,
      hint: HINT_ITINERARY,
    });
  }

  // 3) budget：分摊超上限。预算角色唯一有权改 allocated / reserve
  if (!report.budget.pass) {
    revisions.push({
      kind: 'budget',
      reason: report.budget.detail,
      hint: HINT_BUDGET,
    });
  }

  // 4) 角色内自检失败：四维看不到，但同样是「未解决」。
  // 每个 kind 只产出一条指令（同 kind 多条错误用「；」拼接原文）；
  // 若该 kind 已被四维点名，则把错误原因并入同一条 reason，不新增第二条——
  // 否则编排层会对同一角色派两次，成本翻倍且两次反馈互相矛盾。
  const errorsByKind = new Map<RevisionDirective['kind'], string[]>();
  for (const raw of input.errors ?? []) {
    const matched = KIND_ERROR.exec(raw.trim());
    if (!matched) continue; // 无 kind 前缀（worker 异常等）：无法归责，忽略
    const kind = matched[1] as RevisionDirective['kind'];
    const reason = (matched[2] ?? '').trim();
    if (!reason) continue;
    const list = errorsByKind.get(kind) ?? [];
    list.push(reason);
    errorsByKind.set(kind, list);
  }
  for (const [kind, reasons] of errorsByKind) {
    const existing = revisions.find((r) => r.kind === kind);
    if (existing) {
      existing.reason = `${existing.reason}；${reasons.join('；')}`;
    } else {
      revisions.push({ kind, reason: reasons.join('；'), hint: HINT_SELF_CHECK });
    }
  }
  revisions.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  // ok 直接取 report.pass 已不足够：四维全过仍可能有「角色自检没过」的错误未解决。
  // 用 report.pass 与 errors 空集共同判定，保证「收敛」= 没有已知的未解决问题。
  return {
    ok: report.pass && (input.errors?.length ?? 0) === 0,
    revisions,
    report,
  };
}
