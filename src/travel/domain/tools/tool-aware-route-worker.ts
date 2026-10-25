/**
 * 工具感知路线执行者（第三部分「从『代码先调』到『verify 里调』」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/tools/tool-aware-route-worker.ts`（附录 A · domain.tools）。
 *
 * 给路线制定专员挂上「地图能力」：继承既有 {@link RouteWorker}（沿用其
 * buildPrompt/normalize/fallback），仅重写 run 的调用前哨——先调地图工具拿
 * 「最优驾车路线」结果，再把它折进 LLM 提示词上下文后照常交给父类执行。
 *
 * 为什么用继承而非改 route-worker.ts：
 *   - 遵守文件所有权（不改既有 domain/workers/*）；
 *   - 落下「能力挂载」的教学点：换工具 = 换一个 ToolAware 包装，worker 骨架不动。
 *
 * ## 与原实现的一处环境差异（如实记录）
 *
 * 原版用 Node 的 `AsyncLocalStorage` 隔离「本轮地图结果」，避免并发 run 串台。
 * 本仓跑在浏览器里，没有 `node:async_hooks`；这里改成**随上下文传值**：
 * `run` 把地图文案写进 `ctx.toolContext`，`buildPrompt` 从同一份 ctx 读。
 * 语义等价（作用域就是这一次 run 的对象生命周期），且比实例字段更安全：
 * 不存在「后一个 run 覆盖前一个」的窗口。代价是调用方必须原样透传 ctx ——
 * 本仓只经由 BaseWorker.run 调用，天然满足。
 */
import type { GenerateRequest, LlmClient } from '../../shared/llm';
import type { RoutePlan, TripProfile } from '../../shared/travel-types';
import { RouteWorker, SINGLE_SEGMENT_LIMIT_MIN } from '../workers/route-worker';
import type {
  TravelWorkerContext,
  VerificationResult,
  WorkerResult,
} from '../orchestration/worker-protocol';
import type { MapRouteInfo, MapToolClient } from './map-tool';
import { toMapRouteRequest } from './map-tool';

export class ToolAwareRouteWorker extends RouteWorker {
  readonly kind = 'route' as const;

  /** 观测埋点：累计地图工具调用次数与成功/失败次数（页面上如实展示） */
  mapCalls = 0;
  mapSuccesses = 0;
  mapFailures = 0;
  lastMapResult?: MapRouteInfo;

  private readonly mapTool: MapToolClient;

  constructor(llm: LlmClient, mapTool: MapToolClient) {
    super(llm);
    this.mapTool = mapTool;
  }

  /** 能力挂载真正发生的地方：调地图工具「最优驾车路线」，并把结果并入提示词 */
  private async callMapTool(profile: TripProfile): Promise<string> {
    const req = toMapRouteRequest(profile)[0]!;
    this.mapCalls += 1;
    try {
      const info = await this.mapTool.route(req);
      this.mapSuccesses += 1;
      this.lastMapResult = info;
      // 把结构化路线结果折叠成可为 LLM 使用的一行文本工序（RoadMap 上下文字段）
      return [
        '【地图 MCP · 最优驾车路线参考】',
        `${info.provider}: ${info.origin} → ${info.destination}，`,
        `约 ${info.distanceKm}km / ${info.durationMin}min` +
          (typeof info.toll === 'number' ? `，过路费约${info.toll}元` : '') +
          `，途经 ${req.waypoints?.join('、') || '直接到达'}。`,
      ].join('');
    } catch (err) {
      this.mapFailures += 1;
      const reason = err instanceof Error ? err.message : String(err);
      // 工具失败不阻断主动线：降级为无地图参考的常规提示（与超时降级一致的容错语义）
      return `（地图工具本次不可用：${reason}）`;
    }
  }

  override async run(ctx: TravelWorkerContext): Promise<WorkerResult<RoutePlan>> {
    // 强制兜底（评测/无 LLM 动线）不需要真调工具，直接走父类纯逻辑兜底；
    // 仍给一个空 toolContext，buildPrompt 读到空串 → 「本次未挂载」，不会漏出任何历史上下文。
    if (ctx.forceFallback) return super.run({ ...ctx, toolContext: '' });
    const mapCtx = await this.callMapTool(ctx.profile);
    return super.run({ ...ctx, toolContext: mapCtx });
  }

  /**
   * 工具增强自检：先跑父类的「单段 ≤ 90min」静态判断，再用地图工具复核**最长的一段**。
   *
   * 为什么只复核最长的一段：地图调用有网络/配额成本，而「超限」只可能发生在最长的段上——
   * 只要最长的没超，其余都不超；最长的那段超了，父类大概率已经先判否。
   *
   * 为什么工具失败时不判不通过：verify 的结论必须描述**产物对不对**，
   * 而不是「我们这一刻有没有能力核验」。把工具不可用当成产物错误，
   * 会让一次网络抖动直接把合格方案打成不合格、白白多烧一轮 LLM；
   * 降级为父类结论，语义与 run 里 callMapTool 的容错一致（工具是增强，不是前提）。
   */
  override async verify(data: unknown, ctx: TravelWorkerContext): Promise<VerificationResult> {
    const base = await super.verify(data, ctx);
    // 父类已判否：结论不会因为地图数据更乐观而翻案，省掉一次工具调用
    if (!base.ok) return base;

    const routes = (data as RoutePlan).routes ?? [];
    const longest = [...routes].sort((a, b) => b.estDurationMin - a.estDurationMin)[0];
    if (!longest || !longest.to) return base;

    try {
      const info = await this.mapTool.route({
        origin: longest.origin ?? ctx.profile.destination,
        destination: longest.to,
        transport: 'drive',
      });
      if (info.durationMin > SINGLE_SEGMENT_LIMIT_MIN) {
        return {
          ok: false,
          feedback:
            `地图实测 ${info.origin}→${info.destination} 约 ${info.durationMin}min（${info.distanceKm}km），` +
            `超过单段 ${SINGLE_SEGMENT_LIMIT_MIN}min 上限；请压缩该段、改乘公共交通，或把它拆成两段并在途中休息。`,
          facts: base.facts,
        };
      }
      return base;
    } catch {
      // 见方法注释：工具不可用只说明「没核到」，不能据此判产物有错
      return base;
    }
  }

  override buildPrompt(profile: TripProfile, ctx: TravelWorkerContext): GenerateRequest {
    const base = super.buildPrompt(profile, ctx);
    // 只读本次 run 的上下文字段；直接单测/未走 run 时为空串 → 「本次未挂载」
    const mapCtx = ctx.toolContext ?? '';
    return {
      ...base,
      system: `${base.system}\n${mapCtx || '（本子链本次未挂载地图工具）'}`,
    };
  }
}
