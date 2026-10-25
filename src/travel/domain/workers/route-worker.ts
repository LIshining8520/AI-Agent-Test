/**
 * 路线执行者（第 5 段三子链之一）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/workers/route-worker.ts`（附录 A 第 9 项）。
 * 基于画像产出城市间/景点间路线 RoutePlan；LLM 失败时降级主数据经验规则。
 */
import type { GenerateRequest, LlmClient } from '../../shared/llm';
import type { RoutePlan, TripProfile } from '../../shared/travel-types';
import { buildFallbackRoute, entryNotesOf, estimateIntercity, findKnowledge } from '../travel-knowledge';
import type { VerificationResult } from '../orchestration/worker-protocol';
import { BaseWorker, clampDay, type WorkerContext } from './worker';

/**
 * 单段通勤时长上限（分钟）。导出给工具感知 worker 复用同一口径——
 * 「路线是否合理」若有两条标准，用户会看到同一份计划在两个入口得到不同结论。
 */
export const SINGLE_SEGMENT_LIMIT_MIN = 90;

interface RawRouteInput {
  destination?: string;
  days?: number;
  routes?: Array<{
    day?: number;
    origin?: string;
    to?: string;
    transport?: RoutePlan['routes'][number]['transport'];
    estDurationMin?: number;
    estCost?: number;
  }>;
  transportPreference?: RoutePlan['transportPreference'];
}

export class RouteWorker extends BaseWorker<RoutePlan> {
  readonly kind = 'route' as const;

  constructor(llm: LlmClient) {
    super(llm, 'ROUTE');
  }

  buildPrompt(profile: TripProfile, ctx: WorkerContext): GenerateRequest {
    const k = findKnowledge(profile.destination);
    const intercity = estimateIntercity(profile);
    const intercityHint =
      intercity.length > 0
        ? `往返大交通（系统已按距离估算，勿自行编造价）：${intercity[0]!.mode} ${intercity[0]!.from}→${intercity[0]!.to}`
        : '未提供出发地，无往返大交通';
    return {
      role: 'ROUTE',
      system: [
        '你是旅游路线的公共交通规划师。依据画像输出路线 JSON：',
        '{destination, days, routes:[{day,origin,to,transport,estDurationMin,estCost}], transportPreference}。',
        `参考主数据：${k ? k.attractions.join('、') : '按用户指定目的地'}；`,
        'routes 只写城内/景点间，transport∈walk|subway|bus|taxi|car，城内用 subway，跨城用 taxi/car。',
        '只输出纯 JSON。',
      ].join(''),
      user: [
        `出发地：${profile.origin || '未提供'}；目的地：${profile.destination}；天数：${profile.days}；`,
        `同行：${profile.companions.join(',')}；节奏：${profile.preferences.pace}；`,
        `预算：${profile.budget}元；必去：${profile.constraints.mustVisit.join(',')}；规避：${profile.constraints.avoid.join(',')}。`,
        intercityHint,
      ].join(''),
      temperature: ctx.temperature ?? 0.2,
    };
  }

  normalize(d: unknown, profile: TripProfile): RoutePlan {
    const raw = (d ?? {}) as RawRouteInput;
    const days = Math.max(profile.days, 1);
    const fb = this.fallback(profile);
    const routes = (raw.routes ?? []).map((r, i) => ({
      // day 收敛到 [1, days]：路线侧此前不收敛，而行程侧按 length 已收敛 —— 两者不对称，
      // LLM 偶发越界 day 会让时序校验直接判否（表现为「行程合理性」失败，
      // 实为子链产物未按画像天数收敛）。
      day: clampDay(r.day, i + 1, days),
      origin: r.origin,
      to: r.to ?? '',
      transport: this.coerceTransport(r.transport),
      estDurationMin: Math.max(1, r.estDurationMin ?? 40),
      estCost: r.estCost,
    }));
    return {
      destination:
        raw.destination || profile.destination || findKnowledge(profile.destination)?.key || '',
      days,
      routes: routes.length > 0 ? routes : fb.routes,
      transportPreference: raw.transportPreference ?? fb.transportPreference,
      /**
       * 大交通**不由 LLM 产出**，一律走 `estimateIntercity`（纯函数）。
       *
       * 原因是并行结构下的硬约束：预算子链与路线子链同一 superstep 跑，拿不到彼此的产物。
       * 如果两边各自估算，路线说「杭州→昆明 ¥1200」、预算按 ¥975 算，收口的
       * 「大交通计入预算」质检必然失败 —— 实测就是这么炸的。用同一个纯函数才能保证对账。
       */
      intercity: estimateIntercity(profile),
      // 出境游的签证/入境提示：这不是路线本身，但漏了会让人到了机场才发现问题
      entryNotes: entryNotesOf(profile.destination),
    };
  }

  /**
   * 路线自检：单段通勤时长上限（第五部分 5.1「四维判定」里 distance 维度的角色侧版本）。
   *
   * 为什么拿 90min 当硬线：跨城/跨景区单段超过一个半小时，对「带孩子、节奏慢」的画像
   * 已经不是「坐得久一点」而是当天行程作废——到地方就该吃饭/回酒店了。
   * 这个阈值只看**路线自身**（不查地图、不看天气），因此是纯函数：
   * 同一份 RoutePlan 在任何环境、任何时刻都得到同一个结论。
   *
   * `dayAnchors` 一次性给出整天覆盖（day → 当天终点），不做逐天合并：
   * 路线重排后旧锚点已经过期，合并只会留下「第 3 天还在大理」这类幽灵事实。
   *
   * 声明为 async 只是 Promise 包装（实现里没有 await）：课11 的 ToolAwareRouteWorker
   * 覆盖时要真切地 await 地图工具，父类先留出异步签名，否则子类无法把
   * 「静态判断 + 工具复核」合成同一个结论。
   */
  async verify(data: unknown, _ctx: WorkerContext): Promise<VerificationResult> {
    const plan = data as RoutePlan;
    const dayAnchors: Record<number, string> = {};
    // 按天升序写锚点；同一天多段时以**最后一段的终点**为当天落脚点（稳定排序保留段内顺序）
    for (const r of [...(plan.routes ?? [])].sort((a, b) => a.day - b.day)) {
      if (r.to) dayAnchors[r.day] = r.to;
    }

    const tooLong = (plan.routes ?? []).find((r) => r.estDurationMin > SINGLE_SEGMENT_LIMIT_MIN);
    if (tooLong) {
      return {
        ok: false,
        feedback:
          `第 ${tooLong.day} 天 ${tooLong.origin ?? '出发地'}→${tooLong.to} ${tooLong.estDurationMin}min ` +
          `超过单段 ${SINGLE_SEGMENT_LIMIT_MIN}min 上限，请压缩该段或改乘公共交通（如高铁/城际大巴），` +
          '必要时把它拆成两段并在中间安排休息点。',
        facts: { dayAnchors },
      };
    }
    return { ok: true, facts: { dayAnchors } };
  }

  fallback(profile: TripProfile): RoutePlan {
    return buildFallbackRoute(profile);
  }

  private coerceTransport(t: unknown): RoutePlan['routes'][number]['transport'] {
    const set: Array<RoutePlan['routes'][number]['transport']> = [
      'walk',
      'subway',
      'bus',
      'taxi',
      'car',
    ];
    return set.includes(t as never) ? (t as RoutePlan['routes'][number]['transport']) : 'subway';
  }
}
