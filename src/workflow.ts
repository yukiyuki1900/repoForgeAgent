import path from "node:path";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { analyzeArchitecture, type ArchitectureReport } from "./architecture.js";
import { analyzeCycles, analyzeFrontend, calculateMetrics } from "./analyzers.js";
import { extractGraph, graphToMermaid } from "./graph.js";
import { resolveModel } from "./llm.js";
import type {
  AnalysisResult,
  FileNode,
  Finding,
  Narration,
  RelationEdge,
  StackResult,
  SymbolNode,
} from "./model.js";
import {
  buildNarrationContext,
  estimateContextTokens,
  narrateWithModel,
  type NarrationContext,
} from "./narrate.js";
import {
  hybridRetrieve,
  parseQueryPlan,
  type QueryPlan,
  type RetrievalResult,
} from "./retrieval.js";
import { renderReports } from "./report.js";
import { scanFiles } from "./scanner.js";
import { detectStack } from "./stack.js";
import { saveCheckpoint, saveIndex } from "./storage.js";

// 单写者通道统一使用「后写入覆盖先前值」的 reducer
const State = Annotation.Root({
  root: Annotation<string>(),
  query: Annotation<string | undefined>(),
  files: Annotation<FileNode[]>({ reducer: (_current, next) => next, default: () => [] }),
  contents: Annotation<Map<string, string>>({
    reducer: (_current, next) => next,
    default: () => new Map(),
  }),
  stack: Annotation<StackResult | undefined>(),
  symbols: Annotation<SymbolNode[]>({ reducer: (_current, next) => next, default: () => [] }),
  edges: Annotation<RelationEdge[]>({ reducer: (_current, next) => next, default: () => [] }),
  // 并行分析节点各自向该通道追加，因此使用 concat 而非覆盖
  findings: Annotation<Finding[]>({
    reducer: (current, next) => [...current, ...next],
    default: () => [],
  }),
  architecture: Annotation<ArchitectureReport | undefined>(),
  metrics: Annotation<AnalysisResult["metrics"] | undefined>(),
  queryPlan: Annotation<QueryPlan | undefined>(),
  retrieval: Annotation<RetrievalResult[]>({ reducer: (_current, next) => next, default: () => [] }),
  narrationContext: Annotation<NarrationContext | undefined>(),
  narration: Annotation<Narration | undefined>(),
  mermaid: Annotation<string>(),
  report: Annotation<AnalysisResult | undefined>(),
  currentStep: Annotation<string>(),
});

export type WorkflowState = typeof State.State;

type QueryPlanner = (query: string) => QueryPlan | Promise<QueryPlan>;
type Narrator = (context: NarrationContext) => Promise<Narration | undefined>;
type NodeHandler = (state: WorkflowState) => Promise<Partial<WorkflowState>>;

/** 未配置模型时返回 undefined，流水线降级为纯确定性分析 */
const defaultNarrator: Narrator = async (context) => {
  const model = resolveModel();
  if (!model) return undefined;
  return narrateWithModel(model, context);
};

/**
 * 包装节点：记录当前节点名，并把状态快照写入 SQLite。
 *
 * 注意：这里的快照目前只用于事后排查，尚未实现基于它的断点恢复。
 */
function node(name: string, handler: NodeHandler, runId?: string) {
  return async (state: WorkflowState): Promise<Partial<WorkflowState>> => {
    const next: Partial<WorkflowState> = { ...(await handler(state)), currentStep: name };
    if (runId) await saveCheckpoint(state.root, runId, { ...state, ...next });
    return next;
  };
}

export function createAnalysisGraph(
  runId?: string,
  queryPlanner: QueryPlanner = parseQueryPlan,
  narrator: Narrator = defaultNarrator,
) {
  const graph = new StateGraph(State)
    .addNode(
      "loadRepository",
      node("loadRepository", async (state) => ({ root: path.resolve(state.root) }), runId),
    )
    .addNode(
      "scanFiles",
      node(
        "scanFiles",
        async (state) => {
          const scanned = await scanFiles(state.root);
          return { files: scanned.files, contents: scanned.contents };
        },
        runId,
      ),
    )
    .addNode(
      "detectStack",
      node(
        "detectStack",
        async (state) => ({ stack: await detectStack(state.root, state.contents) }),
        runId,
      ),
    )
    .addNode(
      "parseSemantic",
      node(
        "parseSemantic",
        async (state) => {
          const { symbols, edges } = extractGraph(state.root, state.files, state.contents);
          return { symbols, edges };
        },
        runId,
      ),
    )
    // 注意：LangGraph 不允许节点名与 state 通道名重复，
    // 因此产出 architecture / retrieval 通道的两个节点用了不同的名字
    .addNode(
      "analyzeArchitecture",
      node(
        "analyzeArchitecture",
        async (state) => ({
          architecture: analyzeArchitecture(state.files, state.symbols, state.edges),
        }),
        runId,
      ),
    )
    .addNode(
      "dependency",
      node("dependency", async (state) => ({ findings: analyzeCycles(state.files, state.edges) }), runId),
    )
    .addNode(
      "quality",
      node("quality", async (state) => ({ metrics: calculateMetrics(state.files, state.edges) }), runId),
    )
    .addNode(
      "frontend",
      node("frontend", async (state) => ({ findings: analyzeFrontend(state.contents) }), runId),
    )
    .addNode("retrieveContext", node("retrieveContext", retrievalHandler(queryPlanner), runId))
    .addNode("narrate", node("narrate", narrateHandler(narrator), runId))
    .addNode("render", node("render", renderHandler, runId))

    .addEdge(START, "loadRepository")
    .addEdge("loadRepository", "scanFiles")
    .addEdge("scanFiles", "detectStack")
    .addEdge("detectStack", "parseSemantic")

    // fan-out：四个分析器互不依赖，并行执行
    .addEdge("parseSemantic", "analyzeArchitecture")
    .addEdge("parseSemantic", "dependency")
    .addEdge("parseSemantic", "quality")
    .addEdge("parseSemantic", "frontend")

    // fan-in：全部完成后汇聚
    .addEdge("analyzeArchitecture", "retrieveContext")
    .addEdge("dependency", "retrieveContext")
    .addEdge("quality", "retrieveContext")
    .addEdge("frontend", "retrieveContext")

    // 事实全部就位后，再交给 LLM 做解释与优先级排序
    .addEdge("retrieveContext", "narrate")
    .addEdge("narrate", "render")
    .addEdge("render", END);

  // MemorySaver 仅在进程内保留状态，进程退出即丢失
  return graph.compile({ checkpointer: new MemorySaver() });
}

function retrievalHandler(queryPlanner: QueryPlanner): NodeHandler {
  return async (state) => {
    if (!state.query) return { retrieval: [] };
    const queryPlan = await queryPlanner(state.query);
    return {
      queryPlan,
      retrieval: hybridRetrieve(queryPlan, state.files, state.symbols, state.edges, state.contents),
    };
  };
}

function narrateHandler(narrator: Narrator): NodeHandler {
  return async (state) => {
    const context = buildNarrationContext({
      stack: state.stack!,
      files: state.files,
      symbols: state.symbols,
      edges: state.edges,
      findings: state.findings,
      metrics: state.metrics!,
      architecture: state.architecture,
    });

    const dropped = Object.values(context.truncated).reduce((sum, value) => sum + value, 0);
    console.log(
      `[narrate] 上下文摘要约 ${estimateContextTokens(context)} tokens` +
        (dropped > 0 ? `，另有 ${dropped} 项因预算裁剪未列入` : ""),
    );

    let narration: Narration | undefined;
    try {
      narration = await narrator(context);
      if (!narration) {
        console.log("[narrate] 未配置模型，跳过架构叙述，仅输出确定性分析结果");
      }
    } catch (error) {
      // LLM 只负责解释，失败不应让整条流水线失败
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[narrate] 模型调用失败，降级为仅输出确定性分析：${reason}`);
    }

    return { narrationContext: context, narration };
  };
}

const renderHandler: NodeHandler = async (state) => {
  const result: AnalysisResult = {
    root: state.root,
    stack: state.stack!,
    files: state.files,
    symbols: state.symbols,
    edges: state.edges,
    findings: state.findings,
    metrics: state.metrics!,
    narration: state.narration,
    mermaid: state.architecture?.mermaid ?? graphToMermaid(state.files, state.edges),
    generatedAt: new Date().toISOString(),
  };

  await saveIndex(state.root, result);
  await renderReports(state.root, result);

  return { report: result, mermaid: result.mermaid };
};

export async function runAnalysis(
  root: string,
  query?: string,
  runId = `analysis-${Date.now()}`,
): Promise<WorkflowState> {
  const graph = createAnalysisGraph(runId);
  const result = await graph.invoke(
    { root, query, currentStep: "start" },
    { configurable: { thread_id: runId } },
  );
  await saveCheckpoint(root, runId, result);
  return result;
}
