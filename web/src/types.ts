export interface Finding {
  rule: string;
  severity: "info" | "warning" | "error";
  message: string;
  files: string[];
  evidence?: string[];
}

export interface Narration {
  summary: string;
  layering: Array<{ layer: string; role: string }>;
  risks: Array<{
    title: string;
    severity: "high" | "medium" | "low";
    rationale: string;
    suggestion: string;
    relatedPaths: string[];
  }>;
}

/** 节点级进度事件，与后端 workflow.ts 的 ProgressEvent 保持一致 */
export interface ProgressEvent {
  node: string;
  phase: "start" | "end" | "error";
  at: string;
  durationMs?: number;
  detail?: string;
}

export interface Report {
  root: string;
  stack: {
    framework: string | null;
    frameworkVersion?: string;
    buildTool: string | null;
    stateManagement: string[];
    language: string[];
    router: string | null;
    confidence: number;
    evidence: string[];
  };
  files: Array<{ path: string; lineCount: number; complexity: number }>;
  symbols: Array<{ name: string; kind: string }>;
  edges: Array<{ kind: string; from: string; to: string }>;
  findings: Finding[];
  metrics: { score: number; dimensions: Record<string, number> };
  narration?: Narration;
  mermaid: string;
  /** 本次实际执行了哪些节点、跳过了什么、为什么 */
  plan?: ExecutionPlan;
  generatedAt: string;
}

export interface ExecutionPlan {
  intent: string;
  rationale: string;
  decisions: Array<{ node: string; run: boolean; why: string }>;
}

export interface RetrievalResult {
  path: string;
  symbol?: string;
  score: number;
  reasons: string[];
  relatedPaths: string[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
  /** 含 package.json，大概率是一个可分析的仓库 */
  isRepo: boolean;
  /** 已经有 .reposurgeon 索引，说明分析过 */
  analyzed: boolean;
}

export interface BrowseResponse {
  path: string;
  parent: string | null;
  isRepo: boolean;
  analyzed: boolean;
  entries: DirectoryEntry[];
}

export interface RootsResponse {
  roots: Array<{ label: string; path: string }>;
}

/** POST /fs/locate 的候选结果：按目录特征匹配度排序 */
export interface LocateMatch {
  path: string;
  score: number;
  /** package.json 内容完全一致，基本可认定就是所选目录 */
  exact: boolean;
  isRepo: boolean;
  analyzed: boolean;
}

export interface LocateResponse {
  matches: LocateMatch[];
  /** 判据足够强，可直接采用第一个而不必再问用户 */
  confident: boolean;
}

export interface RunSummary {
  id: number;
  generatedAt: string;
  files: number;
  findings: number;
  score: number | null;
  framework: string | null;
}

/** POST /analysis 的 202 响应：任务已受理，进度走 SSE */
export interface AnalysisAccepted {
  runId: string;
  status: string;
  statusUrl: string;
  eventsUrl: string;
}

/** GET /analysis/:runId 的响应 */
export interface AnalysisStatus {
  runId: string;
  status: "running" | "completed" | "failed";
  currentStep: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  events: ProgressEvent[];
  report?: Report;
  queryPlan?: {
    concepts: string[];
    symbolKinds: string[];
    relationKinds: string[];
    terms: string[];
  };
  retrieval?: RetrievalResult[];
}
