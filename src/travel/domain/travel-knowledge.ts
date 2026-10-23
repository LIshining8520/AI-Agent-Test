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
import type {
  Companion,
  IntercityLeg,
  IntercityMode,
  ItineraryPlan,
  RoutePlan,
  TripProfile,
  BudgetPlan,
} from '../shared/travel-types';

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
/* 城际大交通：坐标表 + 距离/票价经验模型（出发地 ⇄ 目的地）             */
/* ------------------------------------------------------------------ */

/**
 * 主要城市经纬度（粗粒度）。
 *
 * 只用来算**直线距离**再乘线路系数，不做精确导航 —— 目标是「量级正确」：
 * 杭州→昆明该给飞机票钱，杭州→南京该给高铁票钱，而不是拿一个固定值糊弄。
 */
export const CITY_COORDS: Record<string, [number, number]> = {
  北京: [39.9, 116.4],
  上海: [31.23, 121.47],
  杭州: [30.25, 120.16],
  南京: [32.06, 118.8],
  苏州: [31.3, 120.58],
  宁波: [29.87, 121.55],
  广州: [23.13, 113.26],
  深圳: [22.54, 114.06],
  成都: [30.57, 104.07],
  重庆: [29.56, 106.55],
  昆明: [25.04, 102.72],
  大理: [25.61, 100.27],
  丽江: [26.87, 100.23],
  桂林: [25.27, 110.29],
  阳朔: [24.78, 110.49],
  青岛: [36.07, 120.38],
  西安: [34.34, 108.94],
  武汉: [30.59, 114.31],
  长沙: [28.23, 112.94],
  郑州: [34.75, 113.62],
  天津: [39.08, 117.2],
  济南: [36.65, 117.12],
  厦门: [24.48, 118.09],
  福州: [26.07, 119.3],
  三亚: [18.25, 109.51],
  贵阳: [26.65, 106.63],
  南宁: [22.82, 108.32],
  哈尔滨: [45.8, 126.53],
  沈阳: [41.8, 123.43],
  大连: [38.91, 121.61],
  呼和浩特: [40.84, 111.75],
  乌鲁木齐: [43.83, 87.62],
  拉萨: [29.65, 91.14],
};

/** 大交通方式的中文渲染 */
export const INTERCITY_MODE_LABEL: Readonly<Record<IntercityMode, string>> = {
  flight: '飞机',
  'high-speed-rail': '高铁',
  train: '普速列车',
  bus: '长途汽车',
  drive: '自驾',
};

/** 把用户写的城市名收敛到坐标表里的规范名（容忍「杭州市」「浙江杭州」等写法） */
export function resolveCity(raw: string | undefined): string | undefined {
  const t = (raw ?? '').trim().replace(/[市省]$/g, '');
  if (!t) return undefined;
  if (CITY_COORDS[t]) return t;
  const keys = Object.keys(CITY_COORDS).sort((a, b) => b.length - a.length);
  // 长名优先，避免「乌鲁木齐」被更短的城市名截走
  return keys.find((k) => t.includes(k)) ?? keys.find((k) => k.includes(t) && t.length >= 2);
}

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** 计费人数折算：儿童半价、婴儿 0.1（与住宿口径一致，不按成人全价摊） */
export function ticketUnits(companions: Companion[]): number {
  const units = (companions ?? []).reduce(
    (s, c) => s + (c === 'child' ? 0.5 : c === 'infant' ? 0.1 : 1),
    0,
  );
  return Math.max(0.1, Math.round(units * 10) / 10);
}

const round5 = (n: number) => Math.round(n / 5) * 5;

/**
 * 按距离选大交通方式并给出票价/耗时。
 *
 * 经验口径（2026 年国内均价，取整到 5 元）：
 *  - ≤120km   ：长途汽车，约 0.3 元/公里；
 *  - ≤1200km  ：高铁二等座，约 0.42 元/公里（地面里程按直线的 1.2 倍折算）；
 *  - >1200km  ：飞机经济舱，约 0.42 元/公里 + 100 元机建燃油。
 */
function planIntercity(km: number): {
  mode: IntercityMode;
  minutes: number;
  unitCost: number;
} {
  if (km <= 120) {
    const ground = km * 1.2;
    return {
      mode: 'bus',
      minutes: Math.max(30, Math.round((ground / 70) * 60) + 10),
      unitCost: Math.max(15, round5(ground * 0.3)),
    };
  }
  if (km <= 1200) {
    const ground = km * 1.2;
    return {
      mode: 'high-speed-rail',
      // 高铁含进站安检约 40 分钟；均速按 280km/h
      minutes: Math.round((ground / 280) * 60) + 40,
      unitCost: Math.max(30, round5(ground * 0.42)),
    };
  }
  const air = km * 1.15;
  return {
    mode: 'flight',
    // 机场流程 90 分钟 + 巡航 + 落地取行李 40 分钟；巡航按 750km/h
    minutes: 90 + Math.round((air / 750) * 60) + 40,
    unitCost: Math.max(300, round5(air * 0.42 + 100)),
  };
}

/**
 * 估算「出发地 ⇄ 目的地」往返大交通。
 *
 * 返回空数组的三种情况（都不阻塞编排，只是预算里没有大交通这一项）：
 *  1) 用户没给出发地；2) 出发地/目的地不在坐标表里；3) 出发地就是目的地。
 */
export function estimateIntercity(profile: TripProfile): IntercityLeg[] {
  const originCity = resolveCity(profile.origin);
  const k = findKnowledge(profile.destination);
  const destCity =
    resolveCity(k?.cities?.[0]) ?? resolveCity(profile.destination) ?? undefined;
  if (!originCity || !destCity || originCity === destCity) return [];

  const km = haversineKm(CITY_COORDS[originCity]!, CITY_COORDS[destCity]!);
  const plan = planIntercity(km);
  const units = ticketUnits(profile.companions);
  const note = `${km} 公里 · ${INTERCITY_MODE_LABEL[plan.mode]}约 ${Math.round(plan.minutes / 60)} 小时`;

  const leg = (direction: IntercityLeg['direction']): IntercityLeg => ({
    direction,
    from: direction === 'outbound' ? originCity : destCity,
    to: direction === 'outbound' ? destCity : originCity,
    mode: plan.mode,
    estDurationMin: plan.minutes,
    unitCost: plan.unitCost,
    totalCost: Math.round(plan.unitCost * units),
    note,
  });
  return [leg('outbound'), leg('return')];
}

/** 往返大交通合计（元） */
export function intercityTotal(legs: IntercityLeg[] | undefined): number {
  return (legs ?? []).reduce((s, l) => s + (l.totalCost || 0), 0);
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
    // 往返大交通：出发地缺失时为空数组，不影响城内路线
    intercity: estimateIntercity(profile),
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

  // 往返大交通：一次性大额支出，必须计入估算总额，否则「超支守卫」会漏判
  const intercity = intercityTotal(estimateIntercity(profile));

  const estimatedTotal = Math.round(
    lodging + dining + tickets + transportEst + shopping + reserve + intercity,
  );
  const totalBudget = profile.budget > 0 ? profile.budget : Math.max(estimatedTotal, 500);
  const overBudget = profile.budget > 0 && estimatedTotal > profile.budget;

  // 大交通是刚性成本：先从总预算里全额切出来，剩下的钱才参与按类目分摊。
  // 若总预算连大交通都不够，则大交通吃满预算、其余归零，并由 overBudget 提示。
  const intercityAmount = Math.min(intercity, totalBudget);
  const rest = Math.max(0, totalBudget - intercityAmount);

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

  // 其余类目按剩余预算等比缩放，保证「大交通 + 其余 = 总额」
  const shareSum = categoryShares.reduce((s, c) => s + c.amount, 0);
  const scale = shareSum > 0 ? rest / shareSum : 1;
  const allocAmounts = categoryShares.map((c) => Math.round(c.amount * scale));
  const drift = rest - allocAmounts.reduce((s, a) => s + a, 0);
  const reserveIdx = allocAmounts.length - 1;
  if (drift !== 0) allocAmounts[reserveIdx] = Math.max(0, (allocAmounts[reserveIdx] ?? 0) + drift);

  const rows: Array<{ category: BudgetPlan['allocated'][number]['category']; amount: number }> = [
    ...(intercityAmount > 0 ? [{ category: 'intercity' as const, amount: intercityAmount }] : []),
    ...categoryShares.map((c, i) => ({ category: c.category, amount: allocAmounts[i] ?? 0 })),
  ];
  const allocated = rows.map((r) => ({
    category: r.category,
    amount: r.amount,
    percent: Math.round((r.amount / Math.max(totalBudget, 1)) * 100),
  }));

  const byDay = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    spent: Math.round(rest / days),
  }));

  const suggestions: string[] = [];
  if (overBudget) {
    const comfortRate =
      profile.preferences.accommodationLevel === 'luxury' ? k.perNight.comfort : rate;
    suggestions.push(`建议将豪华住宿降为舒适档，每晚可省 ${rate - comfortRate} 元`);
    if (intercity > 0 && totalBudget > 0 && intercity / totalBudget > 0.4) {
      suggestions.push(
        `往返大交通 ¥${intercity} 已占总预算 ${Math.round((intercity / totalBudget) * 100)}%，` +
          '建议改高铁二等座/错峰航班，或缩短行程天数',
      );
    }
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
    intercityCost: intercity,
  };
}
