/**
 * 地图工具的确定性 Mock 后端（浏览器侧 adapter）
 *
 * 对应原工程 `infrastructure/tools/map-mcp-client.ts` 的 `MAP_USE_MOCK` 分支。
 * 原实现走真实 MCP（HTTP/stdio，Node 才能拉起进程），本仓是 Vite 前端工程，
 * 因此这里只保留**同一份能力契约**的确定性实现：
 *
 *  - 不联网、不读 env、无随机数：同一对地名永远返回同一份里程/时长，评测可复现；
 *  - 里程与时长按「经纬度直线距离 × 线路系数」估，量级正确即可（不做真实路径规划）；
 *  - 能力面（listTools）与真实 MCP 同形，将来换成真 adapter 时 worker 一行不用改。
 *
 * 为什么这不算「假数据糊弄」：讲义第三部分 3.3 的落点就是
 * 「能力契约 + 确定性 Mock：换 provider 不动 worker」——
 * mock 是用来验证接线与失败语义的，真实地图只是换一个实现。
 */
import { CITY_COORDS, resolveCity } from '../travel-knowledge';
import type {
  MapPoi,
  MapRouteInfo,
  MapRouteRequest,
  MapToolClient,
  MapToolDefinition,
} from './map-tool';

/** 线路系数：高速/环线绕行，地面里程约为直线的 1.25 倍 */
const ROAD_FACTOR = 1.25;
/** 驾车均速（km/h）：跨城走高速，取 75 */
const HIGHWAY_KMH = 75;
/** 城内均速（km/h）：红绿灯 + 拥堵，取 25 */
const CITY_KMH = 25;
/** 市区短途基础里程（km）与基础耗时（min）：用于同城地点间的确定性估算 */
const CITY_BASE_KM = 6;
const CITY_BASE_MIN = 12;

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

/**
 * 字符串 → [0,1) 的确定性散列。
 * 同城地点没有坐标时用它把「名字」摊成里程/时长扰动，
 * 保证「西湖→灵隐寺」这类请求每次跑出来一样，且不同地名不会挤在同一个数上。
 */
function stableUnit(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/** 城市内地点间的确定性里程/时长（无坐标时使用） */
function intraCityLeg(origin: string, destination: string): { km: number; min: number } {
  const u = stableUnit(`${origin}→${destination}`);
  const km = Math.round((CITY_BASE_KM + u * 22) * 10) / 10;
  const min = Math.round(CITY_BASE_MIN + (km / CITY_KMH) * 60 + u * 8);
  return { km, min };
}

/**
 * 确定性 Mock 地图客户端。
 * @param provider 供应商名（默认 `mock-map`，页面上会如实标注「Mock 地图」）
 */
export class MockMapToolClient implements MapToolClient {
  readonly provider: string;

  constructor(provider = 'mock-map') {
    this.provider = provider;
  }

  listTools(): MapToolDefinition[] {
    return [
      {
        name: 'maps_direction_driving',
        description: '驾车路线规划：给定起点/终点/途经点，返回里程、预计耗时与过路费',
        inputSchema: '{origin:string, destination:string, waypoints?:string[], transport?:drive|transit|walk}',
      },
      {
        name: 'maps_search_poi',
        description: 'POI 搜索：按关键词与城市返回地点列表（含经纬度）',
        inputSchema: '{query:string, city:string}',
      },
      {
        name: 'maps_geocode',
        description: '地理编码：地址 → 经纬度',
        inputSchema: '{address:string}',
      },
    ];
  }

  async route(request: MapRouteRequest): Promise<MapRouteInfo> {
    if (!request.origin?.trim() || !request.destination?.trim()) {
      // 参数不合法属于**调用失败**（不是产品错误）：让调用方走「工具不可用」的降级分支
      throw new Error('地图工具调用参数不完整：origin/destination 均不能为空');
    }

    const originCity = resolveCity(request.origin);
    const destCity = resolveCity(request.destination);
    const originCoord = originCity ? CITY_COORDS[originCity] : undefined;
    const destCoord = destCity ? CITY_COORDS[destCity] : undefined;

    const steps: string[] = [];
    let distanceKm: number;
    let durationMin: number;

    if (originCoord && destCoord) {
      // 跨城：直线距离 × 线路系数，高速均速 75km/h，两端各留 10 分钟出入口/停车
      const straight = haversineKm(originCoord, destCoord);
      distanceKm = Math.max(1, Math.round(straight * ROAD_FACTOR));
      durationMin = Math.round((distanceKm / HIGHWAY_KMH) * 60) + 20;
      steps.push(`${originCity} 上高速（约 10min 出入口）`);
      if (request.waypoints && request.waypoints.length > 0) {
        steps.push(`经 ${request.waypoints.join('、')} 依次停靠`);
      }
      steps.push(`${destCity} 下高速，市区接驳约 10min`);
    } else {
      // 同城/地名不可解析：用确定性扰动给出城内短途
      const leg = intraCityLeg(request.origin, request.destination);
      distanceKm = leg.km;
      durationMin = leg.min;
      steps.push(`市区道路：${request.origin} → ${request.destination}`);
      if (request.waypoints && request.waypoints.length > 0) {
        steps.push(`经 ${request.waypoints.join('、')}`);
      }
    }

    // 过路费：只有真正走了高速（跨城且里程足够）才计，按 0.45 元/km 折半给
    const toll = distanceKm > 50 ? Math.round(distanceKm * 0.45 * 0.5) : undefined;

    return {
      provider: this.provider,
      origin: request.origin,
      destination: request.destination,
      distanceKm,
      durationMin,
      toll,
      steps,
    };
  }

  async searchPoi(query: string, city: string): Promise<MapPoi[]> {
    const coord = CITY_COORDS[resolveCity(city) ?? ''] ?? CITY_COORDS['杭州']!;
    const u = stableUnit(`${city}:${query}`);
    return [
      {
        name: query,
        address: `${city} · ${query}（Mock 坐标）`,
        // 确定性抖动 ±0.05 度，避免所有 POI 叠在同一个点上
        lng: Math.round((coord[1] + (u - 0.5) * 0.1) * 10000) / 10000,
        lat: Math.round((coord[0] + (stableUnit(`${query}:${city}`) - 0.5) * 0.1) * 10000) / 10000,
      },
    ];
  }
}

/** 默认单例（页面/评测共用一份，避免重复构造） */
export function createMockMapTool(): MapToolClient {
  return new MockMapToolClient();
}
