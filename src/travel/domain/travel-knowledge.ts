/**
 * 旅游主数据 × 经验规则兜底（第 3 段规则兜底 + 第 5 段领域角色的数据底座）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/travel/travel-knowledge.ts`（附录 A 第 11 项）。
 * 内联目的地主数据（7 个）与三大执行者的纯逻辑降级构建器 —— 不读文件，
 * 保证「没有 Key、模型挂了」时整条动线依然可复现跑通。
 *
 * 用途：
 *  1) 画像解析 phase-2 的经验规则提取（目的地识别/归一）；
 *  2) Route / Itinerary / Budget 三执行者在 LLM 不可用或失败时的兜底产物。
 */
import type { ItineraryPlan, RoutePlan, TripProfile, BudgetPlan } from '../shared/travel-types';

export type Pace = TripProfile['preferences']['pace'];
export type AccommodationLevel = TripProfile['preferences']['accommodationLevel'];

/** 目的地主数据条目 */
export interface DestinationKnowledge {
  /** 规范地名（画像/产物 destination 归一化用） */
  key: string;
  /** 别名/关键词，用于模糊匹配用户输入 */
  aliases: string[];
  /** 线内城市（云南为昆明-大理-丽江） */
  cities: string[];
  /** 著名景点 */
  attractions: string[];
  /** 当地美食 */
  foods: string[];
  /** 各住宿档位每晚均价（元） */
  perNight: Record<AccommodationLevel, number>;
  /** 交通提示（城际/市内） */
  transferNotes: string[];
}

/** 主数据表（硬编码保证可复现） */
export const DESTINATIONS: DestinationKnowledge[] = [
  {
    key: '云南',
    aliases: ['云南', '昆明', '大理', '丽江', '昆明大理丽江', 'yunnan'],
    cities: ['昆明', '大理', '丽江'],
    attractions: ['石林', '滇池', '洱海', '大理古城', '玉龙雪山', '丽江古城'],
    foods: ['过桥米线', '汽锅鸡', '野生菌火锅', '烤乳扇'],
    perNight: { economy: 180, comfort: 400, luxury: 900 },
    transferNotes: ['昆明机场→大理高铁约2h', '大理→丽江高铁约3h', '景点间建议包车'],
  },
  {
    key: '成都',
    aliases: ['成都', '天府', 'chengdu'],
    cities: ['成都'],
    attractions: ['宽窄巷子', '锦里', '武侯祠', '大熊猫基地', '青城山', '都江堰'],
    foods: ['火锅', '串串', '担担面', '夫妻肺片', '钟水饺'],
    perNight: { economy: 150, comfort: 350, luxury: 800 },
    transferNotes: ['地铁覆盖主城区', '大熊猫基地需打车/公交'],
  },
  {
    key: '北京',
    aliases: ['北京', '首都', 'beijing'],
    cities: ['北京'],
    attractions: ['故宫', '天安门', '长城', '颐和园', '天坛', '798'],
    foods: ['烤鸭', '炸酱面', '涮羊肉', '豆汁'],
    perNight: { economy: 250, comfort: 500, luxury: 1200 },
    transferNotes: ['地铁密布', '长城建议包车/城际'],
  },
  {
    key: '重庆',
    aliases: ['重庆', '山城', 'chongqing'],
    cities: ['重庆'],
    attractions: ['洪崖洞', '磁器口', '解放碑', '长江索道', '武隆天生三桥'],
    foods: ['重庆火锅', '重庆小面', '酸辣粉', '毛血旺'],
    perNight: { economy: 150, comfort: 400, luxury: 900 },
    transferNotes: ['轻轨覆盖两江四岸', '武隆需长途车/一日游'],
  },
  {
    key: '桂林',
    aliases: ['桂林', '阳朔', '桂林阳朔', 'guilin'],
    cities: ['桂林', '阳朔'],
    attractions: ['漓江', '象鼻山', '阳朔西街', '十里画廊', '龙脊梯田'],
    foods: ['桂林米粉', '啤酒鱼', '田螺酿', '油茶'],
    perNight: { economy: 140, comfort: 350, luxury: 800 },
    transferNotes: ['桂林→阳朔游漓江约4h', '龙脊梯田需包车/班车'],
  },
  {
    key: '青岛',
    aliases: ['青岛', '琴岛', 'qingdao'],
    cities: ['青岛'],
    attractions: ['栈桥', '八大关', '崂山', '金沙滩', '奥帆中心'],
    foods: ['海鲜', '青岛啤酒', '鲅鱼饺子', '笔管鱼'],
    perNight: { economy: 160, comfort: 380, luxury: 850 },
    transferNotes: ['老城适合步行', '崂山建议公交+缆车'],
  },
  {
    key: '杭州',
    aliases: ['杭州', 'hangzhou'],
    cities: ['杭州'],
    attractions: ['西湖', '灵隐寺', '宋城', '西溪湿地', '千岛湖'],
    foods: ['龙井虾仁', '东坡肉', '西湖醋鱼', '片儿川'],
    perNight: { economy: 180, comfort: 420, luxury: 950 },
    transferNotes: ['西湖周边步行+地铁', '千岛湖需高铁+船'],
  },
];

/** 逗号分隔文本 → 清单（清洗空项） */
export function splitList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[，,、;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 按关键词模糊匹配目的地主数据（未命中返回 undefined）。
 *
 * ⚠️ 匹配大小写不敏感：别名表里英文别名存小写（beijing/chengdu…），
 * 而 LLM 常返回首字母大写（Beijing）。原版用逐字比较曾导致目的地落成 `Beijing`、
 * 与金标准「北京」不匹配（画像完整度从 100% 掉到 75%）。
 */
export function findKnowledge(destination: string | undefined): DestinationKnowledge | undefined {
  const d = (destination ?? '').trim().toLowerCase();
  if (!d) return undefined;
  return DESTINATIONS.find(
    (k) =>
      k.key.toLowerCase() === d ||
      k.aliases.some((a) => a.toLowerCase() === d || d.includes(a.toLowerCase())),
  );
}

/**
 * 目的地规范化：命中主数据则归一为规范中文 key，否则原样返回。
 * 把 LLM 可能返回的英文/别名/子城市（Beijing、阳朔）统一成对外一致的规范名。
 */
export function normalizeDestination(destination: string | undefined): string {
  const d = (destination ?? '').trim();
  if (!d) return '';
  return findKnowledge(d)?.key ?? d;
}

/** 从任意文本抽取主数据中命中的目的地（经验规则识别，大小写不敏感） */
export function extractDestinationFromText(text: string): DestinationKnowledge | undefined {
  const t = (text ?? '').toLowerCase();
  for (const k of DESTINATIONS) {
    if (k.aliases.some((a) => t.includes(a.toLowerCase()))) return k;
  }
  return undefined;
}

/** 同行有效住客数（不把婴儿按全价住宿摊） */
function effectiveGuests(companions: TripProfile['companions']): number {
  const n = companions.filter((c) => c !== 'infant').length;
  return Math.max(n, 1);
}

/** 每天住宿房数（两人一间） */
function roomsPerNight(companions: TripProfile['companions']): number {
  return Math.max(1, Math.ceil(effectiveGuests(companions) / 2));
}

/** 豪华档的房价溢价（成本口径） */
export function nightlyGuestRate(level: AccommodationLevel, perNight: number): number {
  return level === 'luxury' ? Math.round(perNight * 1.4) : perNight;
}

/** 交通偏好：公共还是私有（由预算与节奏决定） */
export function transportPreference(profile: TripProfile): 'public' | 'private' | 'walk' {
  if (profile.preferences.pace === 'intensive') return 'private';
  if (profile.budget > 0 && profile.budget / (profile.days || 1) < 600) return 'walk';
  return profile.preferences.accommodationLevel === 'luxury' ? 'private' : 'public';
}

/* ------------------------------------------------------------------ */
/* Route 兜底：产出最小可用 RoutePlan                                  */
/* ------------------------------------------------------------------ */

/** 按天把景点切片，保序循环 */
function sliceAttractions(list: string[], days: number): string[] {
  const out: string[] = [];
  if (list.length === 0) return out;
  for (let d = 0; d < days; d++) out.push(list[d % list.length] as string);
  return out;
}

/** 兜底路线：目的地主数据 → 逐日景点间路线，交通/耗时按常识给定 */
export function buildFallbackRoute(profile: TripProfile): RoutePlan {
  const k = findKnowledge(profile.destination) ?? DESTINATIONS[0]!;
  const days = Math.max(profile.days, 1);
  const spots = sliceAttractions(k.attractions, days);
  const isYunnan = k.key === '云南';
  const needPrivate =
    profile.preferences.pace === 'intensive' || (k.transferNotes[0]?.includes('高铁') ?? false);

  const routes = spots.map((to, i) => {
    const multiCityTransfer = isYunnan && i > 0;
    const duration = multiCityTransfer ? 150 : 40;
    const transport: RoutePlan['routes'][number]['transport'] =
      multiCityTransfer || needPrivate ? 'taxi' : 'subway';
    return {
      day: i + 1,
      origin: i === 0 ? profile.destination || k.cities[0] : spots[i - 1],
      to,
      transport,
      estDurationMin: duration,
      estCost: transport === 'taxi' ? 80 : 5,
    } as RoutePlan['routes'][number];
  });

  return {
    destination: k.key === '云南' ? profile.destination || '云南' : k.key,
    days,
    routes,
    transportPreference: transportPreference(profile),
  };
}

/* ------------------------------------------------------------------ */
/* Itinerary 兜底：日粒度早/午/晚编排                                  */
/* ------------------------------------------------------------------ */

/** 兜底行程：节奏控制每天活动数，嵌餐饮与住宿 */
export function buildFallbackItinerary(profile: TripProfile): ItineraryPlan {
  const k = findKnowledge(profile.destination) ?? DESTINATIONS[0]!;
  const days = Math.max(profile.days, 1);
  const pace = profile.preferences.pace;
  const chosen = k.attractions;
  const food = k.foods;

  const planByDay = Array.from({ length: days }, (_, idx) => {
    const day = idx + 1;
    const from = day - 1;
    const morning = chosen[from % (chosen.length || 1)];
    const showAfternoon = pace !== 'relaxed' && chosen.length > 1;
    const first = morning ?? '城市漫步';
    const activities = [
      { name: first, type: 'attraction' as const, durationHours: 3, location: k.cities[0] },
      ...(showAfternoon
        ? [
            {
              name: chosen[(from + 1) % (chosen.length || 1)] as string,
              type: 'attraction' as const,
              durationHours: 2.5,
              location: k.cities[0],
            },
          ]
        : []),
      {
        name: food[idx % (food.length || 1)] as string,
        type: 'dining' as const,
        durationHours: 1.5,
        location: k.cities[0],
      },
      { name: '住宿休息', type: 'rest' as const, durationHours: 9, location: k.cities[0] },
    ];

    const afternoon = pace !== 'relaxed' ? activities[1] : undefined;
    return {
      day,
      morning: activities[0]!,
      afternoon,
      evening: activities[activities.length - 2]!,
      activities,
      note: `第${day}天 · ${pace === 'relaxed' ? '请放慢节奏' : pace === 'moderate' ? '张弛有度' : '紧凑打卡'}`,
    };
  });

  return {
    destination: k.key,
    days,
    planByDay,
    pace,
    totalEstimatedCost: estimateItineraryCost(profile),
  };
}

/** 估算行程总成本（住宿 + 餐饮 + 门票粗估） */
export function estimateItineraryCost(profile: TripProfile): number {
  const k = findKnowledge(profile.destination);
  if (!k) return 0;
  const days = Math.max(profile.days, 1);
  const rate = k.perNight[profile.preferences.accommodationLevel];
  const nights = Math.max(days - 1, 1);
  const lodging = rate * roomsPerNight(profile.companions) * nights;
  const dining = days * 120 * effectiveGuests(profile.companions);
  const tickets = days * 60;
  return Math.round(lodging + dining + tickets);
}

/* ------------------------------------------------------------------ */
/* Budget 兜底：按类别分摊 + 逐日 + 超支建议                           */
/* ------------------------------------------------------------------ */

/** 兜底预算：由画像预算或经验估算得到总额，再按类别占比分摊并给可执行建议 */
export function buildFallbackBudget(profile: TripProfile): BudgetPlan {
  const k = findKnowledge(profile.destination) ?? DESTINATIONS[0]!;
  const days = Math.max(profile.days, 1);
  const nights = Math.max(days - 1, 1);
  const rooms = roomsPerNight(profile.companions);
  const rate = k.perNight[profile.preferences.accommodationLevel];
  const lodging = rate * rooms * nights;
  const dining = days * 120 * effectiveGuests(profile.companions);
  const tickets = days * 60;
  const shopping = Math.round((lodging + dining) * 0.08);
  const transportEst = days * 60;
  const reserve = Math.round((lodging + dining + tickets) * 0.1);

  const estimatedTotal = Math.round(lodging + dining + tickets + transportEst + shopping + reserve);
  const totalBudget = profile.budget > 0 ? profile.budget : Math.max(estimatedTotal, 500);
  const overBudget = profile.budget > 0 && estimatedTotal > profile.budget;

  const categoryShares: Array<{
    category: BudgetPlan['allocated'][number]['category'];
    amount: number;
  }> = [
    { category: 'accommodation', amount: lodging },
    { category: 'food', amount: dining },
    { category: 'attraction', amount: tickets },
    { category: 'transport', amount: transportEst },
    { category: 'shopping', amount: shopping },
    { category: 'reserve', amount: reserve },
  ];

  // 按总预算等比缩放，保证总和 = 总额（取整漂移并入备用金）
  const shareSum = categoryShares.reduce((s, c) => s + c.amount, 0);
  const scale = shareSum > 0 ? totalBudget / shareSum : 1;
  const allocAmounts = categoryShares.map((c) => Math.round(c.amount * scale));
  const drift = totalBudget - allocAmounts.reduce((s, a) => s + a, 0);
  const reserveIdx = allocAmounts.length - 1;
  if (drift !== 0) allocAmounts[reserveIdx] = Math.max(0, (allocAmounts[reserveIdx] ?? 0) + drift);
  const allocated = categoryShares.map((c, i) => ({
    category: c.category,
    amount: allocAmounts[i] ?? 0,
    percent: Math.round(((allocAmounts[i] ?? 0) / Math.max(totalBudget, 1)) * 100),
  }));

  const byDay = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    spent: Math.round(totalBudget / days),
  }));

  const suggestions: string[] = [];
  if (overBudget) {
    const comfortRate =
      profile.preferences.accommodationLevel === 'luxury' ? k.perNight.comfort : rate;
    suggestions.push(`建议将豪华住宿降为舒适档，每晚可省 ${rate - comfortRate} 元`);
    suggestions.push('长途景点建议改乘公共交通以压缩交通预算');
    suggestions.push('购物类支出优选保留备用金，遇超支优先砍购物');
  } else if (profile.budget > 0) {
    suggestions.push('实际估算低于总预算，可将富余并入备用金或升级一晚住宿');
  }

  return {
    destination: k.key,
    totalBudget,
    allocated,
    byDay,
    overBudget,
    suggestions,
  };
}
