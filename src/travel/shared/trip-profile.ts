/**
 * 旅行画像契约（第 2 / 4 段：画像契约 + 冲突检测）
 *
 * 移植自 `packages/shared/src/trip-profile.ts`（附录 A 第 3-4 项）。
 * 强约束结构化契约：多约束、预算强耦合，schema 可诊断缺字段与字段冲突。
 */
import type { Companion, TripProfile } from './travel-types';

/** 画像解析的结果：成功含 profile；失败给出缺失字段与冲突 */
export interface ProfileParseResult {
  ok: boolean;
  profile?: TripProfile;
  missing: string[]; // 缺失的必填约束（需澄清/默认值兜底）
  conflicts: string[]; // 字段冲突（如预算太低却要求豪华住宿）
  rawInput: string;
  /** 本次解析走的是哪条路（LLM 结构化抽取 / 规则兜底）—— 第 3 段「多阶段降级」要看得见 */
  source?: 'llm' | 'rule' | 'empty';
  /** 降级原因（LLM 失败时记下真实错误，不吞掉） */
  degradedReason?: string;
}

/** 必填字段（缺任一项 → 待澄清，不进编排） */
export const REQUIRED_FIELDS = ['destination', 'days', 'budget'] as const;

/**
 * 字段名 → 中文标签（展示层用）。
 *
 * `missing` 里是内部字段名，那是数据契约；但澄清提示是给终端用户看的文案，
 * 直接 join 出来会读作「请补充：destination、days、budget」。本表只做渲染前翻译，不改契约。
 */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  origin: '出发地',
  destination: '目的地',
  days: '天数',
  budget: '预算',
  companions: '同行人',
  pace: '节奏',
  interests: '兴趣',
  accommodationLevel: '住宿档次',
  diet: '饮食禁忌',
  mustVisit: '必去景点',
  avoid: '规避项',
};

/** 把缺失字段名列表转成中文提示（如「目的地、天数、预算」） */
export function formatMissingFields(missing: readonly string[] | undefined): string {
  if (!missing || missing.length === 0) return '';
  return missing.map((f) => FIELD_LABELS[f] ?? f).join('、');
}

/** 缺省画像（降级兜底，避免字段丢失导致下游空指针） */
export function defaultProfile(): TripProfile {
  return {
    destination: '',
    origin: '',
    days: 0,
    budget: 0,
    companions: ['adult'],
    preferences: {
      pace: 'moderate',
      interests: [],
      accommodationLevel: 'comfort',
      diet: [],
    },
    constraints: { startDate: undefined, mustVisit: [], avoid: [] },
  };
}

/**
 * 冲突检测：把「矛盾」在入口拦住（第 4 段）。
 *
 * 冲突的本质是**输入契约自相矛盾**——「1000 块住豪华酒店」不是模型能力不够，
 * 是怎么排都不可能满足。所以必须在画像层仲裁，不能留给下游执行者各自猜。
 */
export function detectConflicts(p: TripProfile): string[] {
  const out: string[] = [];
  // ⚠️ 与原版的一处**有意偏差**：原版对 days<=0 / budget<=0 也报冲突，于是
  // 「去云南玩」这种**压根没提**天数和预算的输入，会同时得到
  // missing=[days,budget] 与 conflicts=['天数不合法: 0','预算必须为正数']——
  // 把「没填」误报成「填错」，澄清话术自相矛盾。缺失归 missing，冲突归 conflicts。
  if (p.days > 30) out.push(`天数超出上限: ${p.days}`);
  if (p.days > 0 && p.budget > 0) {
    if (p.preferences.accommodationLevel === 'luxury' && p.budget < 2000) {
      out.push('预算偏低但要求豪华住宿');
    }
    if (p.preferences.accommodationLevel === 'luxury' && p.budget / p.days < 800) {
      out.push('人均日预算不足以支撑豪华住宿');
    }
  }
  return out;
}

/** 画像完整度打分（0-1），供评测反映「画像是否完整解析」 */
export function profileCompleteness(p: TripProfile | undefined): number {
  if (!p) return 0;
  let hit = 0;
  const total = REQUIRED_FIELDS.length + 1; // 3 必填 + 1 偏好
  if (p.destination) hit++;
  if (p.days > 0) hit++;
  if (p.budget > 0) hit++;
  if (p.preferences.interests.length > 0) hit++;
  return hit / total;
}

/** 同行人的中文渲染（展示层） */
export const COMPANION_LABELS: Readonly<Record<Companion, string>> = {
  adult: '成人',
  elder: '老人',
  child: '儿童',
  infant: '婴儿',
};
