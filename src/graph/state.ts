import { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

export interface Citation {
  url: string;
  title: string;
}

export interface FinalReport {
  summary: string[];
  findings: string[];
  citations: Citation[];
  recommendations: string[];
}

export const ResearcherStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  // 用户输入的原始文本，作为检索主题
  input: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  researchQuery: Annotation<string>({
    reducer: (curr, update) => update ?? curr,
    default: () => "",
  }),
  searchResults: Annotation<any[]>({
    reducer: (curr, update) => curr.concat(update),
    default: () => [],
  }),
  visitedSources: Annotation<string[]>({
    reducer: (curr, update) => Array.from(new Set(curr.concat(update))),
    default: () => [],
  }),
  findings: Annotation<string[]>({
    reducer: (curr, update) => curr.concat(update),
    default: () => [],
  }),
  finalReport: Annotation<FinalReport | null>({
    reducer: (curr, update) => update ?? curr,
    default: () => null,
  }),
  loopCount: Annotation<number>({
    reducer: (_previous, update) => update,
    default: () => 0,
  }),
  lastFindingsCount: Annotation<number>({
    reducer: (_previous, update) => update,
    default: () => 0,
  }),
  lastVisitedCount: Annotation<number>({
    reducer: (_previous, update) => update,
    default: () => 0,
  }),
});

export type ResearcherState = typeof ResearcherStateAnnotation.State;
