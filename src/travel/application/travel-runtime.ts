/**
 * 运行时装配（依赖注入的唯一入口）
 *
 * 对应原工程 `application/assemble.ts` 在浏览器侧的等价物：
 * 把「环境配置 → LLM 客户端 → 解析器 → 三个执行者」一次装好，
 * 之后图编排只拿装配结果，不自己 new 任何东西。
 *
 * 没配 Key 时不需要任何特判分支：provider 链为空 → forceFallback=true →
 * 三个执行者直接走主数据兜底，整条动线照样跑通（与原工程「无 Key 走规则+经验兜底」同口径）。
 */
import { getLlmProviders, hasLlmProvider } from '../config/env';
import { createNoopLlmClient, HttpLlmClient } from '../infrastructure/http-llm-client';
import type { LlmClient } from '../shared/llm';
import { ProfileParser } from '../domain/profile/profile-parser';
import { ProfileService } from './profile-service';
import { RouteWorker } from '../domain/workers/route-worker';
import { ItineraryWorker } from '../domain/workers/itinerary-worker';
import { BudgetWorker } from '../domain/workers/budget-worker';
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

  const workers: Record<WorkerKind, TravelWorker> = {
    route: new RouteWorker(llm),
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
  };
}

/** 单例（页面多次运行共用一条 provider 链，避免重复装配） */
let runtime: TravelRuntime | null = null;
export function getTravelRuntime(): TravelRuntime {
  if (!runtime) runtime = createTravelRuntime();
  return runtime;
}
