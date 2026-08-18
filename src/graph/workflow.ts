import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

// 浏览器环境没有 process.env，Vite 会把 .env 中 VITE_ 开头的变量注入 import.meta.env。
// 注意：VITE_ 变量会打进前端产物，仅供本地/内部开发使用，部署到公网请走后端代理。
const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined;
const modelName =
  import.meta.env.VITE_DEEPSEEK_MODEL || "deepseek-v4-flash";
const baseURL =
  import.meta.env.VITE_DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";


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
  date: Annotation<string>(),
  holiday: Annotation<string>(),
});
const model = apiKey
  ? new ChatOpenAI({
      model: modelName,
      apiKey,
      temperature: 0,
      configuration: { baseURL },
      // DeepSeek V4 默认开启思考模式，思考模式下不支持 tool_choice / json_schema，
      // 所以关闭思考模式，结构化输出走 jsonMode（response_format=json_object）
      // modelKwargs: {
      //   thinking: { type: "disabled" },
      // },
    }):
    {
      invoke: async (input: string) => ({
        content: `[Mock 翻译] ${input}`,
      }),
      withStructuredOutput: (_schema: any) => ({
        invoke: async (input: string) => {
          console.log("⚠️ [Mock Mode] 无 API Key，按预置规则分流（纯字符串匹配，非 LLM）。");
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
          return { isBad: /脏话|fuck|shit|傻|笨蛋|脑残/i.test(text) };
        },
      }),
    } as any;

async function checkNode(state: typeof TriageAnnotation.State) {
    const schema = z.object({ isBad: z.boolean() });
  // jsonMode 会设置 response_format=json_object，DeepSeek 要求 prompt 里必须出现
  // "json" 字样，所以提示词里显式要求输出 JSON 对象。
  const res = await model
    .invoke(
     state.input
    );
    console.log(JSON.stringify(res),'res>checkNode');
  return { result: String(res.content) };
}
async function resultNode(state: typeof TriageAnnotation.State) {
  const res = await model.invoke(`请将以下文本翻译为英语: ${state.input}`);
  return { result: String(res.content) };
}
async function getDateNode(state: typeof TriageAnnotation.State) {
  const schema = z.object({ date: z.string() });

  // 本地格式化 YYYY-MM-DD（避免 toISOString 的 UTC 时区偏差）
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;

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
async function searchWeatherNode(state: typeof TriageAnnotation.State) {
   const schema = z.object({ weather: z.string() });
  const res = await model
    .withStructuredOutput(schema, { method: "jsonMode" })
    .invoke(
      `请查询输入日期的天气，只输出 JSON 对象：{"weather": "晴天"} 或 {"weather": "雨天"}，不要输出其他内容。\n文本：${state.date}`,
    );
    console.log(JSON.stringify(res),'res>searchWeatherNode');
  return { weather: res.weather };
}
async function searchHolidayNode(state: typeof TriageAnnotation.State) {
   const schema = z.object({ holiday: z.string() });
  const res = await model
    .withStructuredOutput(schema, { method: "jsonMode" })
    .invoke(
      `请查询输入日期的节日，只输出 JSON 对象：{"holiday": "春节"} 或 {"holiday": "中秋节"}，不要输出其他内容。\n文本：${state.date}`,
    );
    console.log(JSON.stringify(res),'res>searchHolidayNode');
  return { holiday: res.holiday };
}
async function finalNode(state: typeof TriageAnnotation.State) {
  const res = await model.invoke(state.date);
  console.log(JSON.stringify(res),'res>finalNode');
  return { reply: String(res.content) };
}


export const triageGraph = new StateGraph(TriageAnnotation)
  .addNode("check", checkNode)
  .addEdge(START, "check")
  .addNode("translate", resultNode)
  .addNode("searchWeather", searchWeatherNode)
  .addNode("searchHoliday", searchHolidayNode)
  .addNode("getDate", getDateNode)
  .addConditionalEdges("check", (state) => state.isBad ? END : "translate")
  .addConditionalEdges("translate", (state) => state.result ? "getDate" : END)
  .addConditionalEdges("getDate", (state) => state.date ? "searchWeather" : END)
  .addConditionalEdges("searchWeather", (state) => state.weather ? "searchHoliday" : END)
  .addConditionalEdges("searchHoliday", (state) => state.holiday ? "final" : END)
  .addNode("final", finalNode)

  .compile();
