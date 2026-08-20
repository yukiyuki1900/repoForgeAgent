import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import mermaid from "mermaid";
import { demoReport, demoRetrieval } from "./demo";
import type { AnalysisResponse, Finding, Report, RetrievalResult } from "./types";
import "./styles.css";

mermaid.initialize({ startOnLoad: false, theme: "base", themeVariables: { primaryColor: "#e7f3ff", primaryTextColor: "#10233f", lineColor: "#7da4c8", fontFamily: "Inter, system-ui, sans-serif" } });

function App() {
  const [root, setRoot] = useState("/workspace/demo-shop");
  const [query, setQuery] = useState("找所有处理用户登录的组件");
  const [report, setReport] = useState<Report>(demoReport);
  const [results, setResults] = useState<RetrievalResult[]>(demoRetrieval);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("当前展示 Demo 数据，可连接本地 API 分析真实仓库");

  const runAnalysis = async () => {
    setLoading(true); setNotice("LangGraph 正在分析仓库…");
    try {
      const response = await fetch("/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ root, query }) });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const data = await response.json() as AnalysisResponse;
      setReport(data.report); setResults(data.retrieval ?? []); setNotice(`分析完成 · ${data.currentStep}`);
    } catch {
      setNotice("本地 API 未连接，已切换为 Demo 数据。启动 pnpm api 后可分析真实仓库"); setReport(demoReport); setResults(demoRetrieval);
    } finally { setLoading(false); }
  };

  const riskCount = useMemo(() => report.findings.filter(item => item.severity !== "info").length, [report]);
  return <div className="shell">
    <header className="topbar"><div className="brand"><span className="brand-mark">RS</span><div><strong>Repo Surgeon</strong><small>智能代码仓库分析 Agent</small></div></div><div className="status-dot"><i /> LangGraph workflow ready</div></header>
    <main>
      <section className="hero"><div><p className="eyebrow">CODEBASE INTELLIGENCE / MVP</p><h1>看懂一个仓库，<em>从结构开始。</em></h1><p className="hero-copy">用语义图、确定性分析和 LLM 检索，把复杂前端仓库变成可解释的架构地图。</p></div><div className="hero-orbit"><span>AST</span><span>GRAPH</span><span>AI</span><b>◎</b></div></section>
      <section className="control-panel"><div className="field"><label>仓库路径</label><input value={root} onChange={event => setRoot(event.target.value)} placeholder="/path/to/your-project" /></div><div className="field query-field"><label>分析问题 <span>可选</span></label><input value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：找所有处理用户登录的组件" /></div><button className="primary-button" onClick={runAnalysis} disabled={loading}>{loading ? "分析中…" : "开始分析 →"}</button></section>
      <p className="notice"><span>✦</span> {notice}</p>
      <section className="summary-grid"><Metric label="维护性评分" value={report.metrics.score} suffix="/100" tone="blue" detail="综合复杂度、耦合度与类型质量" /><Metric label="技术栈置信度" value={Math.round(report.stack.confidence * 100)} suffix="%" tone="green" detail={`${report.stack.framework ?? "Unknown"} · ${report.stack.buildTool ?? "Unknown"}`} /><Metric label="风险发现" value={riskCount} suffix="项" tone="orange" detail={`${report.files.length} 个文件已扫描`} /><Metric label="关系节点" value={report.symbols.length} suffix="个" tone="purple" detail={`${report.edges.length} 条依赖边`} /></section>
      <section className="content-grid"><div className="main-column"><Panel title="架构逆向解析" subtitle="目录分层与模块依赖关系" action="Mermaid"><MermaidChart source={report.mermaid} /></Panel><Panel title="语义检索结果" subtitle={`Query · ${query}`} action={`${results.length} 个结果`}><div className="result-list">{results.length ? results.map((item, index) => <SearchResult key={`${item.path}-${index}`} item={item} />) : <Empty text="没有找到相关代码" />}</div></Panel></div><aside className="side-column"><StackCard report={report} /><Panel title="风险发现" subtitle="按优先级排序"><div className="finding-list">{report.findings.length ? report.findings.map((item, index) => <FindingRow key={`${item.rule}-${index}`} finding={item} />) : <Empty text="暂无风险发现" />}</div></Panel><Panel title="健康度维度"><div className="health-list">{Object.entries(report.metrics.dimensions).map(([key, value]) => <HealthBar key={key} label={dimensionLabel[key] ?? key} value={value} />)}</div></Panel></aside></section>
    </main><footer><span>Repo Surgeon / Frontend Analysis Agent</span><span>Deterministic facts · Explainable results</span></footer>
  </div>;
}

// 仅列出 calculateMetrics 真实计算的维度；未实现的维度不展示，避免误导
const dimensionLabel: Record<string, string> = { complexity: "复杂度", coupling: "耦合度", typing: "类型质量" };
function Metric({ label, value, suffix, tone, detail }: { label: string; value: number; suffix: string; tone: string; detail: string }) { return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}<small>{suffix}</small></strong><p>{detail}</p></article>; }
function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: string; children: ReactNode }) { return <section className="panel"><div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action && <span className="panel-action">{action}</span>}</div>{children}</section>; }
function StackCard({ report }: { report: Report }) { return <section className="stack-card"><div className="panel-heading"><div><h2>技术栈识别</h2><p>基于依赖与源码证据</p></div><span className="confidence">{Math.round(report.stack.confidence * 100)}%</span></div><div className="stack-primary"><strong>{report.stack.framework ?? "Unknown"}</strong><span>{report.stack.frameworkVersion ?? ""}</span></div><div className="stack-tags">{[report.stack.buildTool, ...report.stack.stateManagement, report.stack.router].filter(Boolean).map(item => <span key={item}>{item}</span>)}</div><div className="evidence"><b>识别证据</b>{report.stack.evidence.map(item => <span key={item}>✓ {item}</span>)}</div></section>; }
function FindingRow({ finding }: { finding: Finding }) { return <div className="finding-row"><span className={`severity ${finding.severity}`} /> <div><strong>{finding.message}</strong><small>{finding.files.join(" · ")}</small></div><span className={`severity-label ${finding.severity}`}>{finding.severity === "error" ? "高" : "中"}</span></div>; }
function SearchResult({ item }: { item: RetrievalResult }) { return <div className="search-result"><div className="result-score">{item.score}<small>score</small></div><div><strong>{item.symbol ?? item.path.split("/").pop()}</strong><code>{item.path}</code><div className="reason-list">{item.reasons.map(reason => <span key={reason}>{reason}</span>)}</div>{item.relatedPaths.length > 0 && <small className="related">关联：{item.relatedPaths.join(" · ")}</small>}</div></div>; }
function HealthBar({ label, value }: { label: string; value: number }) { return <div className="health-item"><div><span>{label}</span><b>{value}</b></div><div className="bar"><i style={{ width: `${value}%` }} /></div></div>; }
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function MermaidChart({ source }: { source: string }) { const [svg, setSvg] = useState(""); useEffect(() => { let active = true; mermaid.render(`architecture-${Date.now()}`, source).then(result => { if (active) setSvg(result.svg); }).catch(() => setSvg("<p>Mermaid 图解析失败</p>")); return () => { active = false; }; }, [source]); return <div className="mermaid-canvas" dangerouslySetInnerHTML={{ __html: svg }} />; }

createRoot(document.getElementById("root")!).render(<App />);
