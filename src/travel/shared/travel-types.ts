/**
 * 旅游领域通用类型（画像 / 三子链共享）
 *
 * 移植自 `packages/shared/src/travel-types.ts`（附录 A 第 1-2 项）。
 * 路线 Route / 行程 Itinerary（日粒度）/ 费用 Budget 三大子任务契约。
 */

/** 同行人构成 */
export type Companion = 'adult' | 'elder' | 'child' | 'infant';

/**
 * 旅游画像：一句话需求的结构化产物（第 2 段「画像契约」的主角）
 *
 * 为什么是 interface 而不是一段 prompt：契约能被 TS 静态校验、能被下游三个
 * 执行者共享、缺失字段可诊断（missing）、字段间矛盾可检测（conflicts）。
 */
export interface TripProfile {
  destination: string;
  days: number;
  budget: number; // 总预算（元）
  companions: Companion[];
  preferences: {
    pace: 'relaxed' | 'moderate' | 'intensive';
    interests: string[]; // 自然/人文/美食/购物/亲子/摄影等
    accommodationLevel: 'economy' | 'comfort' | 'luxury';
    diet: string[]; // 过敏/清真/素食等
  };
  constraints: {
    startDate?: string; // ISO date
    mustVisit: string[]; // 必去景点
    avoid: string[]; // 需规避
  };
}

/** 单个活动 */
export interface Activity {
  name: string;
  type: 'attraction' | 'dining' | 'hotel' | 'transport' | 'rest';
  durationHours: number;
  cost?: number; // 预估费用（元）
  location?: string;
  poiId?: string; // 地图 POI 标识（课 11 挂载后填充）
}

/** 单日行程单元 */
export interface DayPlan {
  day: number;
  date?: string;
  morning?: Activity;
  afternoon?: Activity;
  evening?: Activity;
  activities: Activity[];
  note?: string;
}

/** 路线计划：三子链之一 */
export interface RoutePlan {
  destination: string;
  days: number;
  routes: Array<{
    day: number;
    origin?: string;
    to: string;
    transport: 'walk' | 'subway' | 'bus' | 'taxi' | 'car';
    estDurationMin: number;
    estCost?: number;
  }>;
  transportPreference?: 'public' | 'private' | 'walk';
}

/** 行程计划：三子链之二（日粒度编排） */
export interface ItineraryPlan {
  destination: string;
  days: number;
  planByDay: DayPlan[];
  pace: 'relaxed' | 'moderate' | 'intensive';
  totalEstimatedCost?: number;
}

/** 费用计划：三子链之三（预算分摊） */
export interface BudgetPlan {
  destination: string;
  totalBudget: number;
  allocated: Array<{
    category: 'accommodation' | 'transport' | 'food' | 'attraction' | 'shopping' | 'reserve';
    amount: number;
    percent: number;
  }>;
  byDay: Array<{ day: number; spent: number }>;
  overBudget: boolean;
  suggestions: string[]; // 超支时的等价替换建议
}

/** 编排收口的完整规划产物 */
export interface TravelPlan {
  profile: TripProfile;
  route: RoutePlan;
  itinerary: ItineraryPlan;
  budget: BudgetPlan;
  summary: string;
  createdAt: string;
  traceId: string;
}
