import type { ExecutionPlan } from "./plan.js";

export type Language = "ts" | "tsx" | "js" | "jsx" | "vue";
export type SymbolKind =
  "function" | "class" | "component" | "interface" | "type" | "variable" | "hook" | "store";
export type RelationKind =
  | "import"
  | "export"
  | "call"
  | "render"
  | "type-reference"
  | "extends"
  | "implements"
  | "uses-hook";

export interface FileNode {
  id: string;
  path: string;
  language: Language;
  size: number;
  contentHash: string;
  lineCount: number;
  complexity: number;
}

export interface SymbolNode {
  id: string;
  fileId: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
}

export interface RelationEdge {
  from: string;
  to: string;
  kind: RelationKind;
  location?: { file: string; line: number };
}

export interface Finding {
  rule: string;
  severity: "info" | "warning" | "error";
  message: string;
  files: string[];
  evidence?: string[];
}

export interface StackResult {
  framework: string | null;
  frameworkVersion?: string;
  buildTool: string | null;
  stateManagement: string[];
  language: string[];
  router: string | null;
  confidence: number;
  evidence: string[];
}

/**
 * LLM 产出的解释性内容。
 *
 * 边界：LLM 只负责解释与叙述，不负责计算。
 * 循环依赖由图算法得出，复杂度由静态分析得出，
 * 这里只对既有事实做分层推断、危害解读与优先级排序。
 */
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

export interface AnalysisResult {
  root: string;
  stack: StackResult;
  files: FileNode[];
  symbols: SymbolNode[];
  edges: RelationEdge[];
  findings: Finding[];
  metrics: { score: number; dimensions: Record<string, number> };
  narration?: Narration;
  mermaid: string;
  /**
   * 本次的执行计划。
   *
   * 裁剪必须留痕：读报告的人要能看出「这一节为什么没有」，
   * 而不是以为工具没发现问题。
   */
  plan?: ExecutionPlan;
  generatedAt: string;
}
