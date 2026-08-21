import { useCallback, useState } from "react";
import { triageGraph } from "./graph/workflow";
import "./App.css";

function App() {
  const [input, setInput] = useState("今天天气怎么样");
  const [running, setRunning] = useState(false);
  const [finalState, setFinalState] = useState<any>(null);
  const run = useCallback(async () => {
    if (!input.trim() || running) return;
    setRunning(true);
    setFinalState(null);

    try {
      const result = await triageGraph.invoke({ input: input.trim() });
      setFinalState(result);
    } finally {
      setRunning(false);
    }
  }, [input, running]);
console.log(finalState,'finalState>');

  return (
    <main className="page">
      <header>
        <h1>菲菲天气小助手</h1>
     
      </header>

      <section className="panel">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder="例如：今天天气怎么样；不输入城市时自动使用你的定位"
          disabled={running}
          className="input-area"
        />
        <button type="button" onClick={run} disabled={running || !input.trim()}>
          {running ? "运行中…" : "查询天气"}
        </button>
      </section>


      <section className="panel">
        <h2>亲爱的主人</h2>
        {finalState ? (
          <div className="result">
            {finalState.weather}
            {finalState.advice ? (
              <div className="advice">
                <strong>出行建议</strong>
                <p>{finalState.advice}</p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="hint">等待运行结果…</p>
        )}
      </section>
    </main>
  );
}

export default App;
