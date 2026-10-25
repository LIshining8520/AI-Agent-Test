/**
 * Skills 渐进式加载（第三部分 3.5「同一能力面的两件事：Skills 与 SubAgent」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/tools/skill-registry.ts`（附录 A · domain.tools）。
 *
 * 成本主线：把「一次性把全部 skills 塞进上下文」改成「按任务阶段按需加载」，
 * 降低每次 LLM 调用的首次响应 token（上下文里少塞不相关的技能长文）。
 *
 * Skill 本身是带版本与中文说明的可注入技能文稿；注册进 {@link SkillRegistry} 后，
 * 任一编排阶段（route / itinerary / budget / supervisor）只取它需要的技能，
 * 而不是把 registry 里所有技能全量拼进 prompt。
 *
 * 测量约定：token 估算用确定性字符数近似（同一把尺子量全量与渐进，比值与语言无关），
 * {@link measureSkillsTokenReduction} 返回「渐进加载相对全量加载」的首次响应 token 降幅。
 *
 * ⚠️ 现状（与原工程一致）：本模块**未接线**到 worker 的 prompt 拼装，
 * 只提供注册表与可复现的测量口径。讲义把这句写在索引里，是为了避免
 * 「代码在、以为生效了」的误判 —— 接线前请先看本行。
 */
import type { WorkerKind } from '../orchestration/worker-protocol';
import { ALL_WORKER_KINDS } from '../orchestration/worker-protocol';

/** 一个技能：id + 版本 + 供注入的技能文稿 */
export interface Skill {
  id: string;
  name: string;
  version: string;
  /** 注入 prompt 的技能内容（中文） */
  content: string;
}

/** 可编排的阶段（含主管全局阶段；worker 阶段与 WorkerKind 对齐） */
export type SkillStage = WorkerKind | 'supervisor';

/** 技能注册表：集中维护全部技能，并按阶段按需取出所需技能内容 */
export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  /** 注册一个技能（同名覆盖，便于演进） */
  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
  }

  /** 取单个技能 */
  get(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  /** 全部技能（不被用于一次性塞进 prompt，仅供盘点/全量测量） */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  /**
   * 渐进加载：给定阶段 → 仅返回该阶段需要技能的注入文本。
   * 这是成本主线的差异点：不进上下文的技能内容永远不产生 token。
   */
  loadForStage(stage: SkillStage): string {
    return this.requiredForStage(stage)
      .map((id) => this.skills.get(id))
      .filter((s): s is Skill => !!s)
      .map((s) => `[技能 ${s.name} v${s.version}] ${s.content}`)
      .join('\n');
  }

  /** 各阶段只加载所属技能（主管全局阶段不加载技能，凭画像直接拆计划） */
  private requiredForStage(stage: SkillStage): string[] {
    switch (stage) {
      case 'route':
        return ['route-map'];
      case 'itinerary':
        return ['itinerary-maker'];
      case 'budget':
        return ['budget-travel'];
      case 'supervisor':
        return [];
    }
  }
}

/* ------------------------------------------------------------------ */
/* 内置技能                                                            */
/* ------------------------------------------------------------------ */

/** 构建默认内置技能注册表（课程用固定文案保证可复现测量） */
export function defaultSkills(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register({
    id: 'route-map',
    name: '驾车路线常识',
    version: '1.0.0',
    content:
      '同城景点间短途约 15km/25min，跨城约 60km/60min；city 内部优先 subway，跨城优先 taxi/car；' +
      '驾车约 60km/h，堵车高峰 +30% 时长。为每条路线给出历时与费用概览。',
  });
  registry.register({
    id: 'itinerary-maker',
    name: '行程表制作',
    version: '1.0.0',
    content:
      '按早/午/晚三档编排每日行程，调节奏：relaxed 每日≤3 活动、moderate 4 活动、intensive ≤6 活动；' +
      '须嵌餐饮与住宿休息，儿童/老人减活动量并延长午餐时间。输出 planByDay 日粒度结构化表格。',
  });
  registry.register({
    id: 'budget-travel',
    name: '有限预算内规划精彩旅行',
    version: '1.0.0',
    content:
      '在给定总预算内做品类分摊（accommodation/food/attraction/transport/shopping/reserve）；' +
      '超支时给出等价替换建议（降住宿档、改公共交通、砍购物）；优先保障体验亮点，备用金占比≈10%。',
  });
  return registry;
}

/* ------------------------------------------------------------------ */
/* Token 测量（确定性，可复现）                                        */
/* ------------------------------------------------------------------ */

/** 确定性 token 近似：按字符数估（同一把尺子量全量与渐进，比值稳定） */
export function estimateSkillTokens(text: string): number {
  return text.length;
}

export interface SkillsTokenReport {
  fullTokens: number;
  progressiveTokens: number;
  savedTokens: number;
  /** 渐进相对全量的首次响应 token 降幅（%） */
  reductionRate: number;
  stageProgressive: Record<string, number>;
}

/**
 * 测量「全量塞入 vs 渐进加载」的首次响应 token 差值。
 * 首次响应以「单个 worker 的一次注入上下文」为口径：Baseline 把全部技能塞进这一份上下文，
 * 渐进只塞本阶段所需技能。取三执行者中「技能注入最多」的阶段作最保守代表（保证降幅不作假）。
 *
 * 设计目标：首次响应 token 减少 ≥40%（满足即视为该成本主线达标）。
 */
export function measureSkillsTokenReduction(
  registry: SkillRegistry = defaultSkills(),
): SkillsTokenReport {
  // 全量：把全部技能一次性塞进单次响应上下文（Baseline 的坏做法）
  const fullText = registry.list().map((s) => `[技能 ${s.name}] ${s.content}`).join('\n');
  const fullTokens = estimateSkillTokens(fullText);

  const stageProgressive: Record<string, number> = {};
  for (const kind of ALL_WORKER_KINDS) {
    stageProgressive[kind] = estimateSkillTokens(registry.loadForStage(kind));
  }
  // 首次响应只发生一次注入：取三执行者中注入最多的阶段，作为「渐进」的最保守口径
  const progressiveTokens = Math.max(...ALL_WORKER_KINDS.map((k) => stageProgressive[k]!));

  const savedTokens = fullTokens - progressiveTokens;
  const reductionRate = fullTokens > 0 ? Math.round((savedTokens / fullTokens) * 1000) / 10 : 0;
  return { fullTokens, progressiveTokens, savedTokens, reductionRate, stageProgressive };
}
