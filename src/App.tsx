import { useCallback, useRef, useState } from "react";
import { triageGraph } from "./graph/workflow";
import EmotionBallView from "./emotion/EmotionBallView";
import type { EmotionBallInstance } from "./emotion/emotionball.d";
import {
  EMOJI,
  acceptingTip,
  driveTriageNode,
  moodFromAnswer,
} from "./emotion/agentEmotion";
import "./App.css";

const NODE_LABEL: Record<string, string> = {
  getDate: "推断日期",
  extractLocation: "提取地点",
  locate: "自动定位",
  searchWeather: "查询天气",
  suggest: "出行建议",
  final: "生成播报",
};

interface Answer {
  reply?: string;
  date?: string;
  location?: string;
  weather?: string;
  advice?: string;
}

function App() {
  const [input, setInput] = useState("上海明天天气怎么样");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Answer | null>(null);
  const [emotion, setEmotion] = useState<string>(EMOJI.IDLE);
  const [tips, setTips] = useState<string | null>(null);
  const [trace, setTrace] = useState<string[]>([]);
  const ballRef = useRef<EmotionBallInstance | null>(null);
  const moodTimer = useRef<number | null>(null);

  const flash = (emo: string, tip?: string | null) => {
    setEmotion(emo);
    if (tip !== undefined) setTips(tip);
  };

  const run = useCallback(async () => {
    if (!input.trim() || running) return;
    if (moodTimer.current) window.clearTimeout(moodTimer.current);
    setRunning(true);
    setResult(null);
    setTrace([]);
    flash(EMOJI.ACCEPTING, acceptingTip(input));

    const answer: Answer = {};

    try {
      const stream = await triageGraph.stream(
        { input: input.trim() },
        { streamMode: "updates" },
      );

      for await (const step of stream as AsyncIterable<Record<string, any>>) {
        const node = Object.keys(step)[0];
        if (!node || node === "__end__") continue;
        const upd: Record<string, any> = step[node] ?? {};

        // 节点 → 表情 + 气泡（状态层）
        const st = driveTriageNode(node, upd);
        flash(st.emo, st.tip ?? null);
        setTrace((prev) => [...prev, node]);

        // 收集结构化结果
        if (node === "getDate" && typeof upd.date === "string") {
          answer.date = upd.date;
        } else if (
          (node === "extractLocation" || node === "locate") &&
          typeof upd.location === "string"
        ) {
          answer.location = upd.location;
        } else if (node === "searchWeather") {
          if (typeof upd.weather === "string") answer.weather = upd.weather;
        } else if (node === "suggest" && typeof upd.advice === "string") {
          answer.advice = upd.advice;
        } else if (node === "final" && typeof upd.reply === "string") {
          answer.reply = upd.reply;
        }
      }

      setResult({ ...answer });

      // —— 完成庆祝 → 情绪渲染 → 回待机 ——
      const shown = answer.reply || answer.weather || "处理完成";
      flash(EMOJI.DONE, answer.reply ? "天气播报完成 ✨" : "处理完成");
      const mood = moodFromAnswer(shown);
      moodTimer.current = window.setTimeout(() => {
        flash(mood, undefined);
        moodTimer.current = window.setTimeout(() => {
          flash(EMOJI.IDLE, null);
        }, 2400);
      }, 1500);
    } catch (error) {
      console.error(error);
      flash(EMOJI.ERROR, "出错了，请重试");
      moodTimer.current = window.setTimeout(() => {
        flash(EMOJI.IDLE, null);
      }, 2200);
    } finally {
      setRunning(false);
    }
  }, [input, running]);

  const hasResult =
    result && (result.reply || result.weather || result.advice);

  return (
    <main className="page">
      <header className="head">
        <div className="head-title">
          <h1>天气助手 · LangGraph Triage</h1>
          <p>
            意图分诊 → 工具调用 → 出行建议 · 左侧提问，右侧球球实时表达执行状态
          </p>
        </div>
        <EmotionBallView
          emotion={emotion}
          tips={tips}
          size={150}
          celebrateOn={[EMOJI.DONE]}
          onEngineReady={(ball) => {
            ballRef.current = ball;
          }}
        />
      </header>

      {trace.length > 0 && (
        <section className="trace">
          {trace.map((n, i) => (
            <span
              key={`${n}-${i}`}
              className={`trace-step${i === trace.length - 1 ? " active" : ""}`}
            >
              {i + 1}. {NODE_LABEL[n] ?? n}
            </span>
          ))}
        </section>
      )}

      <section className="panel">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder="例如：上海明天天气怎么样 / 北京后天适合爬山吗"
          disabled={running}
          className="input-area"
        />
        <div className="actions">
          <span className="tenant-label">
            试试：不带城市名会自动定位（需授权浏览器定位）
          </span>
          <button type="button" onClick={run} disabled={running || !input.trim()}>
            {running ? "运行中…" : "查询天气"}
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>天气播报</h2>
        {hasResult ? (
          <div className="result">
            {result.reply && <p className="answer-main">{result.reply}</p>}

            {(result.date || result.location) && (
              <div className="chips">
                {result.date && <span className="chip">📅 {result.date}</span>}
                {result.location && (
                  <span className="chip">📍 {result.location}</span>
                )}
              </div>
            )}

            {result.weather && result.weather !== result.reply && (
              <p className="weather-line">{result.weather}</p>
            )}

            {result.advice && (
              <div className="sources">
                <strong>出行建议</strong>
                <ul>
                  {result.advice
                    .split(/[；;]/)
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="hint">
            {running ? "球球正在处理，请稍候…" : "等待查询…"}
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
