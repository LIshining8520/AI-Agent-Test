/**
 * 费用统筹管家（第 6 段「预算强耦合的领域主角」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/workers/budget-worker.ts`（附录 A 第 10 项）。
 * 产出 BudgetPlan：按类别分摊、逐日花销、超支判定与等价替换建议。
 *
 * 第 6 段的核心论点：预算不是一个字段，是一套**守卫**。
 * `normalize` 里做两件事，缺一件守卫就失效：
 *  1) clampAllocatedToBudget —— 把 LLM 给的分摊**钳制**到总预算内，且合计恰好等于总额；
 *  2) overBudget 以兜底对主数据的估算为准，而不是听 LLM 主观判断（LLM 几乎永远说没超）。
 */
import type { GenerateRequest, LlmClient } from '../../shared/llm';
import type { BudgetPlan, TripProfile } from '../../shared/travel-types';
import { buildFallbackBudget, findKnowledge } from '../travel-knowledge';
import { BaseWorker, type WorkerContext } from './worker';

const CATEGORIES: Array<BudgetPlan['allocated'][number]['category']> = [
  'accommodation',
  'transport',
  'food',
  'attraction',
  'shopping',
  'reserve',
];

/**
 * 预算合规归一化：超支按比例钳制、不足差额并入备用金，最终合计恰好 = totalBudget（取整漂移归零）。
 */
function clampAllocatedToBudget(
  allocated: BudgetPlan['allocated'],
  totalBudget: number,
): BudgetPlan['allocated'] {
  const sum = allocated.reduce((s, a) => s + a.amount, 0);
  if (sum <= 0) return allocated.map((a) => ({ ...a, percent: 0 }));
  let next = allocated;
  if (sum > totalBudget) {
    const scale = totalBudget / sum;
    next = allocated.map((a) => ({ ...a, amount: Math.max(0, Math.round(a.amount * scale)) }));
  } else if (sum < totalBudget) {
    // 总额未用满：差额并入 reserve
    const shortfall = totalBudget - sum;
    next = next.map((a) =>
      a.category === 'reserve' ? { ...a, amount: a.amount + shortfall } : a,
    );
  }
  // 修正逐项取整漂移：差额并入/扣减首个正额类别，保证合计精确等于总预算
  const amounts = next.map((a) => a.amount);
  const drift = totalBudget - amounts.reduce((s, a) => s + a, 0);
  let anchor = next.findIndex((a) => a.category === 'reserve' && a.amount > 0);
  if (anchor < 0) anchor = next.findIndex((a) => a.amount > 0);
  if (anchor >= 0 && drift !== 0) {
    amounts[anchor] = Math.max(0, (amounts[anchor] ?? 0) + drift);
    next = next.map((a, idx) => ({ ...a, amount: amounts[idx] ?? a.amount }));
  }
  return next.map((a) => ({
    ...a,
    percent: Math.round((a.amount / Math.max(totalBudget, 1)) * 100),
  }));
}

export class BudgetWorker extends BaseWorker<BudgetPlan> {
  readonly kind = 'budget' as const;

  constructor(llm: LlmClient) {
    super(llm, 'BUDGET');
  }

  buildPrompt(profile: TripProfile, ctx: WorkerContext): GenerateRequest {
    const k = findKnowledge(profile.destination);
    return {
      role: 'BUDGET',
      system: [
        '你是旅游费用规划师。产出预算 JSON：',
        '{destination, totalBudget, allocated:[{category,amount,percent}], byDay:[{day,spent}], overBudget:boolean, suggestions:string[]}。',
        'category∈accommodation|transport|food|attraction|shopping|reserve。',
        '总预算需保持 allocated 合计=totalBudget，超支时给等价替换建议。',
        '只输出纯 JSON。',
      ].join(''),
      user: [
        `目的地：${profile.destination}；${profile.days}天；总预算 ${profile.budget}元；`,
        `同行：${profile.companions.join('、')}；住宿档：${profile.preferences.accommodationLevel}；节奏：${profile.preferences.pace}`,
        `主数据参考房价（每晚）：${k ? JSON.stringify(k.perNight) : ''}；美食：${k ? k.foods.join('、') : ''}`,
      ].join(''),
      temperature: ctx.temperature ?? 0.2,
    };
  }

  normalize(d: unknown, profile: TripProfile): BudgetPlan {
    const raw = (d ?? {}) as Partial<BudgetPlan>;
    const fb = this.fallback(profile);
    const total = Math.max(1, raw.totalBudget ?? profile.budget ?? fb.totalBudget);

    // 1) allocated：优先 LLM，空则用兜底；随后做合规归一化（保证合计 = 总预算）
    const rawAlloc =
      (raw.allocated ?? []).length > 0
        ? (raw.allocated ?? []).map((a) => ({
            category: CATEGORIES.includes(a.category as never) ? a.category : 'reserve',
            amount: Math.max(0, a.amount ?? 0),
            percent: a.percent ?? 0,
          }))
        : fb.allocated;
    const allocated = clampAllocatedToBudget(rawAlloc, total);
    const byDay =
      Array.isArray(raw.byDay) && raw.byDay.length > 0
        ? raw.byDay.map((x) => ({ day: x.day, spent: Math.max(0, x.spent) }))
        : fb.byDay;

    // 2) overBudget：以兜底对主数据的估算为准（LLM 主观判断不可靠）；suggestions 空时给兜底建议
    const overBudget = raw.overBudget ?? fb.overBudget;
    const suggestions =
      (raw.suggestions ?? []).length > 0 ? (raw.suggestions as string[]) : fb.suggestions;

    return {
      destination: raw.destination || profile.destination || '',
      totalBudget: total,
      allocated,
      byDay,
      overBudget,
      suggestions,
    };
  }

  fallback(profile: TripProfile): BudgetPlan {
    return buildFallbackBudget(profile);
  }
}
