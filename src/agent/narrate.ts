import { generateObject } from "ai";
import { z } from "zod";
import type { ArchitectureReport } from "../analyze/architecture.js";
import type {
  FileNode,
  Finding,
  Narration,
  RelationEdge,
  StackResult,
  SymbolNode,
} from "../core/model.js";
import { stepSignal, TIMEOUTS } from "../core/limits.js";

/**
 * 架构叙述节点的上下文构建与模型调用。
 *
 * 这是整条流水线里唯一调用 LLM 的地方，边界很明确：
 * - 循环依赖由 Tarjan 算出，复杂度由静态分析算出，环上切点由引用计数算出
 * - LLM 只做三件事：分层推断、危害解读、优先级排序
 *
 * 直接把符号图序列化喂给模型是不可行的——一个中型仓库轻松几十万 token。
 * buildNarrationContext 负责把它压缩成分层摘要：目录级聚合 + top-N 热点 +
 * 环及其建议切点 + 按规则聚合的问题统计，并显式记录被裁掉了多少。
 */

/** 上下文裁剪预算 */
const LIMITS = {
  modules: 12,
  hotspots: 15,
  cycles: 10,
  /**
   * 单个环内展示的文件数。
   * 环的「数量」有限不代表体量有限——一个巨型强连通分量可能包含上千文件，
   * 实测 3000 文件的环会让摘要膨胀到 15k tokens，因此必须逐环裁剪。
   */
  cycleFiles: 8,
  findingRules: 12,
  findingSamples: 3,
} as const;

/** 粗略的 token 估算：中英文混排下每 token 约 3 个字符 */
const CHARS_PER_TOKEN = 3;

export interface NarrationContext {
  stack: Pick<StackResult, "framework" | "buildTool" | "stateManagement" | "router">;
  scale: { files: number; symbols: number; components: number; edges: number };
  metrics: { score: number; dimensions: Record<string, number> };
  modules: Array<{
    path: string;
    responsibility: string;
    files: number;
    inbound: number;
    outbound: number;
  }>;
  layers: Array<{ name: string; dependsOn: string[] }>;
  hotspots: Array<{
    path: string;
    lineCount: number;
    complexity: number;
    inbound: number;
    outbound: number;
  }>;
  cycles: Array<{
    files: string[];
    /** 环的真实规模，files 可能只是其中一部分 */
    totalFiles: number;
    suggestedCut?: { from: string; to: string; references: number };
  }>;
  findings: Array<{ rule: string; severity: string; count: number; samples: string[] }>;
  /** 显式记录被裁掉的数量，避免「看起来覆盖了全部」的错觉 */
  truncated: { modules: number; hotspots: number; cycles: number; findingRules: number };
}

export function buildNarrationContext(input: {
  stack: StackResult;
  files: FileNode[];
  symbols: SymbolNode[];
  edges: RelationEdge[];
  findings: Finding[];
  metrics: { score: number; dimensions: Record<string, number> };
  architecture?: ArchitectureReport;
}): NarrationContext {
  const { stack, files, symbols, edges, findings, metrics, architecture } = input;

  const pathById = new Map(files.map((file) => [file.id, file.path]));
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const allModules = architecture?.directories ?? [];
  const allHotspots = [...files]
    .map((file) => ({
      path: file.path,
      lineCount: file.lineCount,
      complexity: file.complexity,
      inbound: inbound.get(file.id) ?? 0,
      outbound: outbound.get(file.id) ?? 0,
    }))
    // 复杂度与耦合度共同决定「值得先看」的程度
    .sort((a, b) => b.complexity + b.inbound * 3 - (a.complexity + a.inbound * 3));

  const allCycles = findings.filter((finding) => finding.rule === "import-cycle");
  const groupedFindings = groupFindings(
    findings.filter((finding) => finding.rule !== "import-cycle"),
  );

  return {
    stack: {
      framework: stack.framework,
      buildTool: stack.buildTool,
      stateManagement: stack.stateManagement,
      router: stack.router,
    },
    scale: {
      files: files.length,
      symbols: symbols.length,
      components: symbols.filter((symbol) => symbol.kind === "component").length,
      edges: edges.length,
    },
    metrics,
    modules: allModules.slice(0, LIMITS.modules),
    layers: (architecture?.layers ?? []).map((layer) => ({
      name: layer.name,
      dependsOn: layer.dependsOn,
    })),
    hotspots: allHotspots.slice(0, LIMITS.hotspots),
    cycles: allCycles.slice(0, LIMITS.cycles).map((finding) => ({
      files: finding.files.slice(0, LIMITS.cycleFiles),
      totalFiles: finding.files.length,
      // 切点仍基于完整环计算，只有展示被裁剪
      suggestedCut: suggestCut(finding.files, edges, pathById),
    })),
    findings: groupedFindings.slice(0, LIMITS.findingRules),
    truncated: {
      modules: Math.max(0, allModules.length - LIMITS.modules),
      hotspots: Math.max(0, allHotspots.length - LIMITS.hotspots),
      cycles: Math.max(0, allCycles.length - LIMITS.cycles),
      findingRules: Math.max(0, groupedFindings.length - LIMITS.findingRules),
    },
  };
}

function groupFindings(findings: Finding[]): NarrationContext["findings"] {
  const grouped = new Map<
    string,
    { rule: string; severity: string; count: number; samples: string[] }
  >();

  for (const finding of findings) {
    const entry = grouped.get(finding.rule) ?? {
      rule: finding.rule,
      severity: finding.severity,
      count: 0,
      samples: [],
    };
    entry.count += 1;
    if (entry.samples.length < LIMITS.findingSamples) entry.samples.push(finding.files[0] ?? "");
    grouped.set(finding.rule, entry);
  }

  return [...grouped.values()].sort((a, b) => b.count - a.count);
}

/**
 * 环上最适合切断的边：引用次数最少的那条。
 *
 * 这是纯计算，不交给 LLM——引用越少，改造成本越低。
 */
function suggestCut(
  cycleFiles: string[],
  edges: RelationEdge[],
  pathById: Map<string, string>,
): { from: string; to: string; references: number } | undefined {
  const inCycle = new Set(cycleFiles);
  const counts = new Map<string, { from: string; to: string; references: number }>();

  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    const from = pathById.get(edge.from);
    const to = pathById.get(edge.to);
    if (!from || !to || !inCycle.has(from) || !inCycle.has(to)) continue;

    const key = `${from}→${to}`;
    const entry = counts.get(key) ?? { from, to, references: 0 };
    entry.references += 1;
    counts.set(key, entry);
  }

  return [...counts.values()].sort((a, b) => a.references - b.references)[0];
}

export function estimateContextTokens(context: NarrationContext): number {
  return Math.ceil(JSON.stringify(context).length / CHARS_PER_TOKEN);
}

export const narrationSchema = z.object({
  summary: z.string().describe("架构总体叙述，说明这个仓库是怎么组织的，200 字以内"),
  layering: z
    .array(
      z.object({
        layer: z.string().describe("推断出的分层名称"),
        role: z.string().describe("该层承担的职责"),
      }),
    )
    .describe("基于目录聚合与依赖方向推断的分层结构"),
  risks: z
    .array(
      z.object({
        title: z.string().describe("风险标题"),
        severity: z.enum(["high", "medium", "low"]),
        rationale: z.string().describe("为什么这是风险，要引用给定的事实"),
        suggestion: z.string().describe("具体的改造建议"),
        relatedPaths: z.array(z.string()).describe("相关文件路径"),
      }),
    )
    .describe("按处理优先级排序的技术债清单"),
});

type Model = Parameters<typeof generateObject>[0]["model"];

const SYSTEM_PROMPT = [
  "你是一名资深前端架构师，正在解读一份自动生成的代码仓库分析结果。",
  "",
  "规则：",
  "1. 只依据给定的事实作答，不要臆测未提供的信息；",
  "2. 循环依赖、复杂度、建议切点都已由静态分析算出，你的任务是解释危害并排定优先级，不要重新计算；",
  "3. truncated 字段表示该类目还有多少条未列出，cycles[].totalFiles 表示该环的真实文件数，措辞上不要把已列出的当成全部；",
  "4. 建议必须具体到可执行，避免「加强代码质量」这类空话。",
].join("\n");

export async function narrateWithModel(
  model: Model,
  context: NarrationContext,
  signal?: AbortSignal,
): Promise<Narration> {
  const { object } = await generateObject({
    model,
    schema: narrationSchema,
    system: SYSTEM_PROMPT,
    prompt: `以下是仓库分析结果的结构化摘要：\n\n${JSON.stringify(context, null, 2)}`,
    // 这是整条流水线里唯一的 LLM 节点，也是最慢的一步（实测 18 秒）。
    // 之前它拿不到任何 signal——用户点了停止，界面停了、状态写成 cancelled 了，
    // 但这次调用会跑完，token 照烧
    abortSignal: stepSignal(signal, TIMEOUTS.modelCall),
  });
  return object;
}
