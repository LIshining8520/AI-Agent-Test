/**
 * 运行时装配（依赖注入的唯一入口）
 *
 * 对应原工程 `application/assemble.ts` 在浏览器侧的等价物：
 * 把「环境配置 → LLM 客户端 → 解析器 → 三个执行者（含工具挂载）→ 收敛门轮数」一次装好，
 * 之后图编排只拿装配结果，不自己 new 任何东西。
 *
 * 没配 Key 时不需要任何特判分支：provider 链为空 → forceFallback=true →
 * 三个执行者直接走主数据兜底，整条动线照样跑通（与原工程「无 Key 走规则+经验兜底」同口径）。
 *
 * ## 本课新增的两个装配开关
 *  - `maxRounds`：收敛门局部重派轮数（0 = 关闭，回到课10 行为）；
 *  - `toolAware`：route 是否替换为 ToolAwareRouteWorker（挂地图能力）。
 *    与真实地图 MCP 的差别只在这一行的 adapter 上——换 provider 不动 worker。
 */
import { getLlmProviders, hasLlmProvider, travelMaxRounds, travelToolAware } from '../config/env';
import { createNoopLlmClient, HttpLlmClient } from '../infrastructure/http-llm-client';
import type { LlmClient } from '../shared/llm';
import { ProfileParser } from '../domain/profile/profile-parser';
import { ProfileService } from './profile-service';
import { RouteWorker } from '../domain/workers/route-worker';
import { ItineraryWorker } from '../domain/workers/itinerary-worker';
import { BudgetWorker } from '../domain/workers/budget-worker';
import { ToolAwareRouteWorker } from '../domain/tools/tool-aware-route-worker';
import type { MapToolClient } from '../domain/tools/map-tool';
import { createMockMapTool } from '../domain/tools/mock-map-tool';
import {
  createWorkerRegistry,
  type TravelWorker,
  type WorkerKind,
} from '../domain/orchestration/worker-protocol';

export interface TravelRuntime {
  llm: LlmClient;
  /** 命中链首的供应商名；null 表示没配 Key（兜底模式） */
  providerName: string | null;
  /** 是否强制走纯逻辑兜底 */
  forceFallback: boolean;
  profileService: ProfileService;
  workers: Record<WorkerKind, TravelWorker>;
  /** 链路 ID 生成器（一次规划一个 traceId，便于贯穿三个子链） */
  newTraceId: () => string;
  /** 收敛门局部重派轮数上限（首轮之外）；0 = 关闭 */
  maxRounds: number;
  /** 地图能力客户端（当前为确定性 Mock；换真 MCP 只换这一处） */
  mapTool: MapToolClient;
  /** route 是否挂了工具（决定页面标注「地图复核」是否可信） */
  toolAware: boolean;
}

/** 生成链路 ID（crypto.randomUUID 在浏览器与 Node 22 都可用） */
function newTraceId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `trace-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

export function createTravelRuntime(): TravelRuntime {
  const providers = getLlmProviders();
  const configured = hasLlmProvider();
  const llm: LlmClient = configured ? new HttpLlmClient(providers) : createNoopLlmClient();

  const parser = new ProfileParser(llm);
  const profileService = new ProfileService(parser);

  const toolAware = travelToolAware();
  const mapTool = createMockMapTool();

  const workers: Record<WorkerKind, TravelWorker> = {
    // 工具挂载点：同一份路线职责，一个挂地图、一个不挂，编排层只认 kind
    route: toolAware ? new ToolAwareRouteWorker(llm, mapTool) : new RouteWorker(llm),
    itinerary: new ItineraryWorker(llm),
    budget: new BudgetWorker(llm),
  };

  // 注册表填一次，编排层按 kind 取 —— 换实现不动图
  const registry = createWorkerRegistry();
  (Object.keys(workers) as WorkerKind[]).forEach((k) => registry.register(k, workers[k]));

  return {
    llm,
    providerName: providers[0]?.name ?? null,
    forceFallback: !configured,
    profileService,
    workers,
    newTraceId,
    maxRounds: travelMaxRounds(),
    mapTool,
    toolAware,
  };
}

/** 单例（页面多次运行共用一条 provider 链，避免重复装配） */
let runtime: TravelRuntime | null = null;
export function getTravelRuntime(): TravelRuntime {
  if (!runtime) runtime = createTravelRuntime();
  return runtime;
}
