import { setMaxListeners } from "node:events";
import path from "node:path";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { analyzeArchitecture, type ArchitectureReport } from "./analyze/architecture.js";
import { analyzeCycles, calculateMetrics } from "./analyze/analyzers.js";
import { analyzeDeadExports, toDeadExportFindings } from "./analyze/deadexports.js";
import { extractGraph, graphToMermaid } from "./scan/graph.js";
import { parseQueryWithModel, resolveModel } from "./agent/llm.js";
import { planExecution, summarizePlan, type ExecutionPlan } from "./core/plan.js";
import type {
  AnalysisResult,
  FileNode,
  Finding,
  Narration,
  RelationEdge,
  StackResult,
  SymbolNode,
} from "./core/model.js";
import {
  buildNarrationContext,
  estimateContextTokens,
  narrateWithModel,
  type NarrationContext,
} from "./agent/narrate.js";
import {
  hybridRetrieve,
  parseQueryPlan,
  type QueryPlan,
  type RetrievalResult,
} from "./analyze/retrieval.js";
import { renderReports } from "./report/report.js";
import { scanFiles } from "./scan/scanner.js";
import { detectStack } from "./scan/stack.js";
import { saveCheckpoint, saveIndex } from "./report/storage.js";

// 单写者通道统一使用「后写入覆盖先前值」的 reducer
const State = Annotation.Root({
  root: Annotation<string>(),
  query: Annotation<string | undefined>(),
  /** 用户显式要求全量分析，跳过意图裁剪 */
  full: Annotation<boolean | undefined>(),
  // 通道名不能与节点名重复，所以产出它的节点叫 plan，通道叫 executionPlan
  executionPlan: Annotation<ExecutionPlan | undefined>(),
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
  retrieval: Annotation<RetrievalResult[]>({
    reducer: (_current, next) => next,
    default: () => [],
  }),
  narrationContext: Annotation<NarrationContext | undefined>(),
  narration: Annotation<Narration | undefined>(),
  mermaid: Annotation<string>(),
  report: Annotation<AnalysisResult | undefined>(),
  // 必须显式给 reducer：四个并行分析器处于同一个 superstep，都会写这个通道，
  // 而无 reducer 的 LastValue 一步只接受一个值，否则每次运行都会抛
  // InvalidUpdateError: LastValue can only receive one value per step
  currentStep: Annotation<string>({ reducer: (_current, next) => next, default: () => "start" }),
});

export type WorkflowState = typeof State.State;

type QueryPlanner = (query: string) => QueryPlan | Promise<QueryPlan>;
type Narrator = (context: NarrationContext, signal?: AbortSignal) => Promise<Narration | undefined>;
type Planner = (
  input: Parameters<typeof planExecution>[0],
) => ExecutionPlan | Promise<ExecutionPlan>;
type NodeHandler = (state: WorkflowState) => Promise<Partial<WorkflowState>>;

/**
 * 节点级进度事件。
 *
 * 从自定义的 node 包装里发出，而不是依赖 LangGraph 的 streamEvents——
 * 这样能拿到每个节点自己的产出摘要与耗时，也不受框架内部 API 变动影响。
 * 并行分析器的 start 事件会交错出现，这本身就是「并行是真的」的证据。
 */
export interface ProgressEvent {
  node: string;
  phase: "start" | "end" | "error";
  at: string;
  durationMs?: number;
  detail?: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

interface NodeContext {
  runId?: string;
  onProgress?: ProgressListener;
  /**
   * 任务级取消信号。
   *
   * LangGraph 自己也能在**节点边界**中止，但那救不了正在进行的模型调用——
   * `narrate` 那 18 秒照样会跑完。所以 signal 必须一路递到发请求的地方。
   */
  signal?: AbortSignal;
}

/** 未配置模型时返回 undefined，流水线降级为纯确定性分析 */
const defaultNarrator: Narrator = async (context, signal) => {
  const model = resolveModel();
  if (!model) return undefined;
  return narrateWithModel(model, context, signal);
};

/**
 * 有模型就让它把自然语言翻译成查询计划，否则回退到规则解析。
 *
 * 规则版靠 CONCEPT_MAP 做中文到标识符的映射，覆盖不了长尾表达；
 * 这正是 LLM 该干的活——把意图翻译成检索词，而不是替代检索本身。
 */
const defaultQueryPlanner: QueryPlanner = async (query) => {
  const model = resolveModel();
  if (!model) return parseQueryPlan(query);

  try {
    return await parseQueryWithModel(model, query);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[retrieveContext] 查询计划模型调用失败，回退规则解析：${reason}`);
    return parseQueryPlan(query);
  }
};

/**
 * 包装节点：发出进度事件、记录当前节点名、把状态快照写入 SQLite。
 *
 * 注意：这里的快照目前只用于事后排查，尚未实现基于它的断点恢复。
 */
function node(name: string, handler: NodeHandler, context: NodeContext) {
  return async (state: WorkflowState): Promise<Partial<WorkflowState>> => {
    const startedAt = Date.now();
    context.onProgress?.({ node: name, phase: "start", at: new Date().toISOString() });

    try {
      const next: Partial<WorkflowState> = { ...(await handler(state)), currentStep: name };
      if (context.runId) {
        await saveCheckpoint(state.root, context.runId, summarize({ ...state, ...next }));
      }

      context.onProgress?.({
        node: name,
        phase: "end",
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        detail: describe(name, next),
      });
      return next;
    } catch (error) {
      context.onProgress?.({
        node: name,
        phase: "error",
        at: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

/**
 * 落库前把状态压成摘要。
 *
 * 直接序列化整个 state 会把 contents（全仓源码）、files、symbols、edges
 * 一并写进 SQLite——每个节点写一次，11 个节点就是十几倍源码体积的同步 IO，
 * 大仓上足以阻塞事件循环甚至撑爆 JSON.stringify 的字符串上限。
 * 快照本来就只用于事后排查，标量足够。
 */
function summarize(state: WorkflowState) {
  return {
    root: state.root,
    query: state.query,
    currentStep: state.currentStep,
    executionPlan: state.executionPlan,
    stack: state.stack,
    metrics: state.metrics,
    narration: state.narration,
    counts: {
      files: state.files.length,
      symbols: state.symbols.length,
      edges: state.edges.length,
      findings: state.findings.length,
      retrieval: state.retrieval.length,
    },
  };
}

/** 每个节点用一句话汇报自己的产出，供 CLI 与前端直接展示 */
function describe(name: string, next: Partial<WorkflowState>): string | undefined {
  switch (name) {
    case "plan":
      return next.executionPlan ? summarizePlan(next.executionPlan) : undefined;
    case "scanFiles":
      return `${next.files?.length ?? 0} 个文件`;
    case "detectStack":
      return next.stack?.framework
        ? `${next.stack.framework}${next.stack.buildTool ? ` + ${next.stack.buildTool}` : ""}`
        : "技术栈未识别";
    case "parseSemantic":
      return `${next.symbols?.length ?? 0} 个符号 · ${next.edges?.length ?? 0} 条关系边`;
    case "analyzeArchitecture":
      return `${next.architecture?.directories.length ?? 0} 个模块`;
    case "dependency":
      return `${next.findings?.length ?? 0} 处循环依赖`;
    case "quality":
      return next.metrics ? `维护性评分 ${next.metrics.score}` : undefined;
    case "deadExports":
      return `${next.findings?.length ?? 0} 个文件存在未使用的导出`;
    case "retrieveContext":
      // 「没提问」和「提了问但没命中」是两回事，早先都显示成前者
      if (!next.queryPlan) return "未提供检索问题";
      return next.retrieval?.length ? `${next.retrieval.length} 条检索结果` : "检索无命中";
    case "narrate":
      return next.narration ? "架构解读已生成" : "未配置模型，已跳过";
    case "render":
      return "报告已输出";
    default:
      return undefined;
  }
}

export interface GraphOptions {
  runId?: string;
  queryPlanner?: QueryPlanner;
  narrator?: Narrator;
  /** 默认是规则决策；留出注入点，方便换成模型或做实验对照 */
  planner?: Planner;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
}

export function createAnalysisGraph(options: GraphOptions = {}) {
  const {
    runId,
    queryPlanner = defaultQueryPlanner,
    narrator = defaultNarrator,
    planner = planExecution,
    onProgress,
    signal,
  } = options;
  const context: NodeContext = { runId, onProgress, signal };

  const graph = new StateGraph(State)
    .addNode(
      "loadRepository",
      node("loadRepository", async (state) => ({ root: path.resolve(state.root) }), context),
    )
    .addNode(
      "scanFiles",
      node(
        "scanFiles",
        async (state) => {
          const scanned = await scanFiles(state.root);

          // 扫不到文件时继续跑下去只会产出一份「0 文件、空架构图」的报告，
          // 看起来像分析成功了。绝大多数情况是路径指错了，直接失败更有用。
          if (scanned.files.length === 0) {
            throw new Error(
              `在 ${path.resolve(state.root)} 下没有找到可分析的源码文件（.ts / .tsx / .js / .jsx / .vue）。\n` +
                "请确认：\n" +
                "  1. 路径指向的是项目根目录，而不是它的上级目录\n" +
                "  2. 源码没有全部落在 node_modules / dist / build 等被忽略的目录里",
            );
          }

          return { files: scanned.files, contents: scanned.contents };
        },
        context,
      ),
    )
    .addNode(
      "detectStack",
      node(
        "detectStack",
        async (state) => ({ stack: await detectStack(state.root, state.contents) }),
        context,
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
        context,
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
        context,
      ),
    )
    .addNode(
      "dependency",
      node(
        "dependency",
        async (state) => ({ findings: analyzeCycles(state.files, state.edges) }),
        context,
      ),
    )
    .addNode(
      "quality",
      node(
        "quality",
        async (state) => ({ metrics: calculateMetrics(state.files, state.edges) }),
        context,
      ),
    )
    .addNode(
      "deadExports",
      node(
        "deadExports",
        async (state) => ({
          findings: toDeadExportFindings(
            analyzeDeadExports({
              root: state.root,
              files: state.files,
              contents: state.contents,
            }),
          ),
        }),
        context,
      ),
    )
    .addNode("plan", node("plan", planHandler(planner), context))
    .addNode("retrieveContext", node("retrieveContext", retrievalHandler(queryPlanner), context))
    .addNode("narrate", node("narrate", narrateHandler(narrator, signal), context))
    .addNode("render", node("render", renderHandler, context))

    .addEdge(START, "loadRepository")
    .addEdge("loadRepository", "scanFiles")
    .addEdge("scanFiles", "detectStack")
    // 先决策再干活：plan 要看到文件数、技术栈与用户问题才能排布后面的节点
    .addEdge("detectStack", "plan")
    .addEdge("plan", "parseSemantic")

    // 条件 fan-out：并行分支由计划动态决定。
    // dependency / quality 恒在——报告的 metrics 与循环依赖是必填内容，
    // 且两者合计 17ms，裁掉只会让报告残缺，省不下任何东西
    .addConditionalEdges("parseSemantic", selectAnalyzers, [
      "analyzeArchitecture",
      "dependency",
      "quality",
      "deadExports",
    ])

    // fan-in：四个分支指向同一个下一站，该节点只执行一次；
    // 未被调度的分支不会阻塞汇聚。下一站是谁由计划决定——
    // 没有检索问题就不进 retrieveContext，而不是让它空转一趟再说自己跳过了
    .addConditionalEdges("analyzeArchitecture", afterAnalyzers, [...AFTER_ANALYZERS])
    .addConditionalEdges("dependency", afterAnalyzers, [...AFTER_ANALYZERS])
    .addConditionalEdges("quality", afterAnalyzers, [...AFTER_ANALYZERS])
    .addConditionalEdges("deadExports", afterAnalyzers, [...AFTER_ANALYZERS])

    // 事实全部就位后再决定要不要花 18 秒让模型写一段解读
    .addConditionalEdges("retrieveContext", selectNarration, ["narrate", "render"])
    .addEdge("narrate", "render")
    .addEdge("render", END);

  // MemorySaver 仅在进程内保留状态，进程退出即丢失
  return graph.compile({ checkpointer: new MemorySaver() });
}

/**
 * 条件 fan-out：这一轮跑哪几个分析器。
 *
 * 返回数组即动态并行分支。LangGraph 只会为返回的节点触发调度，
 * 没被选中的分支不执行、也不会阻塞下游的 fan-in。
 */
function selectAnalyzers(state: WorkflowState): string[] {
  const optional = new Set(state.executionPlan?.run ?? ["analyzeArchitecture", "deadExports"]);
  const branches = ["dependency", "quality"];

  if (optional.has("analyzeArchitecture")) branches.push("analyzeArchitecture");
  if (optional.has("deadExports")) branches.push("deadExports");
  return branches;
}

// as const：LangGraph 会用字面量类型校验路由目标，写成 string[] 编译不过。
// 这层校验很有用——它能在编译期挡住「路由到一个不存在的节点名」
const AFTER_ANALYZERS = ["retrieveContext", "narrate", "render"] as const;
type AfterAnalyzers = (typeof AFTER_ANALYZERS)[number];

/**
 * 分析器跑完之后去哪。
 *
 * 四个分支返回同一个目标即构成 fan-in，该节点只会执行一次。
 * 这样「跳过」就是真的不执行，而不是进去空转一趟再报告自己被跳过了——
 * 进度条上出现一个耗时 0ms 的节点，同时报告里说它被跳过，是自相矛盾的。
 */
function afterAnalyzers(state: WorkflowState): AfterAnalyzers {
  if (state.query) return "retrieveContext";
  return selectNarration(state);
}

function selectNarration(state: WorkflowState): "narrate" | "render" {
  return state.executionPlan?.run.includes("narrate") ? "narrate" : "render";
}

function planHandler(planner: Planner): NodeHandler {
  return async (state) => ({
    executionPlan: await planner({
      query: state.query,
      full: state.full,
      hasModel: resolveModel() !== undefined,
    }),
  });
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

function narrateHandler(narrator: Narrator, signal?: AbortSignal): NodeHandler {
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
      narration = await narrator(context, signal);
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
    plan: state.executionPlan,
    generatedAt: new Date().toISOString(),
  };

  await saveIndex(state.root, result);
  await renderReports(state.root, result);

  return { report: result, mermaid: result.mermaid };
};

export interface RunOptions {
  query?: string;
  /** 忽略意图裁剪，跑满全部节点 */
  full?: boolean;
  runId?: string;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
}

/**
 * LangGraph 会给同一个 AbortSignal 逐节点挂监听器，节点数超过 Node 默认的 10 个
 * 就会打印 MaxListenersExceededWarning。这里按节点数留出余量，
 * 避免每次运行都在输出里插一条无害但扎眼的警告。
 */
const NODE_COUNT = 12;
setMaxListeners(NODE_COUNT * 2);

export async function runAnalysis(root: string, options: RunOptions = {}): Promise<WorkflowState> {
  const runId = options.runId ?? `analysis-${Date.now()}`;
  const graph = createAnalysisGraph({
    runId,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  const result = await graph.invoke(
    { root, query: options.query, full: options.full, currentStep: "start" },
    // 两处都要传：这里管的是节点**边界**上的中止，
    // context 里那份管的是节点**内部**正在飞的那个请求
    { configurable: { thread_id: runId }, signal: options.signal },
  );

  await saveCheckpoint(root, runId, summarize(result));
  return result;
}
