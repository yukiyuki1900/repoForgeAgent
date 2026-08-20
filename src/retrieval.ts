import type { FileNode, RelationEdge, SymbolNode } from "./model.js";

export interface QueryPlan {
  concepts: string[];
  symbolKinds: string[];
  relationKinds: string[];
  terms: string[];
}

export interface RetrievalResult {
  path: string;
  symbol?: string;
  score: number;
  reasons: string[];
  relatedPaths: string[];
}

const CONCEPT_MAP: Record<string, string[]> = {
  登录: ["login", "auth", "authentication", "session", "signin"],
  用户: ["user", "account", "profile"],
  支付: ["pay", "payment", "order", "checkout"],
};

const TEXT_HIT_SCORE = 10;
const SYMBOL_HIT_SCORE = 25;
const RELATION_HIT_SCORE = 5;
const MAX_RESULTS = 30;

/**
 * 基于关键词映射的查询计划解析（规则实现）。
 *
 * LLM 版本见 llm.ts 的 parseQueryWithModel，目前尚未接入默认工作流。
 */
export function parseQueryPlan(query: string): QueryPlan {
  const synonyms = Object.entries(CONCEPT_MAP)
    .filter(([keyword]) => query.includes(keyword))
    .flatMap(([, values]) => values);

  const symbolKinds = query.includes("组件")
    ? ["component"]
    : query.includes("Hook")
      ? ["hook"]
      : ["component", "hook", "service", "store"];

  const relationKinds = query.includes("调用")
    ? ["call", "import", "uses-hook"]
    : ["import", "call", "render", "uses-hook", "uses-store"];

  return {
    concepts: [...new Set([query, ...synonyms])],
    symbolKinds,
    relationKinds,
    terms: query.toLowerCase().split(/\s+/).filter(Boolean),
  };
}

/**
 * 检索：文本命中 + 符号命中 + 依赖关系加权。
 *
 * 已知限制：文本命中目前是 substring 匹配，
 * 既没有查询 SQLite 的 FTS5 索引，也没有向量召回。
 */
export function hybridRetrieve(
  plan: QueryPlan,
  files: FileNode[],
  symbols: SymbolNode[],
  edges: RelationEdge[],
  contents: Map<string, string>,
): RetrievalResult[] {
  const byId = new Map(files.map((file) => [file.id, file]));
  const scores = new Map<string, RetrievalResult>();

  for (const file of files) {
    const text = `${file.path}\n${contents.get(file.path) ?? ""}`.toLowerCase();
    const matched = plan.concepts.filter((term) => text.includes(term.toLowerCase()));
    if (!matched.length) continue;

    scores.set(file.id, {
      path: file.path,
      score: matched.length * TEXT_HIT_SCORE,
      reasons: matched.map((term) => `文本命中：${term}`),
      relatedPaths: [],
    });
  }

  for (const symbol of symbols) {
    if (!plan.symbolKinds.includes(symbol.kind)) continue;
    const nameMatched = plan.concepts.some((term) =>
      symbol.name.toLowerCase().includes(term.toLowerCase()),
    );
    if (!nameMatched) continue;

    const result = scores.get(symbol.fileId) ?? {
      path: byId.get(symbol.fileId)?.path ?? symbol.fileId,
      score: 0,
      reasons: [],
      relatedPaths: [],
    };
    result.symbol = symbol.name;
    result.score += SYMBOL_HIT_SCORE;
    result.reasons.push(`符号命中：${symbol.kind}`);
    scores.set(symbol.fileId, result);
  }

  for (const edge of edges) {
    const result = scores.get(edge.from);
    if (!result || !plan.relationKinds.includes(edge.kind)) continue;

    const target = byId.get(edge.to)?.path;
    if (!target) continue;

    result.score += RELATION_HIT_SCORE;
    result.relatedPaths.push(target);
    result.reasons.push(`关系命中：${edge.kind}`);
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}
