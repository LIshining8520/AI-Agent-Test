/**
 * Token 成本归因模型（第 7 段「量化验证」与成本可见）
 *
 * 移植自 `packages/shared/src/cost-model.ts`。
 * 按 role 归因每次 LLM 调用的 token 与美元成本，支持汇总与异常告警。
 */
import { DEFAULT_PRICE_PER_1M, type UsageSnapshot } from './llm';

export interface CostBucket {
  role: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** 从用量快照累计进入成本桶（按 role） */
export function accumulate(buckets: Map<string, CostBucket>, usage: UsageSnapshot): void {
  const b = buckets.get(usage.role) ?? {
    role: usage.role,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
  b.calls += 1;
  b.inputTokens += usage.inputTokens;
  b.outputTokens += usage.outputTokens;
  b.totalTokens += usage.totalTokens;
  b.costUsd += usage.costUsd;
  buckets.set(usage.role, b);
}

/** 把 raw token 数转成美元成本（默认单价） */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  price = DEFAULT_PRICE_PER_1M,
): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** 汇总成本：按成本降序排序，算总价与总 token */
export function summarize(buckets: Map<string, CostBucket>): {
  buckets: CostBucket[];
  totalCostUsd: number;
  totalTokens: number;
} {
  const arr = [...buckets.values()].sort((a, b) => b.costUsd - a.costUsd);
  const totalCostUsd = arr.reduce((s, b) => s + b.costUsd, 0);
  const totalTokens = arr.reduce((s, b) => s + b.totalTokens, 0);
  return { buckets: arr, totalCostUsd, totalTokens };
}

/** 成本告警：总成本超预算、或单个角色成本异常偏高 */
export function checkCostAnomaly(buckets: Map<string, CostBucket>, budgetUsd: number): string[] {
  const { buckets: arr, totalCostUsd } = summarize(buckets);
  const out: string[] = [];
  if (totalCostUsd > budgetUsd) {
    out.push(`总成本 ${totalCostUsd.toFixed(4)}$ 超过预算 ${budgetUsd}$`);
  }
  const max = arr[0];
  if (arr.length >= 2 && max && max.costUsd > (arr[1]?.costUsd ?? 1) * 10) {
    out.push(`角色 ${max.role} 成本异常偏高: ${max.costUsd.toFixed(4)}$`);
  }
  return out;
}
