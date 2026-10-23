/**
 * 路线执行者（第 5 段三子链之一）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/workers/route-worker.ts`（附录 A 第 9 项）。
 * 基于画像产出城市间/景点间路线 RoutePlan；LLM 失败时降级主数据经验规则。
 */
import type { GenerateRequest, LlmClient } from '../../shared/llm';
import type { RoutePlan, TripProfile } from '../../shared/travel-types';
import { buildFallbackRoute, findKnowledge } from '../travel-knowledge';
import { BaseWorker, clampDay, type WorkerContext } from './worker';

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
    return {
      role: 'ROUTE',
      system: [
        '你是旅游路线的公共交通规划师。依据画像输出路线 JSON：',
        '{destination, days, routes:[{day,origin,to,transport,estDurationMin,estCost}], transportPreference}。',
        `参考主数据：${k ? k.attractions.join('、') : '按用户指定目的地'}；`,
        'transport∈walk|subway|bus|taxi|car，城内用 subway，跨城用 taxi/car。',
        '只输出纯 JSON。',
      ].join(''),
      user: [
        `目的地：${profile.destination}；天数：${profile.days}；`,
        `同行：${profile.companions.join(',')}；节奏：${profile.preferences.pace}；`,
        `预算：${profile.budget}元；必去：${profile.constraints.mustVisit.join(',')}；规避：${profile.constraints.avoid.join(',')}`,
      ].join(''),
      temperature: ctx.temperature ?? 0.2,
    };
  }

  normalize(d: unknown, profile: TripProfile): RoutePlan {
    const raw = (d ?? {}) as RawRouteInput;
    const days = Math.max(profile.days, 1);
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
      routes: routes.length > 0 ? routes : this.fallback(profile).routes,
      transportPreference: raw.transportPreference ?? this.fallback(profile).transportPreference,
    };
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
