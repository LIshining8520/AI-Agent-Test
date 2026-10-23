/**
 * 行程执行者（第 5 段三子链之二）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/workers/itinerary-worker.ts`（附录 A 第 9 项）。
 * 基于画像产出日粒度计划 ItineraryPlan（逐日早/午/晚编排 + 节奏控制）。
 *
 * 这个文件里藏着两个真实踩坑，都是「静默失效」类型，值得原样保留：
 *  1) prompt 把时段形状写模糊 → 模型稳定返回**嵌套** `{morning:{activities:[...]}}`，
 *     而 normalize 只认扁平 `morning.name`，于是每天 activities 归零、5 天内容整体丢失；
 *  2) 只保证 planByDay 长度 = days，day 字段却直接采用 LLM 值 → 越界/0 基序号让时序校验判否。
 */
import type { GenerateRequest, LlmClient } from '../../shared/llm';
import type { Activity, ItineraryPlan, TripProfile } from '../../shared/travel-types';
import { buildFallbackItinerary, findKnowledge } from '../travel-knowledge';
import { BaseWorker, clampDay, type WorkerContext } from './worker';

interface RawSlotInput {
  /** 扁平形状：单个 Activity（`{name,type,durationHours}`） */
  name?: string;
  /** 嵌套形状：LLM 常把「一个时段」写成 `{activities:[...], note}` */
  activities?: Array<Partial<Activity>>;
  note?: string;
}
interface RawDayInput {
  day?: number;
  morning?: RawSlotInput;
  afternoon?: RawSlotInput;
  evening?: RawSlotInput;
  activities?: Array<Partial<Activity>>;
  note?: string;
}
interface RawItineraryInput {
  destination?: string;
  days?: number;
  planByDay?: RawDayInput[];
  pace?: ItineraryPlan['pace'];
  totalEstimatedCost?: number;
}

const ACTIVITY_TYPES: Array<Activity['type']> = [
  'attraction',
  'dining',
  'hotel',
  'transport',
  'rest',
];
const PACES: Array<ItineraryPlan['pace']> = ['relaxed', 'moderate', 'intensive'];

export class ItineraryWorker extends BaseWorker<ItineraryPlan> {
  readonly kind = 'itinerary' as const;

  constructor(llm: LlmClient) {
    super(llm, 'ITINERARY');
  }

  buildPrompt(profile: TripProfile, ctx: WorkerContext): GenerateRequest {
    const k = findKnowledge(profile.destination);
    return {
      role: 'ITINERARY',
      system: [
        '你是旅游行程编排师。产出 JSON：',
        // ⚠️ 形状必须写死为**扁平** Activity。此前写成「morning/afternoon(afternoon?)/evening(早/午/晚), activities[]」，
        // 括号与顿号让「时段」与「清单」的从属关系不明 —— 模型会稳定返回嵌套形状，
        // 而 normalize 只认扁平，导致「方案有骨架、无内容」且不报错。
        '{destination, days, pace, planByDay:[{day, morning:{name,type,durationHours,cost}, ',
        'afternoon:{name,type,durationHours,cost}, evening:{name,type,durationHours,cost}, ',
        'activities:[{name,type,durationHours,cost}], note}]}。',
        '每个 activity: {name, type:attraction|dining|hotel|rest, durationHours, cost?}。',
        `节奏 pace∈relaxed|moderate|intensive；客源 ${profile.companions.join('、')}，须嵌餐饮与住宿休息。`,
        '只输出纯 JSON。',
      ].join(''),
      user: [
        `目的地：${profile.destination}；${profile.days}天；节奏：${profile.preferences.pace}；`,
        `兴趣：${profile.preferences.interests.join(',')}；必去：${profile.constraints.mustVisit.join(',')}`,
        `参考主数据景点：${k ? k.attractions.join('、') : ''}`,
      ].join(''),
      temperature: ctx.temperature ?? 0.2,
    };
  }

  normalize(d: unknown, profile: TripProfile): ItineraryPlan {
    const raw = (d ?? {}) as RawItineraryInput;
    const days = Math.max(profile.days, 1);

    const planByDay = Array.from({ length: days }, (_, i) => {
      const src = raw.planByDay?.[i];
      const activities = (src?.activities ?? [])
        .filter((a) => a && typeof a.name === 'string' && a.name.trim())
        .map((a) => this.coerceActivity(a));
      const morning = this.slot(src?.morning);
      const afternoon = this.slot(src?.afternoon);
      const evening = this.slot(src?.evening);
      const fallbackActivities = [morning, afternoon, evening].filter((a): a is Activity => !!a);
      return {
        day: clampDay(src?.day, i + 1, days),
        morning,
        afternoon,
        evening,
        // 显式清单缺失时用早/午/晚三档兜底，保证逐日都有可执行内容
        activities: activities.length > 0 ? activities : fallbackActivities,
        note: src?.note,
      };
    });

    // 🔴 兜底：LLM 给了 planByDay 但一天都没解析出内容 → 全量走主数据兜底，
    // 而不是交出「5 天全空」的方案（与原版 Java 轨 `planByDay.isEmpty() ? fallback` 守卫同口径）。
    const emptyDays = planByDay.filter((d) => d.activities.length === 0).length;
    const fallback = emptyDays === planByDay.length ? this.fallback(profile) : null;

    return {
      destination: raw.destination || profile.destination || '',
      days,
      planByDay: fallback ? fallback.planByDay : planByDay,
      pace: PACES.includes(raw.pace as never)
        ? (raw.pace as ItineraryPlan['pace'])
        : profile.preferences.pace,
      totalEstimatedCost:
        raw.totalEstimatedCost ?? fallback?.totalEstimatedCost ?? this.fallback(profile).totalEstimatedCost,
    };
  }

  /**
   * 解析一个时段（早/午/晚）：**兼容两种形状**。
   *
   * 扁平 `{name,type,durationHours}` —— prompt 声明的形状；
   * 嵌套 `{activities:[...], note}` —— 模型实际常返回的形状。
   *
   * 两者都要认：契约里 morning/afternoon/evening 是**单个 Activity**，
   * 而模型把「时段」理解成「一组活动」。只认扁平时，嵌套返回会让三个时段与整日清单同时归零。
   */
  private slot(s: RawSlotInput | undefined): Activity | undefined {
    if (!s) return undefined;
    if (typeof s.name === 'string' && s.name.trim()) {
      return this.coerceActivity(s as Partial<Activity>);
    }
    const list = s.activities ?? [];
    for (const a of list) {
      if (a && typeof a.name === 'string' && a.name.trim()) return this.coerceActivity(a);
    }
    return undefined;
  }

  fallback(profile: TripProfile): ItineraryPlan {
    return buildFallbackItinerary(profile);
  }

  private coerceActivity(a: Partial<Activity>): Activity {
    const name = (a.name ?? '').trim();
    // 类型归一：模型常见「中文餐食名 + 空 type」→ 按名字补回 dining（业务语义保真）
    let type = ACTIVITY_TYPES.includes(a.type as never) ? (a.type as Activity['type']) : undefined;
    if (!type) {
      if (
        /(餐|饭|食|粉|面|菜|火锅|烧烤|小吃)/.test(name) ||
        /dinner|lunch|breakfast/i.test(name)
      ) {
        type = 'dining';
      } else if (/(酒店|住宿|民宿|休息|回房)/.test(name)) {
        type = 'hotel';
      } else {
        type = 'attraction';
      }
    }
    return {
      name,
      type,
      durationHours: Math.max(0.5, a.durationHours ?? 2),
      cost: a.cost,
      location: a.location,
    };
  }
}
