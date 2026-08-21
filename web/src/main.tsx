import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import mermaid from "mermaid";
import { demoEvents, demoReport, demoRetrieval } from "./demo";
import type {
  AnalysisAccepted,
  AnalysisStatus,
  Finding,
  Narration,
  ProgressEvent,
  Report,
  RetrievalResult,
} from "./types";
import "./styles.css";
import "./panels.css";

mermaid.initialize({
  startOnLoad: false,
  theme: "base",
  themeVariables: {
    primaryColor: "#e7f3ff",
    primaryTextColor: "#10233f",
    lineColor: "#7da4c8",
    fontFamily: "Inter, system-ui, sans-serif",
  },
});

const NODE_LABELS: Record<string, string> = {
  loadRepository: "加载仓库",
  scanFiles: "扫描文件",
  detectStack: "识别技术栈",
  parseSemantic: "AST 语义解析",
  analyzeArchitecture: "架构逆向",
  dependency: "循环依赖检测",
  quality: "质量指标",
  frontend: "前端专项检查",
  retrieveContext: "语义检索",
  narrate: "架构解读 (LLM)",
  render: "生成报告",
};

const SEVERITY_LABELS: Record<Finding["severity"], string> = {
  error: "高",
  warning: "中",
  info: "低",
};

const DIMENSION_LABELS: Record<string, string> = {
  complexity: "复杂度",
  coupling: "耦合度",
  typing: "类型质量",
};

function App() {
  const [root, setRoot] = useState("/workspace/demo-shop");
  const [query, setQuery] = useState("找所有处理用户登录的组件");
  const [report, setReport] = useState<Report | undefined>(demoReport);
  const [results, setResults] = useState<RetrievalResult[]>(demoRetrieval);
  const [events, setEvents] = useState<ProgressEvent[]>(demoEvents);
  const [loading, setLoading] = useState(false);
  const [isDemo, setIsDemo] = useState(true);
  const [notice, setNotice] = useState("当前展示 Demo 数据，可连接本地 API 分析真实仓库");

  /**
   * 只在「从未拿到过真实数据」时回退演示数据。
   *
   * 否则会出现最糟糕的组合：真实的失败提示配上一份伪造的健康报告，
   * 用户完全无法分辨屏幕上哪些数字是真的。
   */
  const fallback = (message: string) => {
    setNotice(message);
    setLoading(false);
    if (!isDemo) return;
    setReport(demoReport);
    setResults(demoRetrieval);
    setEvents(demoEvents);
  };

  const applyStatus = (status: AnalysisStatus) => {
    setIsDemo(false);
    setReport(status.report);
    setResults(status.retrieval ?? []);
    if (status.events.length) setEvents(status.events);
    setNotice(
      status.status === "failed"
        ? `分析失败：${status.error ?? "未知错误"}`
        : `分析完成 · 耗时 ${elapsedOf(status)}`,
    );
    setLoading(false);
  };

  /**
   * 提交任务后立即返回，进度通过 SSE 逐节点推送。
   * 此前是同步等待整个分析完成，稍大的仓库必然请求超时。
   */
  const startAnalysis = async () => {
    setLoading(true);
    setEvents([]);
    setNotice("提交分析任务…");

    let accepted: AnalysisAccepted;
    try {
      const response = await fetch("/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root, query }),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}) as { error?: string });
        throw new Error(detail.error ?? `API ${response.status}`);
      }
      accepted = (await response.json()) as AnalysisAccepted;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      fallback(
        isDemo
          ? `提交失败（${reason}），已切换为 Demo 数据。启动 pnpm api 后可分析真实仓库`
          : `提交失败：${reason}`,
      );
      return;
    }

    setNotice("LangGraph 正在分析仓库…");
    subscribeProgress(accepted, {
      onEvent: (event) => setEvents((previous) => [...previous, event]),
      onFinish: async () => {
        try {
          const response = await fetch(accepted.statusUrl);
          if (!response.ok) throw new Error(`状态查询失败 ${response.status}`);
          applyStatus((await response.json()) as AnalysisStatus);
        } catch (error) {
          fallback(`分析已结束，但拉取结果失败：${describeError(error)}`);
        }
      },
      // 后端支持断线重放，因此这里只提示，不丢弃已经拿到的真实进度
      onError: () => {
        setLoading(false);
        setNotice("进度连接中断，分析可能仍在后台运行，可刷新后重新查询");
      },
    });
  };

  const riskCount = useMemo(
    () => report?.findings.filter((item) => item.severity !== "info").length ?? 0,
    [report],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RS</span>
          <div>
            <strong>Repo Surgeon</strong>
            <small>智能代码仓库分析 Agent</small>
          </div>
        </div>
        <div className="status-dot">
          <i /> LangGraph workflow ready
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <p className="eyebrow">CODEBASE INTELLIGENCE / MVP</p>
            <h1>
              看懂一个仓库，<em>从结构开始。</em>
            </h1>
            <p className="hero-copy">
              用语义图、确定性分析和 LLM 检索，把复杂前端仓库变成可解释的架构地图。
            </p>
          </div>
          <div className="hero-orbit">
            <span>AST</span>
            <span>GRAPH</span>
            <span>AI</span>
            <b>◎</b>
          </div>
        </section>

        <section className="control-panel">
          <div className="field">
            <label>仓库路径</label>
            <input
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="/path/to/your-project"
            />
          </div>
          <div className="field query-field">
            <label>
              分析问题 <span>可选</span>
            </label>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="例如：找所有处理用户登录的组件"
            />
          </div>
          <button className="primary-button" onClick={startAnalysis} disabled={loading}>
            {loading ? "分析中…" : "开始分析 →"}
          </button>
        </section>

        <p className="notice">
          <span>✦</span> {notice}
        </p>

        <section className="content-grid">
          <div className="main-column">
            <Panel title="执行进度" subtitle="LangGraph 节点级事件流" action={progressLabel(events)}>
              <ProgressTimeline events={events} running={loading} />
            </Panel>
          </div>
        </section>

        {!report && (
          <p className="notice">
            <span>✦</span> 本次没有产出报告，上方进度中可以看到中断的节点
          </p>
        )}

        {report && (
        <>
        <section className="summary-grid">
          <Metric
            label="维护性评分"
            value={report.metrics.score}
            suffix="/100"
            tone="blue"
            detail="综合复杂度、耦合度与类型质量"
          />
          <Metric
            label="技术栈置信度"
            value={Math.round(report.stack.confidence * 100)}
            suffix="%"
            tone="green"
            detail={`${report.stack.framework ?? "Unknown"} · ${report.stack.buildTool ?? "Unknown"}`}
          />
          <Metric
            label="风险发现"
            value={riskCount}
            suffix="项"
            tone="orange"
            detail={`${report.files.length} 个文件已扫描`}
          />
          <Metric
            label="关系节点"
            value={report.symbols.length}
            suffix="个"
            tone="purple"
            detail={`${report.edges.length} 条关系边`}
          />
        </section>

        <section className="content-grid">
          <div className="main-column">
            <Panel
              title="架构解读"
              subtitle="由 LLM 基于确定性事实生成"
              action={report.narration ? "LLM" : "未启用"}
            >
              <NarrationView narration={report.narration} />
            </Panel>
            <Panel title="架构逆向解析" subtitle="目录分层与模块依赖关系" action="Mermaid">
              <MermaidChart source={report.mermaid} />
            </Panel>
            <Panel
              title="语义检索结果"
              subtitle={`Query · ${query}`}
              action={`${results.length} 个结果`}
            >
              <div className="result-list">
                {results.length ? (
                  results.map((item, index) => (
                    <SearchResult key={`${item.path}-${index}`} item={item} />
                  ))
                ) : (
                  <Empty text="没有找到相关代码" />
                )}
              </div>
            </Panel>
          </div>

          <aside className="side-column">
            <StackCard report={report} />
            <Panel title="风险发现" subtitle="按优先级排序">
              <div className="finding-list">
                {report.findings.length ? (
                  report.findings.map((item, index) => (
                    <FindingRow key={`${item.rule}-${index}`} finding={item} />
                  ))
                ) : (
                  <Empty text="暂无风险发现" />
                )}
              </div>
            </Panel>
            <Panel title="健康度维度">
              <div className="health-list">
                {Object.keys(report.metrics.dimensions).length ? (
                  Object.entries(report.metrics.dimensions).map(([key, value]) => (
                    <HealthBar key={key} label={DIMENSION_LABELS[key] ?? key} value={value} />
                  ))
                ) : (
                  <Empty text="没有可分析的源码文件" />
                )}
              </div>
            </Panel>
          </aside>
        </section>
        </>
        )}
      </main>

      <footer>
        <span>Repo Surgeon / Frontend Analysis Agent</span>
        <span>Deterministic facts · Explainable results</span>
      </footer>
    </div>
  );
}

interface ProgressHandlers {
  onEvent: (event: ProgressEvent) => void;
  onFinish: () => void;
  onError: () => void;
}

/** 订阅 SSE 进度流；后端会先回放已发生的事件，因此接入时机不影响完整性 */
function subscribeProgress(accepted: AnalysisAccepted, handlers: ProgressHandlers): void {
  const source = new EventSource(accepted.eventsUrl);
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    source.close();
    handlers.onFinish();
  };

  source.addEventListener("progress", (message) => {
    handlers.onEvent(JSON.parse((message as MessageEvent).data) as ProgressEvent);
  });

  // 服务端无论任务是否已结束，都统一以 done 收尾并关闭流
  source.addEventListener("done", finish);

  source.onerror = () => {
    if (settled) return;
    settled = true;
    source.close();
    handlers.onError();
  };
}

interface TimelineStep {
  node: string;
  status: "running" | "done" | "error";
  durationMs?: number;
  detail?: string;
}

/** 把 start / end 事件合并成每个节点一行 */
function buildSteps(events: ProgressEvent[]): TimelineStep[] {
  const steps = new Map<string, TimelineStep>();

  for (const event of events) {
    const step = steps.get(event.node) ?? { node: event.node, status: "running" };

    if (event.phase === "end") {
      step.status = "done";
      step.durationMs = event.durationMs;
      step.detail = event.detail;
    } else if (event.phase === "error") {
      step.status = "error";
      step.durationMs = event.durationMs;
      step.detail = event.detail;
    }

    steps.set(event.node, step);
  }

  return [...steps.values()];
}

const TOTAL_NODES = Object.keys(NODE_LABELS).length;

function progressLabel(events: ProgressEvent[]): string {
  const steps = buildSteps(events);
  const done = steps.filter((step) => step.status !== "running").length;
  // 分母必须是全部节点数：用「已出现过的节点数」会在跑完第一个节点时显示 1/1
  return `${done}/${TOTAL_NODES} 节点`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedOf(status: AnalysisStatus): string {
  if (!status.finishedAt) return "—";
  const ms = new Date(status.finishedAt).getTime() - new Date(status.startedAt).getTime();
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function ProgressTimeline({ events, running }: { events: ProgressEvent[]; running: boolean }) {
  const steps = buildSteps(events);
  if (!steps.length) {
    return <Empty text={running ? "等待第一个节点开始…" : "尚未运行"} />;
  }

  return (
    <div className="timeline">
      {steps.map((step) => (
        <div key={step.node} className={`timeline-row ${step.status}`}>
          <span className="timeline-mark" />
          <div className="timeline-body">
            <strong>{NODE_LABELS[step.node] ?? step.node}</strong>
            {step.detail && <small>{step.detail}</small>}
          </div>
          <span className="timeline-duration">
            {step.durationMs === undefined ? "运行中" : formatDuration(step.durationMs)}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function NarrationView({ narration }: { narration?: Narration }) {
  if (!narration) {
    return <Empty text="未配置模型，本次仅输出确定性分析结果" />;
  }

  return (
    <div className="narration">
      <p className="narration-summary">{narration.summary}</p>

      <div className="narration-layers">
        {narration.layering.map((item) => (
          <div key={item.layer} className="narration-layer">
            <b>{item.layer}</b>
            <span>{item.role}</span>
          </div>
        ))}
      </div>

      <div className="narration-risks">
        {narration.risks.map((risk) => (
          <article key={risk.title} className={`narration-risk ${risk.severity}`}>
            <header>
              <strong>{risk.title}</strong>
              <span className={`risk-tag ${risk.severity}`}>{risk.severity}</span>
            </header>
            <p className="risk-rationale">{risk.rationale}</p>
            <p className="risk-suggestion">建议：{risk.suggestion}</p>
            {risk.relatedPaths.length > 0 && <code>{risk.relatedPaths.join(" · ")}</code>}
          </article>
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  suffix,
  tone,
  detail,
}: {
  label: string;
  value: number;
  suffix: string;
  tone: string;
  detail: string;
}) {
  return (
    <article className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>
        {value}
        <small>{suffix}</small>
      </strong>
      <p>{detail}</p>
    </article>
  );
}

function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action && <span className="panel-action">{action}</span>}
      </div>
      {children}
    </section>
  );
}

function StackCard({ report }: { report: Report }) {
  return (
    <section className="stack-card">
      <div className="panel-heading">
        <div>
          <h2>技术栈识别</h2>
          <p>基于依赖与源码证据</p>
        </div>
        <span className="confidence">{Math.round(report.stack.confidence * 100)}%</span>
      </div>
      <div className="stack-primary">
        <strong>{report.stack.framework ?? "Unknown"}</strong>
        <span>{report.stack.frameworkVersion ?? ""}</span>
      </div>
      <div className="stack-tags">
        {[report.stack.buildTool, ...report.stack.stateManagement, report.stack.router]
          .filter(Boolean)
          .map((item) => (
            <span key={item}>{item}</span>
          ))}
      </div>
      <div className="evidence">
        <b>识别证据</b>
        {report.stack.evidence.map((item) => (
          <span key={item}>✓ {item}</span>
        ))}
      </div>
    </section>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className="finding-row">
      <span className={`severity ${finding.severity}`} />
      <div>
        <strong>{finding.message}</strong>
        <small>{finding.files.join(" · ")}</small>
      </div>
      <span className={`severity-label ${finding.severity}`}>
        {SEVERITY_LABELS[finding.severity]}
      </span>
    </div>
  );
}

function SearchResult({ item }: { item: RetrievalResult }) {
  return (
    <div className="search-result">
      <div className="result-score">
        {item.score}
        <small>score</small>
      </div>
      <div>
        <strong>{item.symbol ?? item.path.split("/").pop()}</strong>
        <code>{item.path}</code>
        <div className="reason-list">
          {item.reasons.map((reason, index) => (
            <span key={`${reason}-${index}`}>{reason}</span>
          ))}
        </div>
        {item.relatedPaths.length > 0 && (
          <small className="related">关联：{item.relatedPaths.join(" · ")}</small>
        )}
      </div>
    </div>
  );
}

function HealthBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="health-item">
      <div>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className="bar">
        <i style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function MermaidChart({ source }: { source: string }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let active = true;
    mermaid
      .render(`architecture-${Date.now()}`, source)
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch(() => setSvg("<p>Mermaid 图解析失败</p>"));
    return () => {
      active = false;
    };
  }, [source]);

  return <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />;
}

createRoot(document.getElementById("root")!).render(<App />);
