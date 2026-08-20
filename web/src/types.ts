export interface Finding {
  rule: string;
  severity: "info" | "warning" | "error";
  message: string;
  files: string[];
  evidence?: string[];
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

export interface AnalysisResponse {
  runId: string;
  status: string;
  currentStep: string;
  report: Report;
  queryPlan?: { concepts: string[]; symbolKinds: string[]; relationKinds: string[]; terms: string[] };
  retrieval?: RetrievalResult[];
}
