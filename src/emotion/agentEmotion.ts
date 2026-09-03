/**
 * LangGraph 节点 → 球球表情 的驱动规则。
 * 纯函数 + 常量，便于在 React 组件外用/测。
 *
 * 表情 ID 分段（编号永不重排，可硬编码）：
 *   00-09 生命周期：02 待机放空 · 03 好奇
 *   10-29 情绪：10 开心 · 11 疑惑 · 12 失落 · 13 惊讶 · 19 满意
 *   30-49 代理状态：30 思考中 · 31 接收任务 · 32 忙碌 · 33 完成 · 34 出错 · 40 检索
 */

export const EMOJI = {
  IDLE: "02", // 待机放空
  CURIOUS: "03", // 好奇
  HAPPY: "10",
  CONFUSED: "11",
  DOWN: "12",
  SURPRISED: "13",
  PLEASED: "19", // 满意
  THINKING: "30", // 思考中
  ACCEPTING: "31", // 接收任务
  BUSY: "32", // 处理中忙碌
  DONE: "33", // 任务完成
  ERROR: "34", // 出错
  SEARCHING: "40", // 检索资料
} as const;

export type EmoId = (typeof EMOJI)[keyof typeof EMOJI];

export const EMOJI_NAME: Record<string, string> = {
  "02": "待机放空",
  "03": "好奇",
  "10": "开心",
  "11": "疑惑",
  "12": "失落",
  "13": "惊讶",
  "19": "满意",
  "30": "思考中",
  "31": "接收任务",
  "32": "处理中",
  "33": "任务完成",
  "34": "出错",
  "40": "检索资料",
};

/** RAG 知识库问答（buildGraph）的三个节点 */
export type RagNode = "retrieve" | "rerank" | "generate";

export interface StageInfo {
  emo: EmoId;
  /** 气泡提示文案（节点正在做什么） */
  tip?: string;
}

/** 节点 → 表情 + 文案。update 是 stream('updates') 里该节点的 state 增量。 */
export function driveRagNode(node: string, update: Record<string, any>): StageInfo {
  switch (node as RagNode) {
    case "retrieve": {
      const n = (update.retrievedDocs as any[])?.length;
      return {
        emo: EMOJI.SEARCHING,
        tip: n != null ? `已命中 ${n} 条候选，正在比对…` : "正在检索知识库…",
      };
    }
    case "rerank":
      return { emo: EMOJI.THINKING, tip: "正在评估证据相关性…" };
    case "generate":
      return { emo: EMOJI.BUSY, tip: "正在整理答案…" };
    default:
      return { emo: EMOJI.THINKING, tip: "处理中…" };
  }
}

/** 天气助手 triageGraph（workflow.ts）的节点 */
export type TriageNode =
  | "getDate"
  | "extractLocation"
  | "locate"
  | "searchWeather"
  | "suggest"
  | "final";

/** triageGraph 节点 → 表情 + 文案 */
export function driveTriageNode(node: string, update: Record<string, any>): StageInfo {
  switch (node as TriageNode) {
    case "getDate":
      return {
        emo: EMOJI.THINKING,
        tip: update.date ? `已推断日期：${update.date}` : "正在推断目标日期…",
      };
    case "extractLocation":
      return {
        emo: EMOJI.THINKING,
        tip: update.location ? `已识别地点：${update.location}` : "正在提取地点…",
      };
    case "locate":
      return { emo: EMOJI.SEARCHING, tip: "正在定位当前位置…" };
    case "searchWeather":
      return { emo: EMOJI.SEARCHING, tip: "正在查询实时天气…" };
    case "suggest":
      return { emo: EMOJI.BUSY, tip: "正在生成穿衣/防晒建议…" };
    case "final":
      return { emo: EMOJI.BUSY, tip: "正在生成天气播报…" };
    default:
      return { emo: EMOJI.THINKING, tip: "处理中…" };
  }
}

/**
 * 回答文本 → 情绪表情（规则版，零成本零延迟）。
 * 想升级为「模型自主判定」：把文本交给 LLM 结构化输出 emotionId 后映射回来即可，
 * 这里只做最终答案的轻量情绪渲染。
 */
export function moodFromAnswer(answer: string): EmoId {
  const t = answer || "";
  if (/抱歉|无法|未能|未检索|未找到|失败|无可用|拒绝|error|Error/i.test(t)) {
    return EMOJI.DOWN;
  }
  if (/！|!|太好了|没问题|当然可以|是的，可以|恭喜/.test(t)) {
    return EMOJI.HAPPY;
  }
  if (/不确定|也许|可能|大概|需要确认/.test(t)) {
    return EMOJI.CONFUSED;
  }
  if (/确实|根据|规定|条例|按照/.test(t)) {
    return EMOJI.PLEASED;
  }
  return EMOJI.PLEASED;
}

/** 流程开始提示词（复述用户问题，带点"听到了"的反馈感） */
export function acceptingTip(query: string): string {
  const q = (query || "").trim();
  return q.length > 24 ? `收到：「${q.slice(0, 24)}…」` : `收到：「${q}」`;
}
