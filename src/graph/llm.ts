import { ChatOpenAI } from "@langchain/openai";
import type { BaseMessage } from "@langchain/core/messages";

// 浏览器环境没有 process.env，Vite 会把 .env 中 VITE_ 开头的变量注入 import.meta.env。
// 注意：VITE_ 变量会打进前端产物，仅供本地/内部开发使用，部署到公网请走后端代理。
const deepseekApiKey = import.meta.env.VITE_DEEPSEEK_API_KEY as string | undefined;
const deepseekBaseURL =
  import.meta.env.VITE_DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const deepseekModel = import.meta.env.VITE_DEEPSEEK_MODEL || "deepseek-v4-flash";

function toText(input: string | BaseMessage[]): string {
  if (Array.isArray(input)) {
    return input
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
  }
  return String(input);
}

// 没有配置任何 Key 时使用本地 Mock，保证页面依然可以跑通（结构化输出按节点返回空结果）。
function createMockLLM(): any {
  return {
    async invoke(input: string | BaseMessage[]): Promise<{ content: string }> {
      console.warn("⚠️ [Mock Mode] 未配置 API Key，返回 Mock 结果。");
      return { content: `[Mock] ${toText(input).slice(0, 500)}` };
    },
    withStructuredOutput(_schema: any) {
      return {
        async invoke(input: string | BaseMessage[]): Promise<Record<string, unknown>> {
          console.warn("⚠️ [Mock Mode] 未配置 API Key，按节点返回预置结果。");
          const text = toText(input);
          if (text.includes("Research Task:")) {
            const task = text.split("Research Task:").pop()?.trim() || "research";
            return { queries: [task] };
          }
          if (text.includes("Based on current findings")) {
            return { queries: [] };
          }
          if (text.includes("Extract key findings")) {
            const topic =
              text.split("relevant to:").pop()?.split(".")[0]?.trim() || "该主题";
            return {
              findings: [
                `Mock 模式：检索到与“${topic}”相关的内容，配置 API Key 后可生成真实结论。`,
              ],
            };
          }
          if (text.includes("Generate a final research report")) {
            const topic =
              text.split("Generate a final research report for:")[1]?.split("Findings:")[0]?.trim() ||
              "该主题";
            return {
              summary: [`Mock 模式：未配置 API Key，无法生成真实报告（主题：${topic}）。`],
              findings: [],
              citations: [],
              recommendations: [
                "配置 VITE_DEEPSEEK_API_KEY 后重试。",
              ],
            };
          }
          return {};
        },
      };
    },
  };
}

// 研究型工作流统一从这里拿模型实例：只走 DeepSeek，没有 Key 则走 Mock。
export function getLLM(): any {
  if (deepseekApiKey) {
    return new ChatOpenAI({
      model: deepseekModel,
      apiKey: deepseekApiKey,
      temperature: 0,
      configuration: { baseURL: deepseekBaseURL },
    });
  }

  return createMockLLM();
}

// 原 @offerai/shared 的追踪回调：本项目未接入 Langfuse/LangSmith，返回空即可。
export function getTracingCallbacks(): any[] {
  return [];
}
