/**
 * 一次仓库分析的全部词汇：图、发现、结果。
 *
 * 这个文件原名 `model.ts`——在一个**既做代码分析、又调大模型**的项目里，
 * `model` 是全仓最有歧义的一个词：这里的 model 指代码模型（文件、符号、
 * 关系），而 `agent/llm.ts` 里的 model 指大模型。`agent/ask.ts` 里两种
 * import 会挨在一起出现，读的人得先分辨这是哪个 model 才能往下读。
 *
 * 现在两边都取了不会撞的名字：
 * - `core/analysis.ts` —— 分析结果的**形状**（名词）
 * - `agent/llm.ts` 的 `LanguageModel` —— 沿用 ai-sdk 自己的叫法
 *
 * 和 `analyze/` 层的关系：这里是名词，那里是动词。形状放在 core，
 * 是因为 `report` / `refactor` / `task` 都要认这套结构，
 * 但它们不应该为此依赖分析逻辑。
 */
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
