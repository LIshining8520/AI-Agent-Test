import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as cheerio from "cheerio";
import type { RetrievedChunk } from '../entities.js';
import type { VectorStore } from '../vectorstore.js';

// search_web tool
export const search_web = tool(
  async ({ query, limit }) => {
    // In a real implementation, this would call Tavily or SerpAPI.
    // For this lesson, we can simulate a search result or use a basic fetch if needed.
    // Since we don't have an API key, we return mock results to allow the agent to proceed.
    console.log(`[search_web] Searching for: ${query} (limit: ${limit})`);
    
    // Mock response — 让结果随用户输入的查询变化，演示“输入 → 检索”链路
    return JSON.stringify([
      {
        title: `${query} - 相关资料 1`,
        url: `https://example.com/search?q=${encodeURIComponent(query)}&n=1`,
        content: `Mock content for query "${query}". This page discusses key concepts and best practices related to "${query}".`,
      },
      {
        title: `${query} - 相关资料 2`,
        url: `https://example.com/search?q=${encodeURIComponent(query)}&n=2`,
        content: `Mock content for query "${query}". Additional perspective: common pitfalls, trade-offs, and practical recommendations related to "${query}".`,
      },
      {
        title: `${query} - 相关资料 3`,
        url: `https://example.com/search?q=${encodeURIComponent(query)}&n=3`,
        content: `Mock content for query "${query}". Third source: real-world examples and further reading on "${query}".`,
      },
    ].slice(0, limit));
  },
  {
    name: "search_web",
    description: "Search the web for information about a given query.",
    schema: z.object({
      query: z.string().min(1, "Query cannot be empty"),
      limit: z.number().int().positive().default(5),
    }),
  }
);

// read_url tool
export const read_url = tool(
  async ({ url }) => {
    try {
      console.log(`[read_url] Reading: ${url}`);
      // For mock URLs we just return mock content
      if (url.startsWith("https://example.com")) {
        // Mock content aligned with main case
        return `Mock content for ${url}. This page discusses LangGraph.js StateGraph architecture for building reliable agent workflows. Key insight: StateGraph's declarative approach allows developers to define nodes and edges explicitly, making the workflow auditable and debuggable. For emergency response systems, this means each decision step can be traced and reviewed by human operators. The conditional edge feature enables dynamic routing based on state evaluation — critical for research loops where the agent needs to decide whether to continue searching or finalize results.`;
      }

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      
      // Remove scripts and styles
      $('script, style, nav, footer, header').remove();
      
      const text = $('body').text().replace(/\s+/g, ' ').trim();
      return text.substring(0, 5000); // Limit to 5000 chars
    } catch (error: any) {
      console.error(`[read_url] Error reading ${url}:`, error.message);
      return `Failed to read URL: ${error.message}`;
    }
  },
  {
    name: "read_url",
    description: "Read the content of a specific URL.",
    schema: z.object({
      url: z.string().url("Must be a valid URL"),
    }),
  }
);

// WMO 天气代码 → 中文描述
const WEATHER_CODES: Record<number, string> = {
  0: "晴",
  1: "基本晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};

function weatherText(code: number | null | undefined): string {
  if (code == null) return "未知";
  return WEATHER_CODES[code] ?? `天气代码 ${code}`;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 把城市名解析为经纬度（Open-Meteo 地理编码，无需 Key，浏览器可直接跨域调用）
async function geocodeLocation(location: string) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`地理编码请求失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  const first = data.results?.[0];
  if (!first) {
    throw new Error(`未找到地点: ${location}`);
  }
  return {
    latitude: first.latitude as number,
    longitude: first.longitude as number,
    name: first.name as string,
    country: (first.country as string) ?? "",
    admin1: (first.admin1 as string) ?? "",
  };
}

// 拉取 7 天天气预报 + 实时天气（Open-Meteo 官方接口，无需 Key）
async function fetchWeather(
  latitude: number,
  longitude: number,
  units: "celsius" | "fahrenheit",
) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,sunrise,sunset",
    timezone: "auto",
    forecast_days: "7",
    temperature_unit: units === "fahrenheit" ? "fahrenheit" : "celsius",
    wind_speed_unit: "kmh",
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) {
    throw new Error(`天气请求失败: HTTP ${res.status}`);
  }
  return res.json();
}

// 浏览器定位：返回用户当前经纬度（需要 HTTPS 或 localhost，用户会看到授权弹窗）
export function getBrowserPosition(): Promise<{
  latitude: number;
  longitude: number;
}> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("当前环境不支持定位（需浏览器且页面为 HTTPS/localhost）"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      (err) => reject(new Error(`定位失败：${err.message}`)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

// 反向地理编码：经纬度 → 城市名（BigDataCloud 免费接口，无需 Key，支持浏览器跨域）
export async function reverseGeocode(latitude: number, longitude: number) {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=zh`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`反向地理编码请求失败: HTTP ${res.status}`);
  }
  const data = await res.json();
  const name = data.city || data.locality || data.principalSubdivision;
  if (!name) {
    return { name: `坐标 ${latitude.toFixed(2)}, ${longitude.toFixed(2)}`, admin1: "", country: "" };
  }
  return {
    name: name as string,
    admin1: (data.principalSubdivision as string) ?? "",
    country: (data.countryName as string) ?? "",
  };
}

// 实时天气工具：输入城市名（或日期），返回当前天气 + 该日 24 小时内的预报
export const get_weather = tool(
  async ({ location, latitude, longitude, date, units = "celsius" }) => {
    let geo: {
      latitude: number;
      longitude: number;
      name: string;
      country: string;
      admin1: string;
    };
    if (latitude != null && longitude != null) {
      // 已有坐标（来自定位），跳过地理编码
      geo = { latitude, longitude, name: location || "当前位置", country: "", admin1: "" };
    } else if (location) {
      geo = await geocodeLocation(location);
    } else {
      return JSON.stringify({
        error: "需要提供 location（城市名）或 latitude/longitude（坐标）。",
      });
    }
    const data = await fetchWeather(geo.latitude, geo.longitude, units);

    const targetDate = date || localDate(new Date());
    const dayIndex = data.daily.time.indexOf(targetDate);
    if (dayIndex === -1) {
      return JSON.stringify({
        location: `${geo.name}${geo.admin1 ? `（${geo.admin1}）` : ""}${geo.country ? `，${geo.country}` : ""}`,
        error: `没有 ${targetDate} 的预报，当前仅提供未来 7 天（${data.daily.time[0]} ~ ${data.daily.time[data.daily.time.length - 1]}）。`,
      });
    }

    const tempUnit = units === "fahrenheit" ? "°F" : "°C";
    const current = data.current;
    const day = {
      date: data.daily.time[dayIndex],
      weather: weatherText(data.daily.weather_code[dayIndex]),
      tempMin: data.daily.temperature_2m_min[dayIndex],
      tempMax: data.daily.temperature_2m_max[dayIndex],
      precipitationProbability:
        data.daily.precipitation_probability_max[dayIndex] ?? null,
      uvIndexMax: data.daily.uv_index_max[dayIndex] ?? null,
      sunrise: data.daily.sunrise[dayIndex],
      sunset: data.daily.sunset[dayIndex],
    };

    const isToday = targetDate === localDate(new Date());
    const summary =
      `${geo.name} ${targetDate} 天气：${day.weather}，` +
      `气温 ${day.tempMin}${tempUnit} ~ ${day.tempMax}${tempUnit}` +
      (day.precipitationProbability != null
        ? `，降水概率 ${day.precipitationProbability}%`
        : "") +
      (day.uvIndexMax != null
        ? `，紫外线指数 ${day.uvIndexMax}`
        : "") +
      (isToday
        ? `；当前气温 ${current.temperature_2m}${tempUnit}，体感 ${current.apparent_temperature}${tempUnit}，湿度 ${current.relative_humidity_2m}%，风速 ${current.wind_speed_10m} km/h，${weatherText(current.weather_code)}`
        : "") +
      `。日出 ${day.sunrise}，日落 ${day.sunset}。`;

    return JSON.stringify(
      {
        location: `${geo.name}${geo.admin1 ? `（${geo.admin1}）` : ""}${geo.country ? `，${geo.country}` : ""}`,
        date: targetDate,
        current: isToday
          ? {
              temperature: current.temperature_2m,
              apparentTemperature: current.apparent_temperature,
              humidity: current.relative_humidity_2m,
              windSpeedKmh: current.wind_speed_10m,
              precipitation: current.precipitation,
              weather: weatherText(current.weather_code),
            }
          : null,
        daily: {
          weather: day.weather,
          tempMin: day.tempMin,
          tempMax: day.tempMax,
          precipitationProbability: day.precipitationProbability,
          uvIndexMax: day.uvIndexMax,
          sunrise: day.sunrise,
          sunset: day.sunset,
        },
        units: tempUnit,
        summary,
      },
      null,
      2,
    );
  },
  {
    name: "get_weather",
    description:
      "获取指定地点的实时天气和未来 7 天天气预报。地点二选一：location（城市名）或 latitude/longitude（坐标）。支持日期参数（YYYY-MM-DD，默认今天），返回当前气温、天气状况、最高/最低温、降水概率、紫外线指数、日出日落等。",
    schema: z.object({
      location: z
        .string()
        .min(1, "地点不能为空")
        .optional()
        .describe("城市名，与 latitude/longitude 二选一"),
      latitude: z.number().optional().describe("纬度，与 location 二选一"),
      longitude: z.number().optional().describe("经度，与 location 二选一"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD")
        .optional()
        .describe("要查询的日期，默认今天，仅支持未来 7 天内"),
      units: z
        .enum(["celsius", "fahrenheit"])
        .optional()
        .default("celsius")
        .describe("温度单位"),
    }),
  }
);
export const RetrieveContextSchema = z.object({
  query: z.string().min(1, 'query is required'),
  tenantId: z.string().min(1, 'tenantId is required'),
  topK: z.number().min(5).max(50).default(20),
  topN: z.number().min(1).max(10).default(5),
}).refine(data => data.topN <= data.topK, {
  message: 'topN must be less than or equal to topK',
  path: ['topN'],
});

export type RetrieveContextInput = z.infer<typeof RetrieveContextSchema>;

// ──────────────────────────────────────────────
// 默认知识库数据（HR/IT/Finance 三部门）
// 课堂演示时，这些数据会被加载到 InMemoryVectorStore 中
// 生产环境替换为 QdrantVectorStore
// ──────────────────────────────────────────────
export const defaultKnowledgeBase: RetrievedChunk[] = [
  // HR 部门
  {
    id: 'chunk-1', documentId: 'doc-hr', tenantId: 'hr',
    content: '公司实行弹性工作制，核心工作时间为 10:00-16:00。员工每日工作时长不少于 8 小时。远程办公每周最多 3 天。',
    score: 0.95, metadata: { source: 'hr-policy.md', section: '考勤制度' },
  },
  {
    id: 'chunk-2', documentId: 'doc-hr', tenantId: 'hr',
    content: '入职满 1 年的员工享有 5 天带薪年假。工龄每增加 1 年，年假增加 1 天，上限 15 天。',
    score: 0.90, metadata: { source: 'hr-policy.md', section: '年假政策' },
  },
  {
    id: 'chunk-3', documentId: 'doc-hr', tenantId: 'hr',
    content: '薪资结构：基本工资 + 绩效奖金 + 项目奖金。绩效奖金按季度考核发放，S 级为基本工资的 40%。',
    score: 0.88, metadata: { source: 'hr-policy.md', section: '薪资福利' },
  },
  // IT 部门
  {
    id: 'chunk-4', documentId: 'doc-it', tenantId: 'it',
    content: '远程办公需使用公司 VPN。下载 GlobalProtect 客户端，服务器地址为 vpn.company.com。首次登录使用工号加初始密码。',
    score: 0.92, metadata: { source: 'it-guide.md', section: 'VPN 配置' },
  },
  {
    id: 'chunk-5', documentId: 'doc-it', tenantId: 'it',
    content: '设备故障报修流程：在 ITSM 平台提交故障工单。IT 工程师会在 4 小时内响应。紧急故障拨打 IT 热线分机 8001。',
    score: 0.88, metadata: { source: 'it-guide.md', section: '故障报修' },
  },
  {
    id: 'chunk-6', documentId: 'doc-it', tenantId: 'it',
    content: '内部系统账号申请流程：在 ITSM 平台提交工单，直属主管审批，IT 管理员处理。标准处理时间为 1 个工作日。',
    score: 0.85, metadata: { source: 'it-guide.md', section: '账号申请' },
  },
  // 财务部门
  {
    id: 'chunk-7', documentId: 'doc-finance', tenantId: 'finance',
    content: '费用报销需在费用发生后 30 天内提交。报销流程：填写 OA 报销单，附上发票等凭证，直属主管审批，财务审核。',
    score: 0.94, metadata: { source: 'finance-policy.md', section: '报销流程' },
  },
  {
    id: 'chunk-8', documentId: 'doc-finance', tenantId: 'finance',
    content: '差旅住宿标准：一线城市不超过 500 元/晚，二线城市不超过 400 元/晚，其他城市不超过 300 元/晚。',
    score: 0.88, metadata: { source: 'finance-policy.md', section: '差旅标准' },
  },
  {
    id: 'chunk-9', documentId: 'doc-finance', tenantId: 'finance',
    content: '报销发票要求：增值税普通发票或专用发票，发票抬头必须为公司全称。电子发票需打印后粘贴在报销单上。',
    score: 0.86, metadata: { source: 'finance-policy.md', section: '发票管理' },
  },
];

// ──────────────────────────────────────────────
// 创建 retrieve_context Tool
// 通过注入 VectorStore 实现解耦（测试/生产可切换）
// ──────────────────────────────────────────────
export function createRetrieveTool(vectorStore: VectorStore) {
  return tool(
    async (input: RetrieveContextInput) => {
      // Metadata filtering：在向量检索时即过滤，只返回当前租户文档
      const docs = await vectorStore.search(input.query, input.tenantId, input.topK);

      // Metadata filtering 后结果为空：输出"当前租户下无可用证据"，不得放宽过滤条件
      if (docs.length === 0) {
        return '当前租户下无可用证据';
      }

      const results = docs.slice(0, input.topN);
      return JSON.stringify(results);
    },
    {
      name: 'retrieve_context',
      description: '从知识库中检索与查询相关的文档片段。需要提供 tenantId 以确保只检索到当前租户有权访问的文档。',
      schema: RetrieveContextSchema,
    }
  );
}