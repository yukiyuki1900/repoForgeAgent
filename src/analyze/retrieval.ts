import type { FileNode, RelationEdge, SymbolNode } from "../core/analysis.js";

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

/**
 * 中文业务概念到代码标识符的映射。
 *
 * 中文查询与英文代码之间没有天然的字面重合，没有这层映射就只能靠
 * 用户自己输入英文关键词。规则版覆盖常见前端业务概念，
 * 更长尾的表达交给 LLM 查询计划（见 llm.ts 的 parseQueryWithModel）。
 */
const CONCEPT_MAP: Record<string, string[]> = {
  登录: ["login", "auth", "authentication", "session", "signin"],
  注册: ["register", "signup", "registration"],
  权限: ["permission", "auth", "role", "acl", "guard"],
  用户: ["user", "account", "profile", "member"],
  支付: ["pay", "payment", "checkout", "cashier"],
  订单: ["order", "checkout", "purchase", "trade"],
  购物车: ["cart", "basket", "shopping"],
  商品: ["product", "goods", "item", "sku"],
  路由: ["router", "route", "navigation", "link"],
  状态: ["store", "state", "reducer", "atom", "context"],
  请求: ["request", "fetch", "axios", "http", "api"],
  搜索: ["search", "query", "filter", "keyword"],
  列表: ["list", "table", "grid", "collection"],
  详情: ["detail", "info", "profile"],
  表单: ["form", "field", "validate", "validation"],
  上传: ["upload", "file", "attachment"],
  弹窗: ["modal", "dialog", "popup", "drawer"],
  主题: ["theme", "style", "token", "palette"],
  国际化: ["i18n", "locale", "intl", "translation"],
  埋点: ["track", "report", "analytics", "beacon"],
};

/** 只表达查询意图、不指向代码的词，参与匹配只会引入噪音 */
const STOP_WORDS = new Set([
  "找",
  "查",
  "查找",
  "所有",
  "哪些",
  "有哪些",
  "处理",
  "相关",
  "组件",
  "页面",
  "函数",
  "方法",
  "代码",
  "文件",
  "模块",
  "逻辑",
  "地方",
  "使用",
  "用到",
  "调用",
  "这个",
  "那个",
  "什么",
  "怎么",
  "如何",
]);

/** 参与 substring 匹配的词长上限：整句查询丢进去必然零命中 */
const MAX_TERM_LENGTH = 12;
const CJK_GRAM_SIZE = 2;

const TEXT_HIT_SCORE = 10;
const SYMBOL_HIT_SCORE = 25;
const RELATION_HIT_SCORE = 5;
const MAX_RESULTS = 30;
const MAX_RELATED_PATHS = 8;
/** 关系加分的上限，防止 barrel 文件靠海量 re-export 霸榜 */
const MAX_RELATION_BONUS = 5;

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
    : query.includes("Hook") || query.includes("hook")
      ? ["hook"]
      : ["component", "hook", "function", "class", "variable"];

  const relationKinds = query.includes("调用")
    ? ["call", "import", "uses-hook"]
    : ["import", "call", "render", "uses-hook", "uses-store"];

  const terms = extractTerms(query);

  return {
    // 整句不参与匹配：源码里不可能出现「找所有处理订单的组件」这样的字符串
    concepts: [...new Set([...synonyms, ...terms])],
    symbolKinds,
    relationKinds,
    terms,
  };
}

/**
 * 从查询中抽取可用于匹配的词。
 *
 * 中文按空格切词切不出任何东西，所以对 CJK 部分做定长滑窗，
 * 再用停用词表滤掉「找 / 所有 / 组件」这类只表达意图的词。
 */
function extractTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const ascii = lower.match(/[a-z][a-z0-9_-]+/g) ?? [];

  const cjk: string[] = [];
  for (const segment of query.match(/[一-龥]+/g) ?? []) {
    if (segment.length <= CJK_GRAM_SIZE) {
      cjk.push(segment);
      continue;
    }
    for (let i = 0; i + CJK_GRAM_SIZE <= segment.length; i += 1) {
      cjk.push(segment.slice(i, i + CJK_GRAM_SIZE));
    }
  }

  return [...new Set([...ascii, ...cjk])].filter(
    (term) => term.length <= MAX_TERM_LENGTH && !STOP_WORDS.has(term),
  );
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

  // 关系命中先聚合再计分：barrel index 文件动辄几百条 re-export，
  // 逐条加分会让它霸榜，逐条写 reason 还会产出成百上千条重复文案
  const relationHits = new Map<string, Map<string, number>>();

  for (const edge of edges) {
    const result = scores.get(edge.from);
    if (!result || !plan.relationKinds.includes(edge.kind)) continue;

    const target = byId.get(edge.to)?.path;
    if (!target) continue;

    const kinds = relationHits.get(edge.from) ?? new Map<string, number>();
    kinds.set(edge.kind, (kinds.get(edge.kind) ?? 0) + 1);
    relationHits.set(edge.from, kinds);

    if (result.relatedPaths.length < MAX_RELATED_PATHS && !result.relatedPaths.includes(target)) {
      result.relatedPaths.push(target);
    }
  }

  for (const [fileId, kinds] of relationHits) {
    const result = scores.get(fileId);
    if (!result) continue;

    let total = 0;
    for (const [kind, count] of kinds) {
      total += count;
      result.reasons.push(count > 1 ? `关系命中：${kind} × ${count}` : `关系命中：${kind}`);
    }
    result.score += Math.min(total, MAX_RELATION_BONUS) * RELATION_HIT_SCORE;
  }

  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}
