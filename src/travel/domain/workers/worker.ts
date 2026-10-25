/**
 * Worker 基类：角色内有界自检循环（第三部分「工具进 verify」+ 第五部分「收敛重派」的落点）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/workers/worker.ts`（附录 A · domain.workers）。
 *
 * 三个执行者共用同一套骨架，只实现三个钩子：
 *  - buildPrompt：构造结构化生成的指令（含 role 供成本归因）
 *  - normalize：把 LLM 原始 JSON 清洗成领域产物（容错、给默认值）
 *  - fallback：纯逻辑兜底，保证无 LLM 也能产出最小可用产物
 * 需要自检时再补一个 verify（纯函数或可调工具的异步函数）。
 *
 * 本课的增量有三处，都在 {@link BaseWorker.run} 里：
 *  1) 有界循环：生成 → 自检 → 带反馈重生成，轮次封顶 {@link MAX_ATTEMPTS}；
 *  2) 黑板注入：任务描述 / 已确认事实 / 上轮反馈统一在基类拼进 user 尾部；
 *  3) 用量逐轮累加：一次 run 可能产生多次计费调用，只记最后一次会系统性少算成本。
 */
import type { GenerateRequest, LlmClient, UsageSnapshot } from '../../shared/llm';
import type { TripProfile } from '../../shared/travel-types';
import type {
  TravelWorker,
  TravelWorkerContext,
  VerificationResult,
  WorkerResult,
} from '../orchestration/worker-protocol';

/**
 * 单个角色在一次编排里最多跑几轮：首轮 + 一次修正。
 *
 * 为什么是 2 而不是 3+：自检反馈对「格式/数量/超限」这类确定性缺陷通常一轮就能改对；
 * 第二轮仍不通过，多半是模型能力或画像本身的硬约束（如预算根本不够），
 * 继续重试只是把同样的错误再买一遍 token。成本可控比「多试几次」更重要。
 */
export const MAX_ATTEMPTS = 2;

/** WorkerContext 别名：三大执行者的 buildPrompt(profile, ctx) 第二参用它 */
export type WorkerContext = TravelWorkerContext;

/** 零用量快照（兜底路径：无 LLM 调用，成本为 0） */
function zeroUsage(role: string): UsageSnapshot {
  return { role, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
}

/**
 * 把一轮调用的 usage 累加进汇总快照。
 *
 * 为什么必须逐轮相加、而不是只记最后一次：角色内循环让**一次 run 可能产生多次计费调用**，
 * 成本归因按 `WorkerResult.usage` 入桶；只留最后一轮会系统性地少算
 * 「第一轮 + 修正轮」里被丢掉的那部分，越是需要修正的画像（往往正是最贵的复杂需求）
 * 低估得越多。role 固定用本角色的 roleId，保证多次调用归到同一个成本桶。
 */
function addUsage(into: UsageSnapshot, u: UsageSnapshot): void {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.totalTokens += u.totalTokens;
  into.costUsd += u.costUsd;
}

/**
 * Worker 基类。
 * 注意：本仓 tsconfig 开了 `erasableSyntaxOnly`，不能用构造参数属性（`constructor(private x)`），
 * 所以这里用显式字段声明 —— 功能等价。
 */
export abstract class BaseWorker<T> implements TravelWorker {
  protected readonly roleId: string;
  protected readonly llm: LlmClient;
  abstract readonly kind: TravelWorker['kind'];

  protected constructor(llm: LlmClient, role: string) {
    this.llm = llm;
    this.roleId = role;
  }

  /** 构造结构化生成的 prompt（含 role 供成本归因） */
  abstract buildPrompt(profile: TripProfile, context: WorkerContext): GenerateRequest;

  /** 把 LLM 原始 JSON 清洗/校验为领域产物 */
  abstract normalize(data: unknown, profile: TripProfile): T;

  /** 纯逻辑兜底：基于主数据经验规则产出最小可用产物 */
  abstract fallback(profile: TripProfile): T;

  /**
   * 可选自检钩子（协议同名字段）：实现后每轮生成完都会被调一次。
   * 不实现即退化为「跑一次就交付」的旧行为，与协议里的 `verify?` 语义一致。
   */
  verify?(data: T, ctx: WorkerContext): VerificationResult | Promise<VerificationResult>;

  /**
   * 协议统一入口：run(ctx)（ctx.profile 为预期画像，ctx.llm 可选覆盖构造注入）。
   *
   * 有界循环的形状是「生成 → 自检 → 带反馈重生成」，只对**模型真实返回并归一化后**的产物自检：
   * 兜底产物是确定性经验规则的结果，自检它等于既当运动员又当裁判，不产生任何信息。
   */
  async run(ctx: TravelWorkerContext): Promise<WorkerResult<T>> {
    const profile = ctx.profile;
    const role = this.roleId;
    const llm = ctx.llm ?? this.llm;

    // 演示/评测强制兜底：跳过 LLM（这是**预期路径**，不是异常，所以不记 error）
    if (ctx.forceFallback) {
      ctx.board?.recordAttempt(this.kind, { attempts: 1, ok: true });
      return {
        data: this.fallback(profile),
        usage: zeroUsage(role),
        ok: true,
        source: 'fallback',
        traceId: ctx.traceId,
        attempts: 1,
      };
    }

    // 跨轮累计：成本归因看到的是「这个角色这次一共花了多少」，见 addUsage 注释
    const usage = zeroUsage(role);
    let lastData: T | undefined;
    // 首轮就带上上游（收敛门重派）传入的 feedback：否则这次派发就是「无反馈盲重试」，
    // 修复方向丢失。之后每轮由本角色 verify 的反馈覆盖（角色内自检优先于编排层旧指令）。
    let lastFeedback: string | undefined = ctx.feedback;

    /**
     * 两个「轮次」不是一回事：
     *  - `ctx.attempt`：**编排轮次**，收敛门重派时写入（首轮缺省）——
     *    它告诉角色「现在是整次编排的第几轮」，必须原样透传给子类 buildPrompt。
     *  - `selfCheckRound`：**角色内自检轮次**，只在本循环内 1..MAX_ATTEMPTS 递增，
     *    仅用于「第 N 轮修正要求」的文案与 attempts 记账。
     * 二者混用会让「收敛门第 2 轮」被写成「自检第 1 轮」，上游轮次语义就丢了。
     */
    for (let selfCheckRound = 1; selfCheckRound <= MAX_ATTEMPTS; selfCheckRound++) {
      // 反馈、轮次、任务描述与黑板事实都在基类拼进 prompt，子类的 buildPrompt 无需感知这些
      const roundCtx: WorkerContext = {
        ...ctx,
        attempt: ctx.attempt ?? selfCheckRound,
        feedback: lastFeedback,
      };
      const prompt = this.withFeedback(
        this.withBoardFacts(
          this.withTaskDescription(this.buildPrompt(profile, roundCtx), roundCtx.taskDescription),
          roundCtx.board?.summaryFor(this.kind),
        ),
        selfCheckRound,
        lastFeedback,
      );

      let raw: unknown;
      try {
        const res = await llm.generateJson<unknown>({ ...prompt, role, json: true });
        raw = res.data;
        addUsage(usage, res.usage);
      } catch (err) {
        // 调用失败与「产物不达标」是两回事：前者没有可用产物，只能落兜底（保持旧语义）
        const reason = err instanceof Error ? err.message : String(err);
        ctx.board?.recordAttempt(this.kind, {
          attempts: selfCheckRound,
          ok: false,
          lastFeedback: reason,
        });
        return {
          data: this.fallback(profile),
          usage,
          ok: true,
          error: `fallback: ${reason}`,
          source: 'fallback',
          traceId: ctx.traceId,
          attempts: selfCheckRound,
        };
      }

      const data = this.normalize(raw, profile);
      lastData = data;

      const verdict: VerificationResult = this.verify
        ? await this.verify(data, roundCtx)
        : { ok: true };

      // 事实只在自检通过时回写：这一轮的结果才谈得上「被角色核过」
      if (verdict.ok && verdict.facts) ctx.board?.write(this.kind, verdict.facts);
      ctx.board?.recordAttempt(this.kind, {
        attempts: selfCheckRound,
        ok: verdict.ok,
        lastFeedback: verdict.feedback,
      });

      if (verdict.ok) {
        return {
          data,
          usage,
          ok: true,
          source: 'llm',
          traceId: ctx.traceId,
          attempts: selfCheckRound,
        };
      }
      lastFeedback = verdict.feedback;
    }

    const reason = `verify 未通过（${MAX_ATTEMPTS} 轮）：${lastFeedback ?? '未给出原因'}`;

    // 产物在归一化阶段就为空/异常（子类 normalize 理论上会兜底，这里只防守异常实现）
    if (lastData === undefined || lastData === null) {
      return {
        data: this.fallback(profile),
        usage,
        ok: true,
        error: `${reason}；产物为空，已落兜底`,
        source: 'fallback',
        traceId: ctx.traceId,
        attempts: MAX_ATTEMPTS,
      };
    }

    /**
     * 到上限仍返回**最后一轮产物**，而不是换兜底，也刻意保留 ok=true。
     *
     * 教学意图：学员要看到「模型尽力了但没通过」——产物与不合格原因同时在场，
     * 才能判断是模型没改对、还是画像本身自相矛盾（例如预算 8000 硬要住五星）。
     * 直接丢兜底会让不合格产物消失，feedback 变成无凭据的一句错误。
     *
     * ok=true 不是「自检通过」的意思：编排侧在 ok=false 时只收错误、**不接收 data**，
     * 产物会被空计划替换，上面那条教学线索就断了。
     * 失败信号因此走 error（含最后一轮 feedback）与 attempts，而不是从 ok 上掐断产物。
     */
    return {
      data: lastData,
      usage,
      ok: true,
      error: reason,
      source: 'llm',
      traceId: ctx.traceId,
      attempts: MAX_ATTEMPTS,
    };
  }

  /**
   * 把编排层下发的任务描述拼进 user 消息。
   *
   * 放在基类与黑板/反馈同一位置注入：三者都是「编排层给角色的指令」，
   * 子类只关心自己的领域产物。任务段必须在黑板与修正要求之前——
   * 后两者是「在本任务范围内的补充前提」，换了顺序模型容易把任务描述当成可协商项。
   */
  private withTaskDescription(req: GenerateRequest, taskDescription?: string): GenerateRequest {
    const task = taskDescription?.trim();
    if (!task) return req;
    return {
      ...req,
      user: [req.user, '', `【本次任务】${task}`].join('\n'),
    };
  }

  /**
   * 把共享黑板里**已确认的事实**拼进 user 消息。
   *
   * 措辞上写成「已确认事实 / 可视为既定前提」而不是「必须按此执行」：
   * 黑板给的是**共同语境**，不是覆盖画像的新指令——若写成命令式，
   * 模型会把「住宿 4 晚」这类事实当成硬约束去改本不该改的字段。
   */
  private withBoardFacts(req: GenerateRequest, summary?: string): GenerateRequest {
    const facts = summary?.trim();
    if (!facts) return req;
    return {
      ...req,
      user: [
        req.user,
        '',
        `【协作黑板】${facts}。这些是本次协作中已确认的共享事实，可以视为既定前提。`,
      ].join('\n'),
    };
  }

  /**
   * 把上一轮自检反馈拼进 user 消息。
   *
   * 放在基类而不是各子类 buildPrompt 里：feedback 是循环的产物，
   * 让三个子类各自拼一次，等于把「怎么描述修正要求」复制三份，迟早口径不一致。
   */
  private withFeedback(req: GenerateRequest, attempt: number, feedback?: string): GenerateRequest {
    if (!feedback) return req;
    return {
      ...req,
      user: [
        req.user,
        '',
        `【第 ${attempt} 轮修正要求】上一轮产物未通过自检：${feedback}`,
        '请只修正上述问题，其余已满足要求的内容保持不变；仍然只输出 JSON。',
      ].join('\n'),
    };
  }
}

/**
 * 把 `day` 收敛到 `[1, days]`（**路线与行程两个子链共用，单一来源**）。
 *
 * 为什么必须收敛：LLM 给的 `day` 不可信 —— 偶发越界（5 天行程给 day=6）或 0 基序号，
 * 会让下游「行程合理性」的时序校验直接判否。本仓实测：只修路线侧、漏修行程侧时，
 * 同一套评测出现 100/100/66.7 的间歇失败；两侧共用本函数后口径一致。
 *
 * ⚠️ 非正数视为「缺失」按序号补位，不能夹到 1：
 * LLM 常见 0 基序号（第 3 天给 day=0 会被夹成 1，与第 1 天重复）。
 */
export function clampDay(raw: number | undefined, fallback: number, days: number): number {
  const upper = Math.max(days, 1);
  const d =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
  return Math.min(Math.max(d, 1), upper);
}
