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
  /** 出发地/始发地（可空：用户没说时不做大交通估算，不阻塞编排） */
  origin: string;
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
  /** 配图地址（仅景点有；走本站 /api/image 代理，懒加载） */
  imageUrl?: string;
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

/** 城际大交通方式（出发地 ⇄ 目的地） */
export type IntercityMode = 'flight' | 'high-speed-rail' | 'train' | 'bus' | 'drive';

/**
 * 一段城际大交通（出发地 ⇄ 目的地）。
 *
 * 与 `routes`（城内/景点间）分开建模：大交通是**一次性、大额、不可压缩**的成本，
 * 而城内交通是按天摊销的小额支出 —— 混在一起会让预算守卫失准。
 */
export interface IntercityLeg {
  direction: 'outbound' | 'return';
  from: string;
  to: string;
  mode: IntercityMode;
  estDurationMin: number;
  /** 单人票价（元） */
  unitCost: number;
  /** 该段总价 = 单人票价 × 计费人数（儿童半价、婴儿 0.1 折算） */
  totalCost: number;
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
  /** 往返大交通（出发地 ⇄ 目的地）；未提供出发地时为空 */
  intercity?: IntercityLeg[];
  /** 出境游的签证/入境手续提示（境内目的地为空） */
  entryNotes?: string[];
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
    category:
      | 'intercity'
      | 'accommodation'
      | 'transport'
      | 'food'
      | 'attraction'
      | 'shopping'
      | 'reserve';
    amount: number;
    percent: number;
  }>;
  byDay: Array<{ day: number; spent: number }>;
  overBudget: boolean;
  suggestions: string[]; // 超支时的等价替换建议
  /** 往返大交通合计（元），便于页面直接展示与质检核对 */
  intercityCost?: number;
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
