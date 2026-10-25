/**
 * 地图工具契约（第三部分「工具自主」的挂载点）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/tools/map-tool.ts`（附录 A · domain.tools）。
 *
 * 把「地图 MCP」抽象为领域层可依赖的 {@link MapToolClient} 接口：
 *   - 能力发现（listTools）与能力调用（route）分离——对应 MCP 的 schema 与 tool call；
 *   - 与具体供应解耦：底层既可以是真实地图 MCP（infrastructure），
 *     也可以是可比对的 Mock 后端（无真实 key 同样可跑评测/动线）。
 *
 * 为什么在 domain 定义契约而非直接 new SDK：工具自主的落点是「挂一个能力包」，
 * 路线制定专员不应绑定某个地图厂商，而应依赖「能提供最优驾车路线」这一能力契约，
 * 换 provider / 换 mock 只需换 adapter，改变的是「工具接线」，不是 worker 逻辑。
 */
import type { TripProfile } from '../../shared/travel-types';

/** 一次路线规划请求（从原点走到目标，途经途经点） */
export interface MapRouteRequest {
  origin: string;
  destination: string;
  /** 途经点（多城市/多景点串联时用，按顺序） */
  waypoints?: string[];
  /** 交通方式：驾车为默认（地图的核心差异化能力） */
  transport?: 'drive' | 'transit' | 'walk';
}

/** 一条路线方案的估算结果（地图 MCP 的返回） */
export interface MapRouteInfo {
  provider: string;
  origin: string;
  destination: string;
  /** 里程（公里） */
  distanceKm: number;
  /** 预计时长（分钟） */
  durationMin: number;
  /** 高速费/过路费（元，驾车场景） */
  toll?: number;
  /** 路段级描述（供 worker 拼接文案） */
  steps: string[];
}

/** 地图能力描述（对应 MCP 工具列表中的一项） */
export interface MapToolDefinition {
  name: string;
  description: string;
  inputSchema: string;
}

/** 地图 POI 信息（景点/地点下钻） */
export interface MapPoi {
  name: string;
  address: string;
  lng: number;
  lat: number;
}

/** 地图工具客户端：一次握手（能力发现）后按需调用具体能力 */
export interface MapToolClient {
  readonly provider: string;
  /** 能力发现：列出该 provider 暴露的工具（MCP /tools 语义） */
  listTools(): MapToolDefinition[];
  /** 调用「最优驾车路线」能力 */
  route(request: MapRouteRequest): Promise<MapRouteInfo>;
  /** 可选：POI 搜索（景点推荐 SubAgent 复用） */
  searchPoi?(query: string, city: string): Promise<MapPoi[]>;
}

/**
 * 由画像推导一个跨城/景点间驾车路线的请求（ROUTE worker 挂载点）。
 *
 * 语义必须是一条链：**origin → waypoints… → destination**，三者在几何上互不重叠。
 * 旧实现把 destination 也放进 waypoints，Mock/真实地图都会把同一个地方算两遍
 * （途经一次 + 终点一次），里程与时长偏大，直接污染注入 prompt 的通勤时长；
 * 因此这里显式做两件事：整链去重、终点只由 destination 表达。
 */
export function toMapRouteRequest(profile: TripProfile): MapRouteRequest[] {
  const origin = profile.destination;
  // 只要画像有必去景点，就把它当成路线站点（最多折叠 4 个，避免请求过长）
  const candidates =
    profile.constraints.mustVisit.length > 0
      ? profile.constraints.mustVisit.slice(0, 4)
      : profile.preferences.interests.slice(0, 3).map((i) => `${origin}·${i}`);

  // 去重（保序）并去掉与起点同名的站：起点已由 origin 表达，再当途经点等于原地多算一段
  const stops = [...new Set(candidates.map((s) => s.trim()).filter(Boolean))].filter(
    (s) => s !== origin,
  );

  // 链尾即终点；没有站点时退化为「起点 → 起点」的原地请求（保持旧行为，不产生虚假途经）
  const destination = stops[stops.length - 1] ?? origin;
  // 中间站：除链尾（终点）以外的站；再排一次与终点/起点重名的可能，保证三段语义互斥
  const waypoints = stops.slice(0, -1).filter((s) => s !== destination && s !== origin);

  return [
    {
      origin,
      destination,
      waypoints,
      transport: 'drive',
    },
  ];
}
