/**
 * 景点推荐 SubAgent 递归子图（第三部分 3.5「SubAgent」）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/tools/sub-agent.ts`（附录 A · domain.tools）。
 *
 * 主管之下追加「景点推荐 SubAgent」，沿既有 LangGraph 图能力再往下钻一层：
 * 用嵌套 StateGraph 把「推荐 → 再往下钻 → 直到深度上限或收敛」建模为带自回边的递归子图，
 * 每轮建议由上一轮推荐里「最想继续深挖」的景点展开下一轮更细的推荐。
 *
 * 递归必须可终止：maxDepth 上限 + 收敛判定（候选被推荐过则停），防止无限下钻。
 * 用 knowledge 经验规则产出确定性推荐，无需 LLM 也可复现（真实课程可换 LLM 打分）。
 */
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { TripProfile } from '../../shared/travel-types';
import { findKnowledge } from '../travel-knowledge';

/** 一条景点推荐 */
export interface AttractionRecommendation {
  name: string;
  reason: string;
  matchScore: number;
  depth: number;
}

/** 收敛判定（在当前状态上，未到深度上限且未收敛则继续下钻） */
export function shouldDrill(state: {
  depth: number;
  maxDepth: number;
  recommendations: AttractionRecommendation[];
}): boolean {
  return state.depth < state.maxDepth && state.recommendations.length < 24;
}

/** 经验规则推荐一轮：按兴趣加权挑出「本深度最匹配」的一个（确定性） */
export function recommendAttractions(
  destination: string,
  interests: string[],
  previous: string[],
): AttractionRecommendation[] {
  const k = findKnowledge(destination);
  const pool = (k?.attractions ?? [destination]).filter((a) => !previous.includes(a));
  const score = (name: string, aim: string): number => {
    if (aim === '自然') return /山|湖|海|江|瀑|雪|林|河/.test(name) ? 3 : 1;
    if (aim === '人文' || aim === '历史') return /城墙|寺|庙|宫|城|墓|遗址|楼/.test(name) ? 3 : 1;
    if (aim === '美食') return /街|巷|坊/.test(name) ? 2 : 1;
    return 1;
  };
  return pool
    .map((name) => ({
      name,
      matchScore: interests.reduce((s, i) => s + score(name, i), 1),
      reason: interests.length ? `匹配兴趣「${interests.slice(0, 2).join('、')}」` : '经典必游',
      depth: 0, // 调用方覆写真实深度
    }))
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 1);
}

/** 子图状态：destination/interests 注入 + 逐轮累积 recommendations + 深度控制 */
const SubState = Annotation.Root({
  destination: Annotation<string>,
  interests: Annotation<string[]>({ reducer: (_l, r) => r, default: () => [] }),
  recommendations: Annotation<AttractionRecommendation[]>({
    reducer: (l, r) => l.concat(r),
    default: () => [],
  }),
  depth: Annotation<number>({ reducer: (_l, r) => r, default: () => 0 }),
  maxDepth: Annotation<number>({ reducer: (_l, r) => r, default: () => 3 }),
});

/**
 * 景点推荐 SubAgent：嵌套 LangGraph 子图 + 递归自回边（深度控制 terminate）。
 * run(profile, maxDepth) 返回逐层下钻的推荐链。
 */
export class AttractionSubAgent {
  /** 构造并编译递归下钻子图 */
  private static build() {
    const recommend = async (
      state: typeof SubState.State,
    ): Promise<Partial<typeof SubState.State>> => {
      const previous = state.recommendations.map((r) => r.name);
      const batch = recommendAttractions(state.destination, state.interests, previous).map((r) => ({
        ...r,
        depth: state.depth,
      }));
      return { recommendations: batch, depth: state.depth + 1 };
    };

    return new StateGraph(SubState)
      .addNode('recommend', recommend)
      .addEdge(START, 'recommend')
      // 递归自回边：未到深度上限/未收敛 → 再下一钻；否则收束到 END
      .addConditionalEdges('recommend', (state) => (shouldDrill(state) ? 'drill' : '__end__'), {
        drill: 'recommend',
        __end__: END,
      })
      .compile();
  }

  private readonly graph = AttractionSubAgent.build();

  /** 运行子图：注入画像与深度上限，返回逐层下钻推荐链 */
  async run(
    profile: TripProfile,
    opts: { maxDepth?: number } = {},
  ): Promise<{
    recommendations: AttractionRecommendation[];
    depthReached: number;
  }> {
    const maxDepth = opts.maxDepth ?? 3;
    const final = (await this.graph.invoke({
      destination: profile.destination || '',
      interests: profile.preferences.interests ?? [],
      recommendations: [] as AttractionRecommendation[],
      depth: 0,
      maxDepth,
    })) as unknown as typeof SubState.State;
    // 去重并保序（下钻链不重复推荐同一景点）
    const recommendations = (final.recommendations ?? []).filter(
      (r, i, a) => a.findIndex((x) => x.name === r.name) === i,
    );
    return { recommendations, depthReached: recommendations.length };
  }
}
