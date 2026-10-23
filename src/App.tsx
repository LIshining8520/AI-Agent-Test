import { useCallback, useState } from "react";
import WeatherPage from "./pages/WeatherPage";
import TravelPlannerPage from "./travel/ui/TravelPlannerPage";
import EmotionBallView from "./emotion/EmotionBallView";
import { EMOJI } from "./emotion/agentEmotion";
import "./App.css";

type Tab = "travel" | "weather";

const TAB_META: Record<Tab, { title: string; desc: string }> = {
  travel: {
    title: "旅游多 Agent · 画像 × 三子链 × 收口",
    desc: "一句话需求 → TripProfile 画像 → 路线/行程/费用三链并行 → 收口质检",
  },
  weather: {
    title: "天气助手 · LangGraph Triage",
    desc: "意图分诊 → 工具调用 → 出行建议 · 左侧提问，右侧球球实时表达执行状态",
  },
};

function App() {
  const [tab, setTab] = useState<Tab>("travel");
  const [emotion, setEmotion] = useState<string>(EMOJI.IDLE);
  const [tips, setTips] = useState<string | null>(null);

  const flash = useCallback((emo: string, tip?: string | null) => {
    setEmotion(emo);
    if (tip !== undefined) setTips(tip);
  }, []);

  const switchTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setEmotion(EMOJI.IDLE);
    setTips(null);
  };

  const meta = TAB_META[tab];

  return (
    <main className="page">
      <header className="head">
        <div className="head-title">
          <h1>{meta.title}</h1>
          <p>{meta.desc}</p>
        </div>
        <EmotionBallView
          emotion={emotion}
          tips={tips}
          size={150}
          celebrateOn={[EMOJI.DONE]}
          /* 下方留白给气泡：气泡绝对定位在球体上方，不加会被副标题压住 */
          style={{ marginTop: 30, flex: "none" }}
        />
      </header>

      <nav className="tabs">
        <button
          type="button"
          className={`tab${tab === "travel" ? " active" : ""}`}
          onClick={() => switchTab("travel")}
        >
          旅游多 Agent
        </button>
        <button
          type="button"
          className={`tab${tab === "weather" ? " active" : ""}`}
          onClick={() => switchTab("weather")}
        >
          天气助手
        </button>
      </nav>

      {tab === "travel" ? <TravelPlannerPage onStage={flash} /> : <WeatherPage onStage={flash} />}
    </main>
  );
}

export default App;
