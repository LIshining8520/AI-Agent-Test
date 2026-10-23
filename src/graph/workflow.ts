import {
  Annotation,
  END,
  START,
  StateGraph,
  MemorySaver,
} from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { getLLM, getTracingCallbacks } from "./llm.js";
import { ResearcherStateAnnotation, type ResearcherState } from "./state.js";
import {
  search_web,
  read_url,
  get_weather,
  getBrowserPosition,
  reverseGeocode,
} from "./tools.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import {
  PROXY_PLACEHOLDER_KEY,
  isProxyMode,
  proxyBaseUrl,
} from "../config/llm-endpoint";

// ================= 天气助手 triage 工作流（App 使用） =================
// 浏览器环境没有 process.env，Vite 会把 .env 中 VITE_ 开头的变量注入 import.meta.env。
// 线上改用同源代理：构建环境不配 VITE_DEEPSEEK_API_KEY，Key 只存在于服务端。
const proxyMode = isProxyMode();
const apiKey = proxyMode
  ? PROXY_PLACEHOLDER_KEY
  : (import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined);
const modelName =
  import.meta.env.VITE_DEEPSEEK_MODEL || "deepseek-v4-flash";
const baseURL = proxyMode
  ? proxyBaseUrl()
  : import.meta.env.VITE_DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";

const TriageAnnotation = Annotation.Root({
  input: Annotation<string>,
  category: Annotation<string>,
  reply: Annotation<string>,
  steps: Annotation<string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
  isBad: Annotation<boolean>(),
  result: Annotation<string>(),
  weather: Annotation<string>(),
  weatherData: Annotation<any>(),
  advice: Annotation<string>(),
  date: Annotation<string>(),
  location: Annotation<string>(),
  latitude: Annotation<number>(),
  longitude: Annotation<number>(),
  holiday: Annotation<string>(),
});

const model = apiKey
  ? new ChatOpenAI({
      model: modelName,
      apiKey,
      temperature: 0,
      configuration: { baseURL },
      // DeepSeek 默认开启思考模式，思考模式下不支持 tool_choice / json_schema，
      // 所以结构化输出走 jsonMode（response_format=json_object）。
    })
  : ({
      invoke: async (input: string) => ({
        content: `[Mock 翻译] ${input}`,
      }),
      withStructuredOutput: (_schema: any) => ({
        invoke: async (input: string) => {
          console.log(
            "⚠️ [Mock Mode] 无 API Key，按预置规则分流（纯字符串匹配，非 LLM）。",
          );
          // mock 收到的是完整提示词，先按节点区分再取真实输入
          const prompt = String(input);
          const text = prompt.split(/用户输入：|文本：/).pop() ?? prompt;
          if (prompt.includes("推断日期")) {
            const today = new Date();
            const fmt = (d: Date) =>
              `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const offset = text.includes("大后天")
              ? 3
              : text.includes("后天")
                ? 2
                : text.includes("明天")
                  ? 1
                  : 0;
            const target = new Date(today);
            target.setDate(target.getDate() + offset);
            return { date: fmt(target) };
          }
          if (prompt.includes("提取地点")) {
            const m = text.match(
              /(?:今天|明天|后天|大后天)([\u4e00-\u9fa5]{2,6}?)天气|([\u4e00-\u9fa5]{2,6}?)(?:今天|明天|后天|大后天)?天气/,
            );
            return { location: m?.[1] || m?.[2] || "" };
          }
          return { isBad: /脏话|fuck|shit|傻|笨蛋|脑残/i.test(text) };
        },
      }),
    } as any);

async function getDateNode(state: typeof TriageAnnotation.State) {
  const schema = z.object({ date: z.string() });

  // 本地格式化 YYYY-MM-DD（避免 toISOString 的 UTC 时区偏差）
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const today = new Date();
  const todayStr = fmt(today);

  // 把“今天/明天/后天/大后天”和具体日期都交给模型推断：
  // 提示词里给出“今天”作为基准，并要求统一输出 YYYY-MM-DD。
  const res = await model
    .withStructuredOutput(schema, { method: "jsonMode" })
    .invoke(
      `今天是 ${todayStr}（${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日）。\n` +
        `规则：今天=${todayStr}，明天=今天+1天，后天=今天+2天，大后天=今天+3天；具体日期（如 8月20日、2026-08-20）按公历规范为 YYYY-MM-DD。\n` +
        `请根据用户输入推断日期，只输出 JSON 对象：{"date": "推断出的日期"}，其中 date 的值必须是 YYYY-MM-DD 格式，不要输出其他内容。\n用户输入：${state.input}`,
    );
  return { date: res.date };
}

async function extractLocationNode(state: typeof TriageAnnotation.State) {
  const schema = z.object({ location: z.string() });
  const res = await model
    .withStructuredOutput(schema, { method: "jsonMode" })
    .invoke(
      `请从用户输入中提取地点（城市名或区县名，如"上海"、"北京"），如果输入中没有提到任何地点则返回空字符串。只输出 JSON 对象：{"location": "城市名或空字符串"}，不要输出其他内容。\n用户输入：${state.input}`,
    );
  console.log(JSON.stringify(res), "res>extractLocationNode");
  return { location: res.location };
}

// 输入未提供城市时，用浏览器定位 + 反向地理编码获取当前位置
async function locateNode(state: typeof TriageAnnotation.State) {
  if (state.location) {
    return {}; // 输入里已有城市，直接使用
  }
  try {
    const pos = await getBrowserPosition();
    const place = await reverseGeocode(pos.latitude, pos.longitude);
    const name = place.name || "当前位置";
    console.log(
      `[locate] ${name} (${pos.latitude.toFixed(4)}, ${pos.longitude.toFixed(4)})`,
    );
    return { location: name, latitude: pos.latitude, longitude: pos.longitude };
  } catch (error: any) {
    console.warn("[locate] 定位失败:", error?.message);
    return { location: "" };
  }
}

async function searchWeatherNode(state: typeof TriageAnnotation.State) {
  // 真实天气：调用 get_weather 工具（Open-Meteo，免费无需 Key）
  const input: {
    location?: string;
    latitude?: number;
    longitude?: number;
    date?: string;
  } = { date: state.date || undefined };

  if (state.latitude != null && state.longitude != null) {
    // 有定位坐标：直接用坐标查，location 只用于展示
    input.location = state.location || "当前位置";
    input.latitude = state.latitude;
    input.longitude = state.longitude;
  } else if (state.location) {
    input.location = state.location;
  } else {
    return {
      weather: "未识别到地点且无法获取定位，请直接输入城市名，例如：上海明天天气怎么样。",
    };
  }

  const resStr = await get_weather.invoke(input).catch((error: any) => {
    // 网络抖动 / 地理编码失败 / 上游 5xx：转成可读文案，让链路继续而非整图崩溃
    const reason = error?.message || String(error || "未知错误");
    return JSON.stringify({ error: `天气服务暂时不可用（${reason}）。请稍后重试，或改用常用城市名。` });
  });
  const parsed = JSON.parse(resStr);
  if (parsed.error) {
    return { weather: parsed.error };
  }
  console.log(JSON.stringify(parsed), "res>searchWeatherNode");
  return { weather: parsed.summary, weatherData: parsed };
}

// 根据结构化天气数据生成穿衣 / 防晒 / 雨伞等出行建议（纯规则，无需调 LLM）
function generateAdvice(data: any): string {
  const daily = data?.daily;
  const current = data?.current;
  const tempUnit = data?.units || "°C";
  if (!daily) {
    return "暂无天气数据，无法给出出行建议。";
  }

  const tempMax = daily.tempMax;
  const tempMin = daily.tempMin;
  const precipProb = daily.precipitationProbability ?? 0;
  const weather = daily.weather ?? "未知";
  const uv = daily.uvIndexMax ?? 0;
  const diff = tempMax != null && tempMin != null ? tempMax - tempMin : 0;

  const tips: string[] = [];

  // 穿衣
  if (tempMax != null) {
    if (tempMax >= 30) {
      tips.push(`穿衣：天气炎热（最高 ${tempMax}${tempUnit}），建议短袖、短裤等清凉透气衣物`);
    } else if (tempMax >= 24) {
      tips.push(`穿衣：最高 ${tempMax}${tempUnit}，短袖或薄长袖即可`);
    } else if (tempMax >= 18) {
      tips.push(`穿衣：最高 ${tempMax}${tempUnit}，建议长袖或薄外套`);
    } else if (tempMax >= 10) {
      tips.push(`穿衣：最高 ${tempMax}${tempUnit}，建议夹克、风衣或毛衣`);
    } else {
      tips.push(`穿衣：最高 ${tempMax}${tempUnit}，天气寒冷，建议厚外套或羽绒服`);
    }
  }
  if (diff >= 8) {
    tips.push(`早晚温差约 ${diff}${tempUnit}，注意及时增减衣物`);
  }

  // 防晒
  if (uv >= 8) {
    tips.push(`防晒：紫外线指数 ${uv}，强度极高，务必涂 SPF50+ 防晒霜并戴帽子、墨镜`);
  } else if (uv >= 6) {
    tips.push(`防晒：紫外线指数 ${uv}，强度强，建议涂防晒霜并戴遮阳帽`);
  } else if (uv >= 3) {
    tips.push(`防晒：紫外线指数 ${uv}，中等，外出可适当涂防晒`);
  } else if (uv > 0) {
    tips.push(`防晒：紫外线指数 ${uv}，较弱，无需特别防护`);
  } else {
    tips.push("防晒：暂无紫外线数据，按常规防晒处理");
  }

  // 雨伞
  if (precipProb >= 70 || /雨|雷暴|毛毛雨|阵雨|冻雨/.test(weather)) {
    tips.push(`雨伞：降水概率 ${precipProb}%，天气为“${weather}”，记得带伞`);
  } else if (precipProb >= 40) {
    tips.push(`雨伞：降水概率 ${precipProb}%，建议带伞以防万一`);
  } else {
    tips.push(`雨伞：降水概率 ${precipProb}%，一般无需带伞`);
  }

  // 体感与风
  if (
    current?.apparentTemperature != null &&
    tempMax != null &&
    current.apparentTemperature - tempMax >= 3
  ) {
    tips.push(`体感：闷热，体感温度 ${current.apparentTemperature}${tempUnit}，注意补水防暑`);
  }
  if (current?.windSpeedKmh != null && current.windSpeedKmh >= 30) {
    tips.push(`风大：风速 ${current.windSpeedKmh} km/h，出行注意防风`);
  }

  return tips.join("；") + "。";
}

async function adviceNode(state: typeof TriageAnnotation.State) {
  const advice = generateAdvice(state.weatherData);
  console.log(advice, "res>adviceNode");
  return { advice };
}

async function finalNode(state: typeof TriageAnnotation.State) {
  // 关键修复：日期与地点由模板拼接，LLM 只负责写"天气描述"。
  // 避免 LLM 把"明天"自由改成"今天"等相对词导致与用户提问错位。
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const todayStr = fmt(today);

  // 异常路径：weather 字段已经是错误文案，直接当 reply 返回，不再二次包装
  if (/未识别|未找到|未提供|错误|失败|无法|暂时不可用|不支[持持]|网络/i.test(state.weather || "")) {
    return { reply: state.weather || "暂时无法给出天气播报" };
  }

  // 计算相对日期标签（避免 LLM 改写日期）
  let dateLabel = state.date;
  if (state.date && /^\d{4}-\d{2}-\d{2}$/.test(state.date)) {
    const [y, m, d] = state.date.split("-").map(Number);
    const target = new Date(y, m - 1, d);
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diff = Math.round((target.getTime() - base.getTime()) / 86400000);
    if (diff === 0) dateLabel = "今天";
    else if (diff === 1) dateLabel = "明天";
    else if (diff === 2) dateLabel = "后天";
    else if (diff === 3) dateLabel = "大后天";
    else dateLabel = `${m}月${d}日`;
  }

  // LLM 仅生成天气 + 温度 + 出行建议的描述句（不要日期、不要地点）
  const res = await model.invoke(
    `你是天气播报员。基于以下信息写一句简洁友好的天气描述（30 字以内），` +
      `**严格不要包含日期、不要包含地点**，只描述天气、温度区间和出行建议：\n` +
      `今天日期：${todayStr}\n天气：${state.weather}\n出行建议：${state.advice || ""}`,
  );
  let desc = String(res.content ?? "").trim();
  // 二次兜底：移除 desc 中可能残留的相对日期词，避免与模板前缀冲突
  desc = desc.replace(/^(今天|明天|后天|大后天)/, "");

  const reply = `${state.location || ""}${dateLabel}${desc}`;
  console.log(JSON.stringify(res), "res>finalNode");
  return { reply };
}

export const triageGraph = new StateGraph(TriageAnnotation)
  .addNode("getDate", getDateNode)
  .addNode("extractLocation", extractLocationNode)
  .addNode("locate", locateNode)
  .addNode("searchWeather", searchWeatherNode)
  .addNode("suggest", adviceNode)
  .addNode("final", finalNode)
  .addEdge(START, "getDate")
  .addConditionalEdges("getDate", (state) =>
    state.date ? "extractLocation" : END,
  )
  .addConditionalEdges("extractLocation", (state) =>
    state.location ? "searchWeather" : "locate",
  )
  .addEdge("locate", "searchWeather")
  .addConditionalEdges("searchWeather", (state) =>
    state.weather ? "suggest" : END,
  )
  .addConditionalEdges("suggest", (state) =>
    state.advice ? "final" : END,
  )
  .addEdge("final", END)
  .compile();

// ================= 研究型 researcher 工作流 =================
const MAX_LOOPS = 2;
const MAX_SOURCES = 12;
const MAX_PAGES = 8;

// DeepSeek 只支持 jsonMode（response_format=json_object），
// 不支持 function calling 方式的结构化输出，所以统一用 zod schema + jsonMode。
const plannerSchema = z.object({ queries: z.array(z.string()) });
const searchQueriesSchema = z.object({ queries: z.array(z.string()) });
const extractFindingsSchema = z.object({ findings: z.array(z.string()) });
const finalReportSchema = z.object({
  summary: z.array(z.string()),
  findings: z.array(z.string()),
  citations: z.array(z.object({ url: z.string(), title: z.string() })),
  recommendations: z.array(z.string()),
});

async function plannerNode(state: ResearcherState) {
  const llm = getLLM().withStructuredOutput(plannerSchema, {
    method: "jsonMode",
  });

  const query =
    state.researchQuery ||
    state.input ||
    state.messages[0]?.content ||
    "No query provided";

  const systemPrompt = `You are an expert research planner. Break down the user's research task into 1-3 specific search queries. 只输出 JSON 对象：{"queries": ["查询1", "查询2"]}，不要输出其他内容。`;
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(`Research Task: ${query}`)
  ]) as { queries: string[] };

  return {
    researchQuery: typeof query === "string" ? query : JSON.stringify(query),
    messages: [new SystemMessage(`Planned queries: ${response.queries.join(", ")}`)],
    // Store queries in a temporary way or just use them in search. Wait, state doesn't have a place for queries.
    // We can just add them to messages and the search node can read the last message.
  };
}

async function searchNode(state: ResearcherState) {
  // Extract queries from the last message on first loop, otherwise generate new ones based on findings
  const lastMsg = state.messages[state.messages.length - 1];
  let queries: string[] = [];
  if (state.loopCount === 0 && lastMsg && typeof lastMsg.content === "string" && lastMsg.content.startsWith("Planned queries: ")) {
    queries = lastMsg.content.replace("Planned queries: ", "").split(", ");
  } else {
    // If we are in a loop, generate new queries based on findings
    const llm = getLLM().withStructuredOutput(searchQueriesSchema, {
      method: "jsonMode",
    });
    const res = await llm.invoke([
      new SystemMessage("Based on current findings, generate 1-2 new search queries to fill in knowledge gaps. If no gaps, return empty array. 只输出 JSON 对象：{\"queries\": [...]}，不要输出其他内容。"),
      new HumanMessage(`Task: ${state.researchQuery}\nFindings so far: ${JSON.stringify(state.findings)}`)
    ]) as { queries: string[] };
    queries = res.queries;
  }

  const results = [];
  for (const q of queries) {
    if (!q?.trim()) continue;
    const resStr = await search_web.invoke({ query: q, limit: 3 });
    try {
      const parsed = JSON.parse(resStr);
      results.push(...parsed);
    } catch {
      // ignore
    }
  }

  return {
    searchResults: results,
  };
}

async function readNode(state: ResearcherState) {
  // Find URLs we haven't visited yet
  const toVisit = state.searchResults
    .map(r => r.url)
    .filter(url => !state.visitedSources.includes(url));

  // Enforce MAX_PAGES overall
  const availablePageSlots = MAX_PAGES - state.visitedSources.length;
  const urlsToRead = toVisit.slice(0, Math.max(0, availablePageSlots));

  const newFindings: string[] = [];
  const newlyVisited: string[] = [];

  const llm = getLLM().withStructuredOutput(extractFindingsSchema, {
    method: "jsonMode",
  });

  for (const url of urlsToRead) {
    if (state.visitedSources.length + newlyVisited.length >= MAX_PAGES) break;
    
    const content = await read_url.invoke({ url });
    newlyVisited.push(url);

    if (content && !content.startsWith("Failed to read")) {
      const res = await llm.invoke([
        new SystemMessage(`Extract key findings relevant to: ${state.researchQuery}. Content:\n${content.substring(0, 4000)}\n只输出 JSON 对象：{"findings": ["发现1", "发现2"]}，不要输出其他内容。`)
      ]) as { findings: string[] };
      
      // Append citation info to findings so summarize can map them
      const findingsWithCitation = res.findings.map(f => `${f} (Source: ${url})`);
      newFindings.push(...findingsWithCitation);
    }
  }

  return {
    visitedSources: newlyVisited,
    findings: newFindings,
    loopCount: state.loopCount + 1,
    lastFindingsCount: state.findings.length,
    lastVisitedCount: state.visitedSources.length,
  };
}

async function summarizeNode(state: ResearcherState) {
  const llm = getLLM().withStructuredOutput(finalReportSchema, {
    method: "jsonMode",
  });

  // If no findings, conservative conclusion
  if (state.findings.length === 0) {
    return {
      finalReport: {
        summary: ["Insufficient evidence to form a conclusion."],
        findings: [],
        citations: [],
        recommendations: ["Try refining the search query or providing more context."],
      }
    };
  }

  const prompt = `
    Generate a final research report for: ${state.researchQuery}
    
    Findings:
    ${state.findings.join("\n")}
    
    Sources:
    ${state.visitedSources.join("\n")}
    
    Rules:
    1. Every finding MUST be mapped to at least 1 citation.
    2. Summary should be 3-5 bullet points.

    只输出 JSON 对象：{"summary": ["结论1"], "findings": ["发现1"], "citations": [{"url": "https://...", "title": "标题"}], "recommendations": ["建议1"]}，不要输出其他内容。
  `;

  const report = await llm.invoke([new SystemMessage(prompt)]);

  return {
    finalReport: report,
  };
}

export function shouldContinue(state: ResearcherState) {
  const isLoopMaxed = state.loopCount >= MAX_LOOPS;
  const isSourcesMaxed = state.visitedSources.length >= MAX_SOURCES;
  const isPagesMaxed = state.visitedSources.length >= MAX_PAGES; // same as above basically
  
  // Check if we made progress
  const noNewVisited = state.visitedSources.length === state.lastVisitedCount;
  const noNewFindings = state.findings.length === state.lastFindingsCount;
  const noProgress = state.loopCount > 0 && noNewVisited && noNewFindings;

  if (isLoopMaxed || isSourcesMaxed || isPagesMaxed || noProgress) {
    return "summarize";
  }
  return "search";
}

export function createGraph(options?: { checkpointer?: MemorySaver }) {
  const workflow = new StateGraph(ResearcherStateAnnotation)
    .addNode("planner", plannerNode)
    .addNode("search", searchNode)
    .addNode("read", readNode)
    .addNode("summarize", summarizeNode)
    .addEdge(START, "planner")
    .addEdge("planner", "search")
    .addEdge("search", "read")
    .addConditionalEdges("read", shouldContinue, {
      search: "search",
      summarize: "summarize",
    })
    .addEdge("summarize", END);

  const compiled = workflow.compile({ checkpointer: options?.checkpointer });

  const originalInvoke = compiled.invoke.bind(compiled);
  const originalStream = compiled.stream.bind(compiled);

  const injectCallbacks = (config?: any) => {
    const callbacks = getTracingCallbacks();
    let existing = config?.callbacks || [];
    if (!Array.isArray(existing)) {
      existing = [existing];
    }
    return { ...config, callbacks: [...existing, ...callbacks] };
  };

  return Object.assign(compiled, {
    invoke: async (state: Parameters<typeof originalInvoke>[0], config?: Parameters<typeof originalInvoke>[1]) => {
      return originalInvoke(state, injectCallbacks(config));
    },
    stream: async (state: Parameters<typeof originalStream>[0], config?: Parameters<typeof originalStream>[1]) => {
      return originalStream(state, injectCallbacks(config));
    }
  });
}
