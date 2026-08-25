import { useCallback, useState } from "react";
import { buildGraph } from "./graph/agent";
import "./App.css";

const ragBot = buildGraph();

function App() {
  const [input, setInput] = useState("员工年假多少天");
  const [tenantId, setTenantId] = useState("hr");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  const run = useCallback(async () => {
    if (!input.trim() || running) return;
    setRunning(true);
    setResult(null);

    try {
      const out = await ragBot.invoke({
        query: input.trim(),
        tenantId,
        messages: [],
      });
      setResult(out);
    } finally {
      setRunning(false);
    }
  }, [input, running, tenantId]);

  return (
    <main className="page">
      <header>
        <h1>RAG 知识库问答助手</h1>
        <p>基于 lesson6 RAG 工作流，选择部门后提问，返回带来源的答案。</p>
      </header>

      <section className="panel">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          rows={3}
          placeholder="例如：员工年假多少天 / 费用报销流程是什么"
          disabled={running}
          className="input-area"
        />
        <label className="tenant-label">
          部门：
          <select
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
            disabled={running}
          >
            <option value="hr">人事（HR）</option>
            <option value="it">IT</option>
            <option value="finance">财务</option>
          </select>
        </label>
        <button type="button" onClick={run} disabled={running || !input.trim()}>
          {running ? "运行中…" : "提问"}
        </button>
      </section>

      <section className="panel">
        <h2>回答</h2>
        {result ? (
          <div className="result">
            <p>{result.finalAnswer}</p>
            {result.citations?.length ? (
              <div className="sources">
                <strong>来源（{result.citations.length} 条）</strong>
                <ul>
                  {result.citations.map((c: any, i: number) => (
                    <li key={i}>{c.text}</li>
                  ))}
                </ul>
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
