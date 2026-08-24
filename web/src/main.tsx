import { useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import mermaid from "mermaid";
import { demoEvents, demoReport, demoRetrieval } from "./demo";
import type {
  AnalysisAccepted,
  AnalysisStatus,
  BrowseResponse,
  DirectoryEntry,
  Finding,
  LocateMatch,
  LocateResponse,
  Narration,
  ProgressEvent,
  Report,
  RetrievalResult,
  RootsResponse,
  RunSummary,
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

/**
 * File System Access API。
 *
 * 相比 `<input webkitdirectory>`，它是惰性的——只拿目录句柄，不枚举内容。
 * 前端项目的 node_modules 动辄十几万文件，webkitdirectory 会直接把页面卡死。
 * 代价是仍然拿不到绝对路径，需要后端按目录名反查。
 */
interface FileEntryHandle {
  kind: "file" | "directory";
  getFile?: () => Promise<{ text: () => Promise<string> }>;
}

interface DirectoryHandle {
  name: string;
  entries: () => AsyncIterableIterator<[string, FileEntryHandle]>;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>;
};

/** 顶层条目数量上限；正常项目远不到这个量级 */
const FINGERPRINT_LIMIT = 200;

/**
 * 采集目录特征交给后端反查。
 *
 * 只发目录名是不够的——开发机上同名目录很常见（monorepo 的 apps/x、
 * 另一个仓库的 pages/x…），而它们的顶层结构还高度雷同。
 * package.json 的完整内容哈希判别力强得多：同名项目的依赖与版本号
 * 几乎不可能逐字节一致。
 */
async function collectFingerprint(handle: DirectoryHandle) {
  const entries: string[] = [];
  let packageJson = "";

  for await (const [name, child] of handle.entries()) {
    entries.push(name);

    if (name === "package.json" && child.kind === "file" && child.getFile) {
      try {
        packageJson = await (await child.getFile()).text();
      } catch {
        // 读不到就退化为只用结构相似度
      }
    }

    if (entries.length >= FINGERPRINT_LIMIT) break;
  }

  return {
    entries,
    packageHash: packageJson ? await sha256(packageJson) : undefined,
    packageName: packageJson ? safeParseName(packageJson) : undefined,
  };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeParseName(json: string): string | undefined {
  try {
    const parsed = JSON.parse(json) as { name?: string };
    return typeof parsed.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [matches, setMatches] = useState<LocateMatch[]>([]);
  const [locating, setLocating] = useState(false);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [notice, setNotice] = useState("当前展示 Demo 数据，可连接本地 API 分析真实仓库");

  // 路径变化时查一下该仓库是否已有分析记录（含命令行跑出来的）
  useEffect(() => {
    let active = true;
    fetch(`/repo/runs?root=${encodeURIComponent(root)}`)
      .then((response) => (response.ok ? response.json() : { runs: [] }))
      .then((data: { runs?: RunSummary[] }) => {
        if (active) setHistory(data.runs ?? []);
      })
      .catch(() => {
        if (active) setHistory([]);
      });
    return () => {
      active = false;
    };
  }, [root]);

  /**
   * 打开系统原生目录选择器，再让后端把目录名反查成绝对路径。
   *
   * 浏览器不会给出绝对路径，但后端就在同一台机器上；把目录名与顶层条目
   * 发过去定位即可。同名目录有多个时展示候选，定位不到就退回服务端浏览器。
   */
  const pickDirectory = async () => {
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) {
      setPickerOpen(true);
      return;
    }

    let handle: DirectoryHandle;
    try {
      handle = await picker({ mode: "read" });
    } catch {
      // 用户取消，或浏览器拒绝（非安全上下文），都不需要额外提示
      return;
    }

    setMatches([]);
    setLocating(true);
    try {
      const fingerprint = await collectFingerprint(handle);

      const response = await fetch("/fs/locate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: handle.name, ...fingerprint }),
      });
      if (!response.ok) throw new Error(`${response.status}`);

      const { matches: found, confident } = (await response.json()) as LocateResponse;

      // 判据足够强就直接采用，不必让用户在一堆同名目录里再挑一次
      if (found.length > 0 && confident) {
        setRoot(found[0].path);
        setNotice(
          found[0].exact
            ? `已选择 ${found[0].path}`
            : `已选择 ${found[0].path}（按目录特征匹配）`,
        );
        return;
      }

      if (found.length > 1) {
        setMatches(found);
        setNotice(
          `本机有 ${found.length} 个同名目录且特征相近，浏览器不提供绝对路径，请确认是哪一个`,
        );
        return;
      }

      setNotice(`未能定位「${handle.name}」的绝对路径，请手动浏览选择`);
      setPickerOpen(true);
    } catch (error) {
      setNotice(`目录定位失败：${describeError(error)}，请手动浏览选择`);
      setPickerOpen(true);
    } finally {
      setLocating(false);
    }
  };

  /** 加载该仓库最近一次分析结果——包括 pnpm analyze 在命令行跑出来的 */
  const loadLatest = async () => {
    setNotice("正在读取历史分析结果…");
    try {
      const response = await fetch(`/repo/runs/latest?root=${encodeURIComponent(root)}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const data = (await response.json()) as { report: Report };
      setIsDemo(false);
      setReport(data.report);
      setResults([]);
      setEvents([]);
      setNotice(`已加载历史分析结果 · ${new Date(data.report.generatedAt).toLocaleString()}`);
    } catch (error) {
      setNotice(`读取历史结果失败：${describeError(error)}`);
    }
  };

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
            <div className="path-input">
              <input
                value={root}
                onChange={(event) => {
                  setRoot(event.target.value);
                  setMatches([]);
                }}
                placeholder="/path/to/your-project"
              />
              <button
                type="button"
                className="browse-button"
                onClick={pickDirectory}
                disabled={locating}
              >
                {locating ? "定位中…" : "选择目录…"}
              </button>
            </div>

            {matches.length > 0 && (
              <div className="locate-matches">
                <span className="locate-hint">
                  按目录特征匹配度排序，请选择你刚才选中的那个：
                </span>
                {matches.map((match) => (
                  <button
                    key={match.path}
                    type="button"
                    className="locate-match"
                    onClick={() => {
                      setRoot(match.path);
                      setMatches([]);
                      setNotice(`已选择 ${match.path}`);
                    }}
                  >
                    <code>{match.path}</code>
                    {match.exact && <span className="picker-tag exact">内容一致</span>}
                    {match.isRepo && <span className="picker-tag repo">package.json</span>}
                    {match.analyzed && <span className="picker-tag analyzed">已分析</span>}
                  </button>
                ))}
              </div>
            )}
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

        <p className={`notice ${isDemo ? "demo" : ""}`}>
          <span>{isDemo ? "⚠" : "✦"}</span>
          {isDemo && <b className="demo-badge">DEMO 数据</b>}
          {notice}
        </p>

        {history.length > 0 && (
          <p className="notice history-notice">
            <span>◷</span>
            该仓库有 {history.length} 次历史分析记录，最近一次{" "}
            {new Date(history[0].generatedAt).toLocaleString()}
            {history[0].score !== null && ` · 评分 ${history[0].score}`}
            {` · ${history[0].files} 个文件`}
            <button type="button" className="link-button" onClick={loadLatest}>
              加载最近一次结果
            </button>
          </p>
        )}

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

      {pickerOpen && (
        <DirectoryPicker
          initialPath={root}
          onCancel={() => setPickerOpen(false)}
          onSelect={(selected) => {
            setRoot(selected);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * 目录选择器。
 *
 * 浏览器拿不到本地目录的绝对路径（`webkitdirectory` 只给相对路径，
 * File System Access API 只给句柄），而后端需要的恰恰是绝对路径，
 * 所以目录树由本地 API 提供，这里只负责导航与选择。
 */
function DirectoryPicker({
  initialPath,
  onSelect,
  onCancel,
}: {
  initialPath: string;
  onSelect: (path: string) => void;
  onCancel: () => void;
}) {
  const [listing, setListing] = useState<BrowseResponse | undefined>();
  const [roots, setRoots] = useState<RootsResponse["roots"]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);

  const browse = async (target?: string) => {
    setPending(true);
    setError("");
    try {
      const url = target ? `/fs/browse?path=${encodeURIComponent(target)}` : "/fs/browse";
      const response = await fetch(url);
      if (!response.ok) {
        const detail = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `${response.status}`);
      }
      setListing((await response.json()) as BrowseResponse);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPending(false);
    }
  };

  useEffect(() => {
    void browse(initialPath);
    fetch("/fs/roots")
      .then((response) => (response.ok ? response.json() : { roots: [] }))
      .then((data: RootsResponse) => setRoots(data.roots ?? []))
      .catch(() => setRoots([]));
    // 只在打开时初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="picker-backdrop" onClick={onCancel}>
      <div className="picker" onClick={(event) => event.stopPropagation()}>
        <header className="picker-header">
          <h3>选择仓库目录</h3>
          <button type="button" className="picker-close" onClick={onCancel}>
            ✕
          </button>
        </header>

        <div className="picker-shortcuts">
          {roots.map((item) => (
            <button key={item.path} type="button" onClick={() => void browse(item.path)}>
              {item.label}
            </button>
          ))}
        </div>

        <div className="picker-path">
          <button
            type="button"
            className="picker-up"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void browse(listing.parent)}
          >
            ↑ 上级
          </button>
          <code>{listing?.path ?? "…"}</code>
        </div>

        <div className="picker-list">
          {error && <div className="picker-error">{error}</div>}
          {pending && !error && <Empty text="读取中…" />}
          {!pending && !error && listing?.entries.length === 0 && <Empty text="该目录下没有子目录" />}
          {!pending &&
            !error &&
            listing?.entries.map((entry) => (
              <DirectoryRow key={entry.path} entry={entry} onOpen={() => void browse(entry.path)} />
            ))}
        </div>

        <footer className="picker-footer">
          <div className="picker-hint">
            {listing?.isRepo ? "当前目录含 package.json" : "当前目录没有 package.json"}
            {listing?.analyzed && " · 已有分析记录"}
          </div>
          <div className="picker-actions">
            <button type="button" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!listing}
              onClick={() => listing && onSelect(listing.path)}
            >
              选择此目录
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function DirectoryRow({ entry, onOpen }: { entry: DirectoryEntry; onOpen: () => void }) {
  return (
    <button type="button" className="picker-row" onClick={onOpen}>
      <span className="picker-icon">{entry.isRepo ? "◆" : "▸"}</span>
      <span className="picker-name">{entry.name}</span>
      {entry.isRepo && <span className="picker-tag repo">package.json</span>}
      {entry.analyzed && <span className="picker-tag analyzed">已分析</span>}
    </button>
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
  const [error, setError] = useState("");
  const id = useId().replace(/:/g, "");

  useEffect(() => {
    let active = true;
    setError("");

    if (!source.trim() || source.trim() === "graph TD") {
      setSvg("");
      setError("本次分析没有产出架构图");
      return;
    }

    mermaid
      .render(`architecture-${id}`, source)
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch((caught) => {
        if (!active) return;
        setSvg("");
        // 渲染失败时把原因和源码一起给出来，否则无从排查
        setError(describeError(caught));
      });

    return () => {
      active = false;
    };
  }, [source, id]);

  if (error) {
    return (
      <div className="mermaid-fallback">
        <p>架构图渲染失败：{error}</p>
        <details>
          <summary>查看图源码</summary>
          <pre>{source}</pre>
        </details>
      </div>
    );
  }

  return <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />;
}

createRoot(document.getElementById("root")!).render(<App />);
