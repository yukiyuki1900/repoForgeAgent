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
  generatedAt: string;
}

export interface RetrievalResult {
  path: string;
  symbol?: string;
  score: number;
  reasons: string[];
  relatedPaths: string[];
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
  queryPlan?: { concepts: string[]; symbolKinds: string[]; relationKinds: string[]; terms: string[] };
  retrieval?: RetrievalResult[];
}
