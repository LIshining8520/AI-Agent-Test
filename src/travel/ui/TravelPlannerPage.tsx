/**
 * 旅游多 Agent 页面（课 9-12 端到端演示）
 *
 * 对应大纲第 7 段「量化验证与端到端演示」：把「画像 → 三子链并行 → 收口质检」
 * 这条动线可视化。左边一句话需求，右边四个面板如实展示每一步产物，
 * 包括**降级**（哪条链走了规则兜底）与**成本**（token / 美元），不粉饰。
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { travelGraph, clarifyPrompt, type TravelState, type CheckItem } from '../graph/travel-graph';
import { getTravelRuntime } from '../application/travel-runtime';
import { profileCompleteness, COMPANION_LABELS } from '../shared/trip-profile';
import type { BudgetPlan, ItineraryPlan, RoutePlan } from '../shared/travel-types';
import { INTERCITY_MODE_LABEL } from '../domain/travel-knowledge';
import { EMOJI } from '../../emotion/agentEmotion';
import './travel.css';


/** 节点 → 展示名（流水线徽章） */
const NODE_LABEL: Record<string, string> = {
  parse: '解析画像',
  dispatch: '拆解派发',
  routeWorker: '路线子链',
  itineraryWorker: '行程子链',
  budgetWorker: '费用子链',
  arbitrate: '收口质检',
};

/** 节点 → 球球情绪（沿用项目既有的表情体系） */
const NODE_EMOJI: Record<string, string> = {
  parse: EMOJI.THINKING,
  dispatch: EMOJI.BUSY,
  routeWorker: EMOJI.BUSY,
  itineraryWorker: EMOJI.BUSY,
  budgetWorker: EMOJI.BUSY,
  arbitrate: EMOJI.PLEASED,
};

const EXAMPLES = [
  '从杭州出发，一家三口去云南玩 5 天，预算 15000，想看自然风光，吃住舒适就行',
  '从上海出发去日本玩 7 天，预算 20000，想吃好住好',
  '去云南玩',
  '预算 1000 但要住豪华酒店，去北京 3 天',
];

const CATEGORY_LABEL: Record<BudgetPlan['allocated'][number]['category'], string> = {
  intercity: '大交通',
  accommodation: '住宿',
  transport: '市内交通',
  food: '餐饮',
  attraction: '门票',
  shopping: '购物',
  reserve: '备用金',
};

const TRANSPORT_LABEL: Record<RoutePlan['routes'][number]['transport'], string> = {
  walk: '步行',
  subway: '地铁',
  bus: '公交',
  taxi: '打车',
  car: '包车',
};

interface Snapshot {
  status?: string;
  profileResult?: TravelState['profileResult'];
  route?: RoutePlan;
  itinerary?: ItineraryPlan;
  budget?: BudgetPlan;
  checks?: CheckItem[];
  cost?: TravelState['cost'];
  summary?: string;
  sources?: Record<string, 'llm' | 'fallback'>;
  errors?: Array<{ kind: string; message: string }>;
}

interface Props {
  /** 把执行阶段同步给页头的球球 */
  onStage?: (emotion: string, tip?: string | null) => void;
}

function TravelPlannerPage({ onStage }: Props) {
  const [input, setInput] = useState(EXAMPLES[0]!);
  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState<string[]>([]);
  const [snap, setSnap] = useState<Snapshot>({});
  const moodTimer = useRef<number | null>(null);
console.log('TravelPlannerPage render', {  snap });
  const runtime = getTravelRuntime();
  const degraded = runtime.forceFallback;
  const run = useCallback(async () => {
    if (!input.trim() || running) return;
    if (moodTimer.current) window.clearTimeout(moodTimer.current);
    setRunning(true);
    setTrace([]);
    setSnap({});
    onStage?.(EMOJI.ACCEPTING, '收到需求，先看这句话能不能立成契约');

    const next: Snapshot = {};
    try {
      const stream = await travelGraph.stream(
        { input: input.trim(), traceId: runtime.newTraceId(), forceFallback: runtime.forceFallback },
        { streamMode: 'updates' },
      );

      for await (const step of stream as AsyncIterable<Record<string, any>>) {
        const node = Object.keys(step)[0];
        if (!node || node === '__end__') continue;
        const upd: Record<string, any> = step[node] ?? {};
        setTrace((prev) => (prev.includes(node) ? prev : [...prev, node]));

        // 阶段 → 情绪（并行三链频繁切换时只保留最新一条提示）
        onStage?.(NODE_EMOJI[node] ?? EMOJI.BUSY, NODE_LABEL[node]);

        if (upd.profileResult) next.profileResult = upd.profileResult;
        if (upd.status) next.status = upd.status;
        if (upd.route) next.route = upd.route;
        if (upd.itinerary) next.itinerary = upd.itinerary;
        if (upd.budget) next.budget = upd.budget;
        if (upd.checks) next.checks = upd.checks;
        if (upd.cost) next.cost = upd.cost;
        if (upd.summary) next.summary = upd.summary;
        if (upd.sources) next.sources = { ...(next.sources ?? {}), ...upd.sources };
        if (Array.isArray(upd.errors) && upd.errors.length > 0) {
          next.errors = [...(next.errors ?? []), ...upd.errors];
        }
        setSnap({ ...next });
      }

      const pending = next.profileResult && !next.profileResult.ok;
      if (pending) {
        onStage?.(EMOJI.CONFUSED, '画像缺必填，先把问题问回去');
      } else {
        onStage?.(EMOJI.DONE, '三链齐了，质检也过了');
        moodTimer.current = window.setTimeout(() => onStage?.(EMOJI.HAPPY, null), 1600);
      }
    } catch (err) {
      console.error(err);
      onStage?.(EMOJI.ERROR, err instanceof Error ? err.message : '编排失败');
    } finally {
      setRunning(false);
    }
  }, [input, running, runtime, onStage]);

  const profile = snap.profileResult?.profile;
  const completeness = useMemo(
    () => (profile ? Math.round(profileCompleteness(profile) * 100) : 0),
    [profile],
  );
  const missing = snap.profileResult?.missing ?? [];

  

  return (
    <div className="tp">
      <section className="panel">
        <div className="tp-row">
          <h2>一句话需求</h2>
          <span className={`tp-badge ${degraded ? 'warn' : ''}`}>
            {degraded ? '规则兜底模式（无 Key）' : `LLM：${runtime.providerName}`}
          </span>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          placeholder="例如：一家三口去云南玩 5 天，预算 8000，想看自然风光"
          disabled={running}
        />
        <div className="tp-examples">
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex}
              className="tp-example"
              onClick={() => setInput(ex)}
              disabled={running}
            >
              {ex.length > 22 ? `${ex.slice(0, 22)}…` : ex}
            </button>
          ))}
        </div>
        <div className="actions">
          <span className="tenant-label">
            图：parse → dispatch → 三链并行 → arbitrate（LangGraph）
          </span>
          <button type="button" onClick={run} disabled={running || !input.trim()}>
            {running ? '编排中…' : '开始规划'}
          </button>
        </div>
      </section>

      {trace.length > 0 && (
        <section className="trace">
          {trace.map((n, i) => (
            <span
              key={`${n}-${i}`}
              className={`trace-step${i === trace.length - 1 ? ' active' : ''}${
                ['routeWorker', 'itineraryWorker', 'budgetWorker'].includes(n) ? ' parallel' : ''
              }`}
            >
              {i + 1}. {NODE_LABEL[n] ?? n}
            </span>
          ))}
        </section>
      )}

      {/* 画像 */}
      {profile && (
        <section className="panel">
          <div className="tp-row">
            <h2>① 画像契约 · TripProfile</h2>
            <span className="tp-meta">
              完整度 {completeness}%
              {snap.profileResult?.source === 'rule' && (
                <em className="tp-degraded">（规则兜底）</em>
              )}
              {snap.profileResult?.source === 'llm' && <em className="tp-ok">（LLM 抽取）</em>}
            </span>
          </div>
          <div className="tp-grid">
            <Field label="出发地" value={profile.origin || '—'} />
            <Field label="目的地" value={profile.destination || '—'} />
            <Field label="天数" value={profile.days > 0 ? `${profile.days} 天` : '—'} />
            <Field label="预算" value={profile.budget > 0 ? `¥${profile.budget}` : '—'} />
            <Field
              label="同行人"
              value={profile.companions.map((c) => COMPANION_LABELS[c]).join('、') || '—'}
            />
            <Field label="节奏" value={profile.preferences.pace} />
            <Field label="住宿档" value={profile.preferences.accommodationLevel} />
          </div>

          {missing.length > 0 && (
            <p className="tp-alert warn">{clarifyPrompt(missing)}</p>
          )}
          {(snap.profileResult?.conflicts.length ?? 0) > 0 && (
            <div className="tp-alert danger">
              <strong>入口拦下的冲突（第 4 段）</strong>
              <ul>
                {snap.profileResult!.conflicts.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          {snap.profileResult?.degradedReason && (
            <p className="tp-note">降级原因：{snap.profileResult.degradedReason}</p>
          )}
        </section>
      )}

      {/* 三子链 */}
      {(snap.route || snap.itinerary || snap.budget) && (
        <div className="tp-chains">
          <ChainCard title="② 路线子链" kind="route" source={snap.sources?.route} ready={!!snap.route}>
            {snap.route && (
              <>
                {snap.route.intercity && snap.route.intercity.length > 0 && (
                  <div className="tp-intercity">
                    <div className="tp-intercity-head">
                      往返大交通 · 合计 ¥
                      {snap.route.intercity.reduce((s, l) => s + l.totalCost, 0)}
                    </div>
                    <ul className="tp-list">
                      {snap.route.intercity.map((l) => (
                        <li key={l.direction}>
                          <b>{l.direction === 'outbound' ? '去程' : '返程'}</b> {l.from} → {l.to}
                          <span className="tp-sub">
                            {INTERCITY_MODE_LABEL[l.mode]} ·{' '}
                            {(l.estDurationMin / 60).toFixed(1)}h · ¥{l.unitCost}/人 · 本段 ¥
                            {l.totalCost}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {snap.route.entryNotes && snap.route.entryNotes.length > 0 && (
                  <div className="tp-entry">
                    <div className="tp-entry-head">出境手续 · 别忘了</div>
                    <ul className="tp-list">
                      {snap.route.entryNotes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <ul className="tp-list">
                  {snap.route.routes.map((r) => (
                    <li key={`${r.day}-${r.to}`}>
                      <b>D{r.day}</b> {r.origin ?? '—'} → {r.to}
                      <span className="tp-sub">
                        {TRANSPORT_LABEL[r.transport]} · {r.estDurationMin}min
                        {r.estCost != null ? ` · ¥${r.estCost}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </ChainCard>

          <ChainCard
            title="③ 行程子链"
            kind="itinerary"
            source={snap.sources?.itinerary}
            ready={!!snap.itinerary}
          >
            {snap.itinerary && (
              <ul className="tp-list">
                {snap.itinerary.planByDay.map((d) => {
                  // 只有景点有图，一天最多两张（卡片窄，多了挤成一片）
                  const shots = d.activities.filter((a) => a.imageUrl).slice(0, 2);
                  return (
                    <li key={d.day}>
                      {shots.length > 0 && (
                        <div className="tp-shots">
                          {shots.map((a) => (
                            <Thumb key={a.name} src={a.imageUrl!} alt={a.name} />
                          ))}
                        </div>
                      )}
                      <b>D{d.day}</b> {d.activities.map((a) => a.name).join(' / ')}
                      {d.note && <span className="tp-sub">{d.note}</span>}
                    </li>
                  );
                })}
              </ul>
            )}
          </ChainCard>

          <ChainCard title="④ 费用统筹" kind="budget" source={snap.sources?.budget} ready={!!snap.budget}>
            {snap.budget && (
              <>
                <div className="tp-budget">
                  {snap.budget.allocated.map((a) => (
                    <div className="tp-bar" key={a.category}>
                      <span className="tp-bar-label">{CATEGORY_LABEL[a.category]}</span>
                      <span className="tp-bar-track">
                        <span style={{ width: `${Math.min(a.percent, 100)}%` }} />
                      </span>
                      <span className="tp-bar-value">
                        ¥{a.amount} · {a.percent}%
                      </span>
                    </div>
                  ))}
                </div>
                <p className={`tp-alert ${snap.budget.overBudget ? 'danger' : 'ok'}`}>
                  总额 ¥{snap.budget.totalBudget} ·{' '}
                  {snap.budget.overBudget ? '超支，已给替换建议' : '估算未超预算'}
                </p>
                {(snap.budget.intercityCost ?? 0) > 0 && (
                  <p className="tp-note">
                    其中往返大交通 ¥{snap.budget.intercityCost}，占总预算{' '}
                    {Math.round(
                      ((snap.budget.intercityCost ?? 0) / Math.max(snap.budget.totalBudget, 1)) *
                        100,
                    )}
                    %（已从总额中先行切出，其余类目按剩余预算分摊）
                  </p>
                )}
                {snap.budget.suggestions.length > 0 && (
                  <ul className="tp-list">
                    {snap.budget.suggestions.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </ChainCard>
        </div>
      )}

      {/* 收口 */}
      {(snap.checks || snap.summary) && (
        <section className="panel">
          <h2>⑤ 收口质检 · 量化验证</h2>
          {snap.checks && (
            <ul className="tp-checks">
              {snap.checks.map((c) => (
                <li key={c.id} className={c.ok ? 'ok' : 'bad'}>
                  <span className="tp-check-mark">{c.ok ? '✓' : '✗'}</span>
                  <b>{c.label}</b>
                  <span className="tp-sub">{c.detail}</span>
                </li>
              ))}
            </ul>
          )}
          {snap.cost && (
            <div className="tp-cost">
              <span>token 合计 {snap.cost.totalTokens}</span>
              <span>估算成本 ${snap.cost.totalCostUsd.toFixed(4)}</span>
              {snap.cost.buckets.map((b) => (
                <span key={b.role} className="tp-chip">
                  {b.role} · {b.totalTokens}t · ${b.costUsd.toFixed(4)}
                </span>
              ))}
            </div>
          )}
          {snap.summary && <pre className="tp-summary">{snap.summary}</pre>}
          {snap.errors && snap.errors.length > 0 && (
            <div className="tp-alert warn">
              <strong>降级 / 异常记录</strong>
              <ul>
                {snap.errors.map((e, i) => (
                  <li key={`${e.kind}-${i}`}>
                    [{e.kind}] {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {!running && trace.length === 0 && (
        <p className="hint">
          点「开始规划」。三句示例分别对应：正常画像 / 缺必填（待澄清）/ 字段冲突（入口拦下）。
        </p>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="tp-field">
      <span className="tp-field-label">{label}</span>
      <span className="tp-field-value">{value}</span>
    </div>
  );
}

/**
 * 景点缩略图。
 *
 * 图是懒加载的，且**失败时退化成文字占位**而不是留白框：
 * 一是图源里确实有小景点查不到图，二是本地 `vite dev` 没有 /api/image，
 * 两种情况都不该让行程卡片出现一个个破图标。
 */
function Thumb({ src, alt }: { src: string; alt: string }) {
  // 0=首次加载 1=带 r=1 重试中 2=确实没有图
  const [phase, setPhase] = useState(0);
  if (phase === 2) {
    return (
      <span className="tp-thumb tp-thumb-empty" title={alt}>
        {alt.slice(0, 2)}
      </span>
    );
  }
  return (
    <span className="tp-thumb" title={alt}>
      <img
        // phase 变化要换 key 才会重新发起请求
        key={phase}
        src={phase === 0 ? src : `${src}&r=1`}
        alt={alt}
        loading="lazy"
        onError={() => {
          // 服务端可能刚回了「暂无图」的负缓存，隔一会儿带 r=1 再要一次；
          // 第二次还失败才认为是真的没有图。
          if (phase === 0) window.setTimeout(() => setPhase(1), 1500);
          else setPhase(2);
        }}
      />
    </span>
  );
}

function ChainCard({
  title,
  kind,
  source,
  ready,
  children,
}: {
  title: string;
  kind: string;
  source?: 'llm' | 'fallback';
  ready: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`panel tp-chain ${ready ? 'ready' : 'waiting'}`} data-kind={kind}>
      <div className="tp-row">
        <h2>{title}</h2>
        <span className={`tp-chip ${source === 'fallback' ? 'warn' : ''}`}>
          {source ? (source === 'llm' ? 'LLM 生成' : '规则兜底') : '等待中'}
        </span>
      </div>
      {children}
    </section>
  );
}

export default TravelPlannerPage;
