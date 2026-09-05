import type { FileNode, Finding, RelationEdge } from "../core/model.js";

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

  const collectComponent = (root: string): void => {
    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== root);

    // 单节点分量不构成环
    if (component.length < 2) return;

    const paths = component.map((id) => pathById.get(id) ?? id);
    // component 是 Tarjan 的出栈顺序，相邻两项之间未必真有边，
    // 不能直接当成环路径展示——要在分量内搜一条真实回路
    const loop = findLoop(component, adjacency);

    findings.push({
      rule: "import-cycle",
      severity: "error",
      message: `发现 ${component.length} 个文件组成的循环依赖`,
      files: paths,
      evidence: loop
        ? [
            `${loop.map((id) => pathById.get(id) ?? id).join(" → ")} → ${pathById.get(loop[0]) ?? loop[0]}`,
          ]
        : [`强连通分量成员：${paths.join("、")}`],
    });
  };

  // 显式维护 DFS 栈而非递归：递归版本在万级文件的长依赖链上会
  // Maximum call stack size exceeded，而这正是本工具的目标仓库规模
  for (const file of files) {
    if (index.has(file.id)) continue;

    const frames: Array<{ node: string; cursor: number }> = [{ node: file.id, cursor: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];

      // cursor 为 0 表示首次进入该节点
      if (frame.cursor === 0 && !index.has(frame.node)) {
        index.set(frame.node, counter);
        lowLink.set(frame.node, counter);
        counter += 1;
        stack.push(frame.node);
        onStack.add(frame.node);
      }

      if (frame.cursor < neighbors.length) {
        const next = neighbors[frame.cursor];
        frame.cursor += 1;

        if (!index.has(next)) {
          frames.push({ node: next, cursor: 0 });
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, index.get(next)!));
        }
        continue;
      }

      // 邻居遍历完毕，回溯并把 lowLink 汇报给父节点
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node)!, lowLink.get(frame.node)!));
      }

      if (lowLink.get(frame.node) === index.get(frame.node)) {
        collectComponent(frame.node);
      }
    }
  }

  return findings;
}

/**
 * 在强连通分量内用 BFS 找一条真实存在的最短回路。
 *
 * 分量成员列表回答「哪些文件纠缠在一起」，回路才回答「沿着哪几条 import 转了一圈」，
 * 后者才是能直接拿去改的线索，也是喂给 LLM 时必须保证真实的部分。
 */
function findLoop(component: string[], adjacency: Map<string, string[]>): string[] | undefined {
  const inComponent = new Set(component);
  const start = component[0];
  const previous = new Map<string, string>();
  const visited = new Set<string>([start]);
  const queue: string[] = [start];

  while (queue.length > 0) {
    const node = queue.shift()!;

    for (const next of adjacency.get(node) ?? []) {
      if (!inComponent.has(next)) continue;

      if (next === start) {
        const loop = [node];
        let cursor = node;
        while (previous.has(cursor)) {
          cursor = previous.get(cursor)!;
          loop.push(cursor);
        }
        return loop.reverse();
      }

      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }

  return undefined;
}

/*
 * 这里曾经有一个 `analyzeFrontend`：三条正则规则——条件分支里调 Hook、
 * 文件含 eslint-disable、文件超过 500 行。
 *
 * 删掉它是因为三条都站不住：第一条用正则判断控制流必然误报，ESLint 的
 * `react-hooks/rules-of-hooks` 走 AST 做得准得多；后两条与「前端」毫无关系，
 * 任何语言的任何仓库都能报出一堆，属于凑数的噪声。
 *
 * 它在流水线里的位置由 `deadExports` 节点接手——同样是并行分析器之一，
 * 但判定基于 TypeScript 的引用分析，结论可以被验证、被改造、被回滚。
 * 宁可少一个卖点，也不留一个经不起看的实现。
 */

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
  // 没有可分析的文件时不要凭空造分：此前会因为
  // complexity/coupling 各拿满分而给出 67 分的「健康」空仓库
  if (files.length === 0) return { score: 0, dimensions: {} };

  const fileCount = files.length;

  const totalComplexity = files.reduce((sum, file) => sum + file.complexity, 0);
  const averageComplexity = totalComplexity / fileCount;

  // 只统计 import 边：render 边描述的是渲染关系而非模块耦合，
  // 混进来会让耦合度与报告其它位置的口径对不上
  const outDegree = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
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
