import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import {
  analyzeDeadExports,
  locateExportedStatement,
  planDeadExportRemoval,
  type DeadExportKind,
} from "./deadexports.js";
import { openSemanticProject, type SemanticProject } from "./graph.js";
import { extractGraph } from "./graph.js";
import type { FileNode } from "./model.js";

/**
 * 给模型的事实包。
 *
 * 前两条改造链路里模型参与度是零——那些判断确定性代码能做。这里收集的是
 * **规则主动放弃的那部分**：检出了但不敢动的、被规则排除的、只被测试引用的。
 * 详见 `docs/PROPOSAL.md`。
 *
 * 三条硬约束，全部来自已经踩过的坑：
 *
 * 1. **必须带声明源码**。不给源码，模型只能靠符号名猜——那正是这套工具要取代的做法。
 * 2. **必须带工具拒绝的确切原因**。模型的任务是针对这个原因论证，而不是重新判断一遍。
 * 3. **截断必须写进上下文**。静默截断会让模型把「前 30 条」当成全部，
 *    然后给出一个自信的错误结论。工具层为这件事付过一次代价。
 */

/** 候选来自哪一堆——决定了模型该往哪个方向论证 */
export type CandidateOrigin =
  /** 检出是死导出，但清理阶段不敢动 */
  | "blocked"
  /** 只被测试文件引用 */
  | "test-only"
  /** 检测阶段就被规则排除，压根没进死导出清单 */
  | "excluded";

export interface ProposalCandidate {
  origin: CandidateOrigin;
  file: string;
  symbol: string;
  line: number;
  kind: DeadExportKind;
  /** 声明的源码，模型判断的主要依据 */
  declarationText: string;
  /** 被截断掉的行数，为 0 表示完整 */
  declarationOmittedLines: number;
  /** 工具拒绝或排除它的确切原因 */
  whyToolRefused: string;
  /** 同文件内还有几处在用它。为 0 才可能整条删除 */
  internalReferences: number;
  /** 这个文件被几个文件 import。为 0 是删掉整个文件的前提 */
  fileInboundCount: number;
  /** 同文件的导出存活情况 */
  siblingExports: { total: number; dead: number };
  /** 文件顶层有没有副作用语句。有就不能删整个文件 */
  fileHasTopLevelSideEffects: boolean;
}

export interface ProposalFacts {
  root: string;
  candidates: ProposalCandidate[];
  /** 截断前的候选总数 */
  totalCandidates: number;
  /** 因为超出上限而没有交给模型的数量 */
  omittedCandidates: number;
  /** 全仓具名导出总数，作为预测的对账基数 */
  totalExports: number;
  /** 工具已经自动处理掉的数量，用于说明「模型不必碰这些」 */
  autoHandled: number;
}

/** 单个符号最多给多少行源码 */
const MAX_DECLARATION_LINES = 40;
/** 最多交给模型多少个候选 */
const MAX_CANDIDATES = 30;
const CHARS_PER_TOKEN = 3;

export function collectProposalFacts(input: {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  semantic?: SemanticProject;
}): ProposalFacts {
  const { root, files, contents } = input;
  const semantic = input.semantic ?? openSemanticProject(root, files, contents);

  const detection = analyzeDeadExports({ root, files, contents, semantic });
  const plan = planDeadExportRemoval({ root, files, contents, semantic });

  // 入边数用于判断「删掉整个文件安不安全」。这里重建一次依赖图——
  // 调用方通常已经有 edges，但让 facts 自给自足能少一个必须按顺序调用的约束
  const { edges } = extractGraph(root, files, contents);
  const idByPath = new Map(files.map((file) => [file.path, file.id]));
  const inbound = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  const sourceByPath = new Map(semantic.parsed.map((item) => [item.file.path, item.source]));

  // 同文件的导出存活情况：模型判断「这个文件是不是整个都该删」要看这个
  const deadPerFile = new Map<string, number>();
  for (const item of detection.dead) {
    deadPerFile.set(item.file, (deadPerFile.get(item.file) ?? 0) + 1);
  }
  const exportsPerFile = new Map<string, number>();
  for (const [path, source] of sourceByPath) {
    exportsPerFile.set(path, countNamedExports(source));
  }

  const raw: ProposalCandidate[] = [];

  const push = (
    origin: CandidateOrigin,
    item: { file: string; symbol: string; line: number; kind: DeadExportKind },
    why: string,
    internalReferences: number,
  ): void => {
    const source = sourceByPath.get(item.file);
    if (!source) return;

    const declaration = describeDeclaration(source, item.symbol);
    raw.push({
      origin,
      file: item.file,
      symbol: item.symbol,
      line: item.line,
      kind: item.kind,
      declarationText: declaration.text,
      declarationOmittedLines: declaration.omitted,
      whyToolRefused: why,
      internalReferences,
      fileInboundCount: inbound.get(idByPath.get(item.file) ?? "") ?? 0,
      siblingExports: {
        total: exportsPerFile.get(item.file) ?? 0,
        dead: deadPerFile.get(item.file) ?? 0,
      },
      fileHasTopLevelSideEffects: hasTopLevelSideEffects(source),
    });
  };

  const deadByKey = new Map(detection.dead.map((item) => [`${item.file}#${item.symbol}`, item]));

  for (const item of plan.blocked) {
    const dead = deadByKey.get(`${item.file}#${item.symbol}`);
    push("blocked", item, item.reason, dead?.usedInFile ? 1 : 0);
  }
  for (const item of detection.testOnly) {
    push("test-only", item, "只被测试文件引用，生产代码里没有引用者", item.usedInFile ? 1 : 0);
  }
  for (const item of detection.excluded) {
    push("excluded", item, item.reason, 0);
  }

  const ranked = raw.sort(compareCandidates);

  return {
    root,
    candidates: ranked.slice(0, MAX_CANDIDATES),
    totalCandidates: ranked.length,
    omittedCandidates: Math.max(0, ranked.length - MAX_CANDIDATES),
    totalExports: detection.totalExports,
    autoHandled: plan.edits.length,
  };
}

/**
 * 排序：越可能被安全处理的越靠前。
 *
 * 截断发生在排序之后，所以这个顺序决定了「被砍掉的是哪些」。
 * 依据只用确定性事实，不做主观加权：
 *
 * 1. 整个文件都死透了（入边为 0、导出全死、顶层无副作用）——最干净的一类
 * 2. 已经确认是死导出（blocked / test-only），只是清理阶段不敢动
 * 3. 被规则排除的，其中入口文件的排最后——它们最可能真的是对外 API
 */
function compareCandidates(a: ProposalCandidate, b: ProposalCandidate): number {
  const score = (item: ProposalCandidate): number => {
    let value = 0;
    if (isWholeFileDead(item)) value += 100;
    if (item.origin === "blocked") value += 40;
    else if (item.origin === "test-only") value += 30;
    if (item.fileInboundCount === 0) value += 10;
    if (item.whyToolRefused.includes("入口文件")) value -= 20;
    return value;
  };

  return score(b) - score(a) || a.file.localeCompare(b.file) || a.line - b.line;
}

/** 这个文件的导出是不是全死了，且删掉它不会有连带影响 */
export function isWholeFileDead(item: ProposalCandidate): boolean {
  return (
    item.siblingExports.total > 0 &&
    item.siblingExports.dead === item.siblingExports.total &&
    item.fileInboundCount === 0 &&
    !item.fileHasTopLevelSideEffects
  );
}

/** 取声明全文，超长截断并如实报出少了多少行 */
function describeDeclaration(
  source: SourceFile,
  symbol: string,
): { text: string; omitted: number } {
  const node = locateExportedStatement(source, symbol);
  if (!node) return { text: "", omitted: 0 };

  // 变量声明本身不含 `export` 与 `const`，要往上取到整条语句才是人能读的样子
  const printable = Node.isVariableDeclaration(node)
    ? (node.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? node)
    : node;

  const lines = printable.getText().split(/\r?\n/);
  if (lines.length <= MAX_DECLARATION_LINES) return { text: lines.join("\n"), omitted: 0 };

  const omitted = lines.length - MAX_DECLARATION_LINES;
  return {
    text: [...lines.slice(0, MAX_DECLARATION_LINES), `// …省略 ${omitted} 行`].join("\n"),
    omitted,
  };
}

/**
 * 文件顶层有没有会执行的语句。
 *
 * 声明（函数、类、接口、类型、枚举、变量）与 import/export 语句不执行任何东西，
 * 其余顶层语句——表达式语句、IIFE、循环、条件——都会在模块加载时求值，
 * 删掉整个文件就等于删掉这些副作用。
 */
function hasTopLevelSideEffects(source: SourceFile): boolean {
  return source.getStatements().some((statement) => {
    if (
      Node.isFunctionDeclaration(statement) ||
      Node.isClassDeclaration(statement) ||
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement) ||
      Node.isVariableStatement(statement) ||
      Node.isImportDeclaration(statement) ||
      Node.isExportDeclaration(statement) ||
      Node.isModuleDeclaration(statement)
    ) {
      return false;
    }
    return true;
  });
}

function countNamedExports(source: SourceFile): number {
  let count = 0;
  for (const statement of source.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      if (statement.isExported()) count += statement.getDeclarations().length;
      continue;
    }
    if (
      (Node.isFunctionDeclaration(statement) ||
        Node.isClassDeclaration(statement) ||
        Node.isInterfaceDeclaration(statement) ||
        Node.isTypeAliasDeclaration(statement) ||
        Node.isEnumDeclaration(statement)) &&
      statement.isExported()
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * 渲染成给模型的上下文文本。
 *
 * 用 Markdown 而不是 JSON：同样的信息，JSON 里源码要整段转义，
 * 换行变成 `\n`、引号变成 `\"`，既占 token 又难读。
 */
export function renderProposalFacts(facts: ProposalFacts): string {
  const lines: string[] = [
    "# 待判断的导出",
    "",
    `仓库共 ${facts.totalExports} 个具名导出。其中 ${facts.autoHandled} 个已由确定性规则自动处理，无需你参与。`,
    "",
    `以下 ${facts.candidates.length} 个是**规则主动放弃**的部分——工具检出了问题但不敢动，或者压根没把它们算作死代码。`,
  ];

  // 截断必须说出来：让模型把「前 30 条」当成全部，会直接导致「其余都还在用」这种错误结论
  if (facts.omittedCandidates > 0) {
    lines.push(
      "",
      `⚠️ 候选共 ${facts.totalCandidates} 个，这里只列出最可能可处理的 ${facts.candidates.length} 个，` +
        `**另有 ${facts.omittedCandidates} 个未列出**。不要据此判断「其余导出都还在用」。`,
    );
  }

  const originLabel: Record<CandidateOrigin, string> = {
    blocked: "已确认是死导出，但清理阶段不敢动",
    "test-only": "只被测试引用",
    excluded: "被规则排除，未算作死代码",
  };

  for (const [index, item] of facts.candidates.entries()) {
    lines.push(
      "",
      `## ${index + 1}. \`${item.symbol}\` — ${item.file}:${item.line}`,
      "",
      `- 分类：${originLabel[item.origin]}`,
      `- 工具的理由：${item.whyToolRefused}`,
      `- 同文件内引用：${item.internalReferences} 处`,
      `- 该文件被 ${item.fileInboundCount} 个文件 import`,
      `- 该文件共 ${item.siblingExports.total} 个导出，其中 ${item.siblingExports.dead} 个已判定为死`,
      `- 该文件顶层${item.fileHasTopLevelSideEffects ? "**有**" : "无"}副作用语句`,
    );

    if (isWholeFileDead(item)) {
      lines.push("- ✅ 整个文件的导出全部死亡、无人 import、顶层无副作用");
    }

    if (item.declarationText) {
      lines.push("", "```ts", item.declarationText, "```");
    }
    if (item.declarationOmittedLines > 0) {
      lines.push(`> 声明过长，已省略 ${item.declarationOmittedLines} 行`);
    }
  }

  return lines.join("\n");
}

export function estimateFactsTokens(facts: ProposalFacts): number {
  return Math.ceil(renderProposalFacts(facts).length / CHARS_PER_TOKEN);
}
