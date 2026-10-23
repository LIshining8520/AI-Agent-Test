/**
 * 需求画像解析（第 2 段契约 + 第 3 段解析管线 + 第 4 段冲突检测）
 *
 * 移植自 `apps/lesson9-12-travel/src/domain/profile/profile-parser.ts`（附录 A 第 5 项）。
 *
 * 流程（多阶段、层级降级）：
 *  1) LLM 结构化抽取（generateJson，温度 0）；
 *  2) JSON 失败/异常 → 降级为经验规则提取（目的地主数据 + 天数/预算正则）；
 *  3) 与 defaultProfile 合并归一（null → 默认值，不留半空字段给下游）；
 *  4) detectConflicts 查冲突、missingFields 出待澄清清单。
 *
 * 依赖注入：构造时传入 LlmClient，不感知具体供应商。
 */
import {
  defaultProfile,
  detectConflicts,
  type ProfileParseResult,
} from '../../shared/trip-profile';
import type { TripProfile, Companion } from '../../shared/travel-types';
import type { LlmClient } from '../../shared/llm';
import {
  extractDestinationFromText,
  normalizeDestination,
  splitList,
} from '../travel-knowledge';

/** LLM 结构化输出的宽松中间形态（字段均可选，此后归一化进 TripProfile） */
interface RawProfile {
  destination?: string;
  days?: number;
  budget?: number;
  companions?: string[];
  pace?: string;
  interests?: string[];
  accommodationLevel?: string;
  diet?: string[];
  mustVisit?: string[];
  avoid?: string[];
  startDate?: string;
}

type Pace = TripProfile['preferences']['pace'];
type AccommodationLevel = TripProfile['preferences']['accommodationLevel'];

const PACES: Pace[] = ['relaxed', 'moderate', 'intensive'];
const LEVELS: AccommodationLevel[] = ['economy', 'comfort', 'luxury'];

/** 合法同行人集合；弃非法项，空则给默认 [adult] */
function toCompanions(raw: string[] | undefined): Companion[] {
  const map: Record<string, Companion> = {
    adult: 'adult',
    成人: 'adult',
    成年人: 'adult',
    elder: 'elder',
    老人: 'elder',
    长辈: 'elder',
    child: 'child',
    儿童: 'child',
    小孩: 'child',
    孩子: 'child',
    infant: 'infant',
    婴儿: 'infant',
  };
  const list = (raw ?? [])
    .map((s) => map[s.trim().toLowerCase()] ?? map[s.trim()])
    .filter((c): c is Companion => c != null);
  return list.length > 0 ? list : ['adult'];
}

/** 从原文兜底：天数（N天/N日/N晚） */
function guessDays(text: string): number | undefined {
  const m = text.match(/(\d{1,2})\s*(天|日|晚)/);
  return m ? Math.max(1, Math.min(30, Number(m[1]))) : undefined;
}

/** 从原文兜底：预算（数字元 / x万 / ¥） */
function guessBudget(text: string): number | undefined {
  // 万单位：3万 / 2.5万 / 「3天2万」里的 2万
  const wan = text.match(/(\d+(?:\.\d+)?)\s*万(?!\d)/);
  if (wan) return Math.round(Number(wan[1]) * 10000);
  // 具体金额：3 位以上数字 + 可选的元/块（排除天/日的数字）
  const yuan = text.match(/(?:^|\D)(\d{3,})\s*(元|块|rmb)?/i);
  if (yuan) return Number(yuan[1]);
  return undefined;
}

/** 规则提取：目的地 + 天数 + 预算 + 偏好粗抛（LLM 不可用时唯一的信息来源） */
function ruleExtract(text: string): RawProfile {
  const out: RawProfile = {};
  out.destination = extractDestinationFromText(text)?.key;
  out.days = guessDays(text);
  out.budget = guessBudget(text);

  // 兴趣（多命中即多选，别只留最后一个 —— 原版写法会让「美食+科技」只剩科技）
  const interests: string[] = [];
  if (/自然|风光|山水|风景|户外/.test(text)) interests.push('自然');
  if (/人文|历史|古镇|博物馆|文化/.test(text)) interests.push('人文');
  if (/美食|吃|火锅|小吃/.test(text)) interests.push('美食');
  if (/亲子|孩子|带娃|儿童/.test(text)) interests.push('亲子');
  if (/摄影|拍照|出片/.test(text)) interests.push('摄影');
  if (/购物|买买买/.test(text)) interests.push('购物');
  if (interests.length > 0) out.interests = interests;

  // 住宿档：第 4 段冲突演示的关键字段 —— 没有它，「预算低却要豪华」这条冲突
  // 在没有 Key 的规则模式下永远检不出来（第 4 段的价值就演示不了）。
  if (/豪华|奢侈|五星|高档|顶配/.test(text)) out.accommodationLevel = 'luxury';
  else if (/经济|穷游|青旅|省钱|便宜/.test(text)) out.accommodationLevel = 'economy';
  else if (/舒适|中档|干净就行/.test(text)) out.accommodationLevel = 'comfort';

  // 节奏
  if (/慢节奏|放慢|轻松|悠闲|不赶/.test(text)) out.pace = 'relaxed';
  else if (/紧凑|打卡|特种兵|赶时间|尽量多/.test(text)) out.pace = 'intensive';

  // 同行人（粗判，够撑起住宿房数与餐饮口径）
  const companions: string[] = [];
  if (/一家|家庭|夫妻|情侣|我们|我和/.test(text)) companions.push('adult');
  if (/爸妈|父母|老人|长辈|带妈|带爸/.test(text)) companions.push('elder');
  if (/孩子|小孩|儿童|带娃/.test(text)) companions.push('child');
  if (/婴儿|宝宝/.test(text)) companions.push('infant');
  if (companions.length > 0) out.companions = companions;

  return out;
}

export class ProfileParser {
  private readonly llm: LlmClient;

  constructor(llm: LlmClient) {
    this.llm = llm;
  }

  /**
   * 解析一句话需求。
   * @param rawInput 用户原始自然语言输入（空则整单待澄清）
   * @param opts.forceRule 跳过 LLM 直接走规则提取（确定性演示/快照用）
   */
  async parse(rawInput: string, opts: { forceRule?: boolean } = {}): Promise<ProfileParseResult> {
    const raw = (rawInput ?? '').trim();

    // 空输入：全部必填待澄清
    if (!raw) {
      const base = defaultProfile();
      return {
        ok: false,
        profile: base,
        missing: ['destination', 'days', 'budget'],
        conflicts: [],
        rawInput,
        source: 'empty',
      };
    }

    const parsed = await this.tryParseViaLlm(raw, opts.forceRule ?? false);
    const merged = this.mergeProfile(parsed.fields);
    const conflicts = detectConflicts(merged);
    const missing = this.missingFields(merged);

    return {
      ok: missing.length === 0,
      profile: merged,
      missing,
      conflicts,
      rawInput,
      source: parsed.source,
      degradedReason: parsed.reason,
    };
  }

  /** 优先 LLM 结构化抽取，失败降级规则提取；forceRule=true 时完全不触达 LLM */
  private async tryParseViaLlm(
    raw: string,
    forceRule = false,
  ): Promise<{ fields: RawProfile; source: 'llm' | 'rule'; reason?: string }> {
    if (forceRule) {
      // 确定性路径：与 LLM 不可用时的降级出口共用同一套规则，口径一致
      return { fields: ruleExtract(raw), source: 'rule', reason: 'forceRule（跳过 LLM）' };
    }
    try {
      const sys = [
        '你是资深旅游规划师。把用户的自然语言需求抽取成结构化字段，严格输出 JSON，',
        '字段同输出 schema：destination(string 目的地规范名)、days(number 行程天数)、',
        'budget(number 单位元)、companions(string[]: adult/elder/child/infant)、',
        'pace(relaxed|moderate|intensive)、interests(string[])、',
        'accommodationLevel(economy|comfort|luxury)、diet(string[] 过敏/禁忌)、',
        'mustVisit(string[])、avoid(string[])、startDate(string ISO)。缺失未知填 null。',
      ].join('');
      const { data } = await this.llm.generateJson<RawProfile>({
        role: 'PROFILE',
        system: sys,
        user: raw,
        json: true,
        temperature: 0,
      });
      return { fields: this.sanitize(data), source: 'llm' };
    } catch (err) {
      // LLM 不可用 / 返回非 JSON：降级为经验规则提取，动线不中断
      return {
        fields: ruleExtract(raw),
        source: 'rule',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 清洗 LLM 原始 JSON：字段类型兜底（模型会给出 "5天"、负数、字符串数组等脏值） */
  private sanitize(d: RawProfile): RawProfile {
    const daysNum = typeof d.days === 'number' ? d.days : Number(d.days);
    const budgetNum = typeof d.budget === 'number' ? d.budget : Number(d.budget);
    return {
      ...d,
      days: Number.isFinite(daysNum) && daysNum > 0 ? Math.min(daysNum, 30) : undefined,
      budget: Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : undefined,
      interests: Array.isArray(d.interests) ? d.interests : undefined,
      diet: Array.isArray(d.diet) ? d.diet : undefined,
      companions: Array.isArray(d.companions) ? d.companions : undefined,
      mustVisit: Array.isArray(d.mustVisit)
        ? d.mustVisit
        : splitList(typeof d.mustVisit === 'string' ? d.mustVisit : undefined),
      avoid: Array.isArray(d.avoid)
        ? d.avoid
        : splitList(typeof d.avoid === 'string' ? d.avoid : undefined),
    };
  }

  /** 把宽松字段并入 defaultProfile 得到完整画像 */
  private mergeProfile(f: RawProfile): TripProfile {
    const base = defaultProfile();
    return {
      // 目的地统一归一为规范中文名（LLM 可能返回英文/别名，如 Beijing → 北京）
      destination: normalizeDestination(f.destination) || base.destination,
      days: f.days ?? base.days,
      budget: f.budget ?? base.budget,
      companions: f.companions ? toCompanions(f.companions) : base.companions,
      preferences: {
        pace: isPace(f.pace) ? f.pace : base.preferences.pace,
        interests: f.interests ?? base.preferences.interests,
        accommodationLevel: isLevel(f.accommodationLevel)
          ? f.accommodationLevel
          : base.preferences.accommodationLevel,
        diet: f.diet ?? base.preferences.diet,
      },
      constraints: {
        startDate: f.startDate || base.constraints.startDate,
        mustVisit: f.mustVisit ?? base.constraints.mustVisit,
        avoid: f.avoid ?? base.constraints.avoid,
      },
    };
  }

  /** 必填字段缺省列表（用于澄清） */
  private missingFields(p: TripProfile): string[] {
    const out: string[] = [];
    if (!p.destination) out.push('destination');
    if (!(p.days > 0)) out.push('days');
    if (!(p.budget > 0)) out.push('budget');
    return out;
  }
}

function isPace(v: string | undefined): v is Pace {
  return !!v && (PACES as string[]).includes(v);
}
function isLevel(v: string | undefined): v is AccommodationLevel {
  return !!v && (LEVELS as string[]).includes(v);
}
