import { useCallback, useState } from "react";
import { triageGraph } from "./graph/workflow";
import "./App.css";

function App() {
  const [input, setInput] = useState("页面一打开就报 Internal Server Error，完全用不了");
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
          placeholder="例如：App 每次启动都会崩溃"
          disabled={running}
          className="input-area"
        />
        <button type="button" onClick={run} disabled={running || !input.trim()}>
          {running ? "运行中…" : "运行工作流"}
        </button>
      </section>


      <section className="panel">
        <h2>让菲菲来告诉你</h2>
        {finalState ? (
          <pre>
         亲爱的主人： {finalState.date}的天气是{finalState.weather}
          </pre>
        ) : (
          <p className="hint">等待运行结果…</p>
        )}
      </section>
    </main>
  );
}

export default App;
