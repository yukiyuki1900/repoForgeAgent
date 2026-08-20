import type { FileNode, Finding, RelationEdge } from "./model.js";

/**
 * 使用 Tarjan 强连通分量算法检测文件级循环依赖。
 *
 * 已知限制：当前依赖图只包含相对路径 import（见 graph.ts），
 * tsconfig paths alias 与 workspace 包间依赖尚未解析，
 * 因此在使用了 alias 的仓库上会存在漏检。
 */
export function analyzeCycles(files: FileNode[], edges: RelationEdge[]): Finding[] {
  const pathById = new Map(files.map((file) => [file.id, file.path]));
  const adjacency = new Map<string, string[]>(files.map((file) => [file.id, []]));
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    adjacency.get(edge.from)?.push(edge.to);
  }

  const findings: Finding[] = [];
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;

  const visit = (node: string): void => {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, index.get(next)!));
      }
    }

    // 只有强连通分量的根节点需要出栈收集整个分量
    if (lowLink.get(node) !== index.get(node)) return;

    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== node);

    // 单节点分量不构成环
    if (component.length < 2) return;

    const paths = component.map((id) => pathById.get(id) ?? id);
    findings.push({
      rule: "import-cycle",
      severity: "error",
      message: `发现 ${component.length} 个文件组成的循环依赖`,
      files: paths,
      evidence: [`${paths.join(" → ")} → ${paths[0]}`],
    });
  };

  for (const file of files) {
    if (!index.has(file.id)) visit(file.id);
  }

  return findings;
}

const REACT_FILE = /\.(tsx|jsx)$/;
const HOOK_CALL = /\buse[A-Z]\w*\s*\(/;
const CONDITIONAL_HOOK = /\b(if|for|while)\s*\([^)]*\)[^{]*\{[\s\S]*use[A-Z]/;
const LARGE_FILE_LINES = 500;

/**
 * 前端专项检查。
 *
 * 已知限制：当前基于正则匹配，存在误报与漏报，
 * 后续需要替换为 AST / ESLint 规则级别的判定。
 */
export function analyzeFrontend(contents: Map<string, string>): Finding[] {
  const findings: Finding[] = [];

  for (const [file, content] of contents) {
    if (REACT_FILE.test(file) && HOOK_CALL.test(content) && CONDITIONAL_HOOK.test(content)) {
      findings.push({
        rule: "react-hooks-condition",
        severity: "error",
        message: "疑似在条件分支中调用 Hook，请人工确认",
        files: [file],
      });
    }

    if (content.includes("eslint-disable") || content.includes("@ts-ignore")) {
      findings.push({
        rule: "lint-bypass",
        severity: "warning",
        message: "文件包含 lint/type 检查绕过指令",
        files: [file],
      });
    }

    if (content.split(/\r?\n/).length > LARGE_FILE_LINES) {
      findings.push({
        rule: "large-file",
        severity: "warning",
        message: `文件超过 ${LARGE_FILE_LINES} 行，建议拆分职责`,
        files: [file],
      });
    }
  }

  return findings;
}

export interface Metrics {
  score: number;
  dimensions: Record<string, number>;
}

/**
 * 维护性评分。
 *
 * 只统计当前真实计算出来的维度：
 * - complexity：文件平均圈复杂度（越低越好）
 * - coupling：文件平均出度（越低越好）
 * - typing：TypeScript 文件占比
 *
 * 重复代码率（duplication）与依赖健康度（dependencyHealth）尚未实现，
 * 因此不纳入评分——宁可少一个维度，也不要用占位常量拉高总分。
 */
export function calculateMetrics(files: FileNode[], edges: RelationEdge[]): Metrics {
  const fileCount = Math.max(files.length, 1);

  const totalComplexity = files.reduce((sum, file) => sum + file.complexity, 0);
  const averageComplexity = totalComplexity / fileCount;

  const outDegree = new Map<string, number>();
  for (const edge of edges) {
    outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
  }
  const totalOutDegree = [...outDegree.values()].reduce((sum, value) => sum + value, 0);
  const averageOutDegree = totalOutDegree / fileCount;

  const typedFiles = files.filter((file) => file.language.startsWith("ts")).length;

  const dimensions = {
    complexity: toScore(100 - averageComplexity * 5),
    coupling: toScore(100 - averageOutDegree * 10),
    typing: toScore((typedFiles / fileCount) * 100),
  };

  const values = Object.values(dimensions);
  const score = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

  return { score, dimensions };
}

function toScore(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}
