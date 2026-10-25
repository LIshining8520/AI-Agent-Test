/**
 * 旅游多 Agent（课 9-12）· 统一出口
 *
 * 来源：讲义《…》附录 A「本讲核心代码索引」+ 代码包 `projects-v2-9-12-261025`，
 * 映射关系见 `src/travel/README.md`。页面层只从这里 import，不深入内部目录。
 */
export * from './shared/travel-types';
export * from './shared/trip-profile';
export * from './shared/llm';
export * from './shared/cost-model';

export * from './config/env';
export * from './infrastructure/http-llm-client';

export * from './domain/travel-knowledge';
export * from './domain/profile/profile-parser';
export * from './domain/workers/worker';
export * from './domain/workers/route-worker';
export * from './domain/workers/itinerary-worker';
export * from './domain/workers/budget-worker';
export * from './domain/orchestration/worker-protocol';

/* —— 课11/12 增量：共享事实 / 收敛门 / 工具自主 / HITL —— */
export * from './domain/collab/plan-board';
export * from './domain/safety/itinerary-quality';
export * from './domain/safety/convergence';
export * from './domain/tools/map-tool';
export * from './domain/tools/mock-map-tool';
export * from './domain/tools/tool-aware-route-worker';
export * from './domain/tools/skill-registry';
export * from './domain/tools/sub-agent';
export * from './humanloop/hitl';

export * from './application/profile-service';
export * from './application/travel-runtime';

export * from './graph/travel-graph';
