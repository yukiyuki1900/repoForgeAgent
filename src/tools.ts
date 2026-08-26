import path from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { analyzeCycles } from "./analyzers.js";
import { extractGraph } from "./graph.js";
import type { FileNode, Finding, RelationEdge, SymbolNode } from "./model.js";
import { scanFiles } from "./scanner.js";

/**
 * 暴露给模型的只读工具集。
 *
 * 这里是整个项目里唯一让模型自己决定「下一步查什么」的地方。
 * 前面的分析流水线是我们编排它，这里是它编排自己——所以边界要收得比别处更紧：
 *
 * - **全部只读**：没有任何一个工具能写文件、跑命令或发网络请求
 * - **只能看见扫描结果**：路径不在 `index.files` 里就查不到，
 *   天然挡掉了路径穿越——不需要额外做 `..` 校验，因为根本没有一条通往 fs 的路
 * - **输出有上限**：每个工具都限制条数与行数，并在截断时**明说截断了多少**。
 *   静默截断会让模型把「前 40 条」当成全部，然后给出一个自信的错误结论
 * - **查不到时给候选**：返回空结果模型只会换个名字继续瞎猜，
 *   给出最接近的几个路径它才能自我纠正
 */

export interface CodebaseIndex {
  root: string;
  files: FileNode[];
  symbols: SymbolNode[];
  edges: RelationEdge[];
  contents: Map<string, string>;
  cycles: Finding[];
  /** id → path */
  pathById: Map<string, string>;
  byPath: Map<string, FileNode>;
}

export async function buildIndex(root: string): Promise<CodebaseIndex> {
  const absolute = path.resolve(root);
  const { files, contents } = await scanFiles(absolute);

  if (files.length === 0) {
    throw new Error(`在 ${absolute} 下没有找到可分析的源码文件`);
  }

  const { symbols, edges } = extractGraph(absolute, files, contents);

  return {
    root: absolute,
    files,
    symbols,
    edges,
    contents,
    cycles: analyzeCycles(files, edges),
    pathById: new Map(files.map((file) => [file.id, file.path])),
    byPath: new Map(files.map((file) => [file.path, file])),
  };
}

/** 一次工具调用的记录，用于展示与评估 */
export interface ToolCall {
  name: string;
  args: unknown;
  /** 一句话说明这次调用查到了什么，供进度行展示 */
  summary: string;
}

const LIMITS = {
  /** 列表类结果最多返回多少条 */
  rows: 40,
  /** readSource 单次最多返回多少行 */
  sourceLines: 120,
  /** 查不到路径时提示几个候选 */
  suggestions: 5,
};

export interface ToolsetOptions {
  onCall?: (call: ToolCall) => void;
}

export function createTools(index: CodebaseIndex, options: ToolsetOptions = {}) {
  const calls: ToolCall[] = [];

  const record = (name: string, args: unknown, summary: string): void => {
    const call = { name, args, summary };
    calls.push(call);
    options.onCall?.(call);
  };

  /** 把列表裁到上限，并如实报告裁掉了多少 */
  const capped = <T>(rows: T[]) => ({
    total: rows.length,
    shown: Math.min(rows.length, LIMITS.rows),
    truncated: Math.max(0, rows.length - LIMITS.rows),
    rows: rows.slice(0, LIMITS.rows),
  });

  /**
   * 解析模型给出的路径。
   *
   * 模型经常写出 `utils/request.ts`、`./src/utils/request` 这类近似路径，
   * 直接判 not found 只会让它再猜一次。这里先按后缀匹配，再退回候选建议。
   */
  const resolvePath = (input: string): { path?: string; suggestions: string[] } => {
    const normalized = input.replace(/^\.\//, "").replace(/\\/g, "/");
    if (index.byPath.has(normalized)) return { path: normalized, suggestions: [] };

    const bySuffix = index.files.filter((file) => file.path.endsWith(normalized));
    if (bySuffix.length === 1) return { path: bySuffix[0].path, suggestions: [] };

    const needle = normalized.toLowerCase();
    const near = index.files
      .filter((file) => file.path.toLowerCase().includes(needle))
      .slice(0, LIMITS.suggestions)
      .map((file) => file.path);

    return {
      path: undefined,
      suggestions:
        near.length > 0 ? near : bySuffix.slice(0, LIMITS.suggestions).map((f) => f.path),
    };
  };

  const notFound = (input: string, suggestions: string[]) => ({
    error: `仓库里没有路径 "${input}"`,
    suggestions,
    hint:
      suggestions.length > 0
        ? "上面是最接近的几个路径，请从中选一个重试"
        : "先用 searchFiles 确认路径",
  });

  const importEdgesOf = (filePath: string) => {
    const file = index.byPath.get(filePath)!;
    return {
      inbound: index.edges.filter((edge) => edge.to === file.id && edge.kind === "import"),
      outbound: index.edges.filter((edge) => edge.from === file.id && edge.kind === "import"),
    };
  };

  const tools = {
    searchFiles: tool({
      description: "按路径关键词查找文件。用于定位一个模块的实际路径，或列出某个目录下有哪些文件。",
      parameters: z.object({
        keyword: z.string().describe("路径中包含的关键词，如 'utils/request' 或 'login'"),
      }),
      execute: async ({ keyword }) => {
        const needle = keyword.toLowerCase().replace(/\\/g, "/");
        const matched = index.files.filter((file) => file.path.toLowerCase().includes(needle));
        const result = capped(
          matched.map((file) => ({
            path: file.path,
            language: file.language,
            lines: file.lineCount,
          })),
        );
        record("searchFiles", { keyword }, `${result.total} 个文件匹配 "${keyword}"`);
        return result;
      },
    }),

    getFileSummary: tool({
      description:
        "查看单个文件的概览：语言、行数、圈复杂度、导出的符号、被多少文件依赖、依赖了多少文件。",
      parameters: z.object({ path: z.string().describe("仓库相对路径") }),
      execute: async ({ path: input }) => {
        const resolved = resolvePath(input);
        if (!resolved.path) {
          record("getFileSummary", { path: input }, `路径未命中：${input}`);
          return notFound(input, resolved.suggestions);
        }

        const file = index.byPath.get(resolved.path)!;
        const { inbound, outbound } = importEdgesOf(resolved.path);
        const exported = index.symbols
          .filter((symbol) => symbol.fileId === file.id && symbol.exported)
          .map((symbol) => `${symbol.kind} ${symbol.name}`);

        record(
          "getFileSummary",
          { path: resolved.path },
          `${resolved.path} · ${file.lineCount} 行 · 入边 ${inbound.length} · 出边 ${outbound.length}`,
        );

        return {
          path: resolved.path,
          language: file.language,
          lines: file.lineCount,
          complexity: file.complexity,
          exports: capped(exported),
          dependentCount: inbound.length,
          dependencyCount: outbound.length,
          inCycles: index.cycles.filter((cycle) => cycle.files.includes(resolved.path!)).length,
        };
      },
    }),

    getDependents: tool({
      description: "查看哪些文件 import 了目标文件（入边）。用于判断一个模块的影响面有多大。",
      parameters: z.object({ path: z.string().describe("仓库相对路径") }),
      execute: async ({ path: input }) => {
        const resolved = resolvePath(input);
        if (!resolved.path) {
          record("getDependents", { path: input }, `路径未命中：${input}`);
          return notFound(input, resolved.suggestions);
        }

        const { inbound } = importEdgesOf(resolved.path);
        const result = capped(
          inbound.map((edge) => ({
            from: index.pathById.get(edge.from) ?? edge.from,
            line: edge.location?.line,
          })),
        );
        record(
          "getDependents",
          { path: resolved.path },
          `${resolved.path} ← 被 ${result.total} 个文件依赖`,
        );
        return { path: resolved.path, ...result };
      },
    }),

    getDependencies: tool({
      description: "查看目标文件 import 了哪些文件（出边）。出边多说明这个文件承担了过多职责。",
      parameters: z.object({ path: z.string().describe("仓库相对路径") }),
      execute: async ({ path: input }) => {
        const resolved = resolvePath(input);
        if (!resolved.path) {
          record("getDependencies", { path: input }, `路径未命中：${input}`);
          return notFound(input, resolved.suggestions);
        }

        const { outbound } = importEdgesOf(resolved.path);
        const result = capped(
          outbound.map((edge) => ({
            to: index.pathById.get(edge.to) ?? edge.to,
            line: edge.location?.line,
          })),
        );
        record(
          "getDependencies",
          { path: resolved.path },
          `${resolved.path} → 依赖 ${result.total} 个文件`,
        );
        return { path: resolved.path, ...result };
      },
    }),

    findSymbol: tool({
      description: "按名字查找符号（函数、类、组件、Hook、类型等），返回定义位置。",
      parameters: z.object({ name: z.string().describe("符号名，支持部分匹配") }),
      execute: async ({ name }) => {
        const needle = name.toLowerCase();
        const matched = index.symbols.filter((symbol) =>
          symbol.name.toLowerCase().includes(needle),
        );
        const result = capped(
          matched.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            exported: symbol.exported,
            path: index.pathById.get(symbol.fileId) ?? symbol.fileId,
            line: symbol.startLine,
          })),
        );
        record("findSymbol", { name }, `${result.total} 个符号匹配 "${name}"`);
        return result;
      },
    }),

    listCycles: tool({
      description:
        "列出仓库里的循环依赖。可选按文件过滤，只看包含该文件的环。注意：import type 已被排除，这里只有运行时环。",
      parameters: z.object({
        path: z.string().optional().describe("只看包含这个文件的环，留空则列出全部"),
      }),
      execute: async ({ path: input }) => {
        let cycles = index.cycles;
        let scope = "全部";

        if (input) {
          const resolved = resolvePath(input);
          if (!resolved.path) {
            record("listCycles", { path: input }, `路径未命中：${input}`);
            return notFound(input, resolved.suggestions);
          }
          cycles = cycles.filter((cycle) => cycle.files.includes(resolved.path!));
          scope = resolved.path;
        }

        record("listCycles", { path: input }, `${cycles.length} 个环（范围：${scope}）`);
        return capped(
          cycles.map((cycle) => ({
            fileCount: cycle.files.length,
            loop: cycle.evidence?.[0],
            files: cycle.files.slice(0, 12),
          })),
        );
      },
    }),

    listHotspots: tool({
      description:
        "按被依赖次数排序，列出仓库里最核心的文件。回答「哪个模块被依赖得最多」「影响面最大的文件是什么」时应当首选这个，不要逐个文件去试 getDependents。",
      parameters: z.object({
        limit: z.number().int().min(1).max(30).optional().describe("返回前几名，默认 10"),
      }),
      execute: async ({ limit }) => {
        const top = limit ?? 10;
        const inbound = new Map<string, number>();
        const outbound = new Map<string, number>();

        for (const edge of index.edges) {
          if (edge.kind !== "import") continue;
          inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
          outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
        }

        const ranked = index.files
          .map((file) => ({
            path: file.path,
            dependentCount: inbound.get(file.id) ?? 0,
            dependencyCount: outbound.get(file.id) ?? 0,
            lines: file.lineCount,
          }))
          .filter((item) => item.dependentCount > 0)
          .sort((a, b) => b.dependentCount - a.dependentCount)
          .slice(0, top);

        record(
          "listHotspots",
          { limit: top },
          ranked.length > 0
            ? `Top ${ranked.length}，最高 ${ranked[0].path}（${ranked[0].dependentCount} 入边）`
            : "没有任何文件被依赖",
        );

        return { rows: ranked, note: `按入边数排序，仅统计运行时 import 边` };
      },
    }),

    readSource: tool({
      description: `读取源码片段，单次最多 ${LIMITS.sourceLines} 行。用于确认某段代码到底做了什么，不要凭文件名猜测。`,
      parameters: z.object({
        path: z.string().describe("仓库相对路径"),
        startLine: z.number().int().min(1).describe("起始行，从 1 开始"),
        endLine: z.number().int().min(1).describe("结束行，含"),
      }),
      execute: async ({ path: input, startLine, endLine }) => {
        const resolved = resolvePath(input);
        if (!resolved.path) {
          record("readSource", { path: input }, `路径未命中：${input}`);
          return notFound(input, resolved.suggestions);
        }

        const lines = (index.contents.get(resolved.path) ?? "").split(/\r?\n/);
        const from = Math.max(1, Math.min(startLine, lines.length));
        // 越界不报错，夹紧到文件范围——模型对行数的估计经常偏大
        const to = Math.min(lines.length, Math.max(from, endLine), from + LIMITS.sourceLines - 1);

        record(
          "readSource",
          { path: resolved.path, startLine, endLine },
          `${resolved.path}:${from}-${to}`,
        );

        return {
          path: resolved.path,
          startLine: from,
          endLine: to,
          totalLines: lines.length,
          truncated: endLine > to ? `请求到第 ${endLine} 行，实际返回到第 ${to} 行` : undefined,
          source: lines.slice(from - 1, to).join("\n"),
        };
      },
    }),
  };

  return { tools, calls };
}

export type Toolset = ReturnType<typeof createTools>["tools"];
