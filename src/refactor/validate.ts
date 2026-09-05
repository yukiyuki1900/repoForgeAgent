import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import {
  isPureExpression,
  locateAnyDeclaration,
  locateExportedStatement,
} from "../analyze/deadexports.js";
import { isWholeFileDead, type ProposalCandidate, type ProposalFacts } from "../analyze/facts.js";
import { openSemanticProject, type SemanticProject } from "../scan/graph.js";
import type { FileNode } from "../core/model.js";
import type { Proposal } from "./propose.js";

/**
 * 模型输出之后、给人看之前的静态校验。
 *
 * **模型编一个不存在的符号名是常态，不是异常。** 这一层是幻觉的主要防线：
 * 逐条对着 AST 和检测结果核对，任何一项不过就整条丢弃。
 *
 * 核心思路是**不采信模型说的任何一个事实**——符号存不存在、引用有几处、
 * 文件有没有人 import，全部重新查一遍。模型贡献的只有「该不该动、怎么动」
 * 这个判断，其余一切都要能被独立验证。
 *
 * ## 关于 prediction 的一个反直觉设计
 *
 * 确定性代码其实**能自己算出** `exportsRemoved` 应该是多少，那还要模型预测干什么？
 *
 * 因为预测的用途不是告诉我们答案，而是**检测模型有没有真正理解自己提的方案**。
 * 算出来的期望值与模型的预测不一致，说明它对自己的 operations 会产生什么效果
 * 判断错了——这种方案哪怕碰巧能执行成功，也不该采纳。
 *
 * 于是形成两道对账，防的是两件不同的事：
 *
 * ```
 * C3（这里）   模型预测  vs  静态计算的期望值   → 模型理解偏差
 * C4（执行后） 静态计算  vs  重扫仓库的实测值   → 执行偏差
 * ```
 */

export interface RejectedProposal {
  proposal: Proposal;
  reason: string;
}

export interface AdjustedProposal {
  proposal: Proposal;
  field: string;
  from: string;
  to: string;
  why: string;
}

export interface ValidationResult {
  accepted: Proposal[];
  /** 被丢弃的方案及原因。不给人看，但要可查——判据可以被质疑，不能是隐形的 */
  rejected: RejectedProposal[];
  /** 被强制改写的字段，同样留痕 */
  adjusted: AdjustedProposal[];
}

export function validateProposals(input: {
  proposals: Proposal[];
  facts: ProposalFacts;
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  semantic?: SemanticProject;
}): ValidationResult {
  const { proposals, facts, root, files, contents } = input;
  const semantic = input.semantic ?? openSemanticProject(root, files, contents);

  const sourceByPath = new Map(semantic.parsed.map((item) => [item.file.path, item.source]));
  const candidateByKey = new Map(
    facts.candidates.map((item) => [`${item.file}#${item.symbol}`, item]),
  );

  const accepted: Proposal[] = [];
  const rejected: RejectedProposal[] = [];
  const adjusted: AdjustedProposal[] = [];
  /** 已被前面的方案占用的符号，避免两条方案改同一处 */
  const claimed = new Set<string>();

  for (const proposal of proposals) {
    const reason = check(proposal, {
      facts,
      sourceByPath,
      candidateByKey,
      claimed,
      adjusted,
    });

    if (reason) {
      rejected.push({ proposal, reason });
      continue;
    }

    for (const operation of proposal.operations) {
      claimed.add(`${operation.file}#${operation.symbol}`);
    }
    accepted.push(proposal);
  }

  return { accepted, rejected, adjusted };
}

interface CheckContext {
  facts: ProposalFacts;
  sourceByPath: Map<string, SourceFile>;
  candidateByKey: Map<string, ProposalCandidate>;
  claimed: Set<string>;
  adjusted: AdjustedProposal[];
}

/** 返回拒绝原因；返回 undefined 表示通过 */
function check(proposal: Proposal, context: CheckContext): string | undefined {
  const { facts, sourceByPath, candidateByKey, claimed } = context;

  // ── 1. 目标必须来自候选清单 ────────────────────────
  // 模型自己"发现"的死导出一律不采信：那些符号没有经过引用分析，
  // 它看不到真实的引用情况，只是在猜
  const candidate = candidateByKey.get(`${proposal.targetFile}#${proposal.targetSymbol}`);
  if (!candidate) {
    return `目标 ${proposal.targetFile}#${proposal.targetSymbol} 不在候选清单里`;
  }

  // ── 2. operations 的形状要与 kind 相符 ─────────────
  const shape = checkShape(proposal);
  if (shape) return shape;

  // ── 3. 每条 operation 的目标都要真实存在 ───────────
  for (const operation of proposal.operations) {
    const source = sourceByPath.get(operation.file);
    if (!source) return `文件 ${operation.file} 不在本次扫描结果里`;

    if (operation.op === "delete-file") continue;

    if (!operation.symbol) return `${operation.op} 缺少符号名`;
    if (
      !locateExportedStatement(source, operation.symbol) &&
      !locateAnyDeclaration(source, operation.symbol)
    ) {
      return `${operation.file} 里找不到符号 ${operation.symbol}`;
    }

    const key = `${operation.file}#${operation.symbol}`;
    if (claimed.has(key)) return `${key} 已被前一条方案占用`;
  }

  // ── 4. 按 kind 做各自的硬前置 ──────────────────────
  const specific = checkByKind(proposal, candidate, sourceByPath);
  if (specific) return specific;

  // ── 5. 预测必须与静态计算出的期望值一致 ─────────────
  const expected = expectedExportsRemoved(proposal, sourceByPath);
  if (expected === undefined) return "无法静态推算这个方案的效果";
  if (proposal.prediction.exportsRemoved !== expected) {
    return `预测导出减少 ${proposal.prediction.exportsRemoved} 个，静态推算应为 ${expected} 个`;
  }

  const expectedFiles = proposal.kind === "delete-file" ? 1 : 0;
  if (proposal.prediction.filesRemoved !== expectedFiles) {
    return `预测删除 ${proposal.prediction.filesRemoved} 个文件，实际应为 ${expectedFiles} 个`;
  }

  // ── 6. 风险等级强制 ────────────────────────────────
  // 「这个副作用不重要」不是编译器能判定的事，模型说 low 也不行
  if (proposal.kind === "delete-with-dependencies" && proposal.risk !== "high") {
    context.adjusted.push({
      proposal,
      field: "risk",
      from: proposal.risk,
      to: "high",
      why: "连带删除会改变运行时行为，无法用编译器证明等价",
    });
    proposal.risk = "high";
  }

  void facts;
  return undefined;
}

/** operations 的组成必须与声明的 kind 对得上，否则就是模型自己都没想清楚 */
function checkShape(proposal: Proposal): string | undefined {
  const ops = proposal.operations;

  if (proposal.kind === "delete-file") {
    if (ops.length !== 1 || ops[0].op !== "delete-file") {
      return "delete-file 方案只能包含一条 delete-file 指令";
    }
    if (ops[0].file !== proposal.targetFile) {
      return "delete-file 的目标文件与方案声明的不一致";
    }
    return undefined;
  }

  if (ops.some((operation) => operation.op === "delete-file")) {
    return `${proposal.kind} 方案里不应出现 delete-file 指令`;
  }

  if (proposal.kind === "delete-with-dependencies" && ops.length < 2) {
    return "delete-with-dependencies 至少要有两条指令（目标 + 被连带的私有声明）";
  }

  return undefined;
}

function checkByKind(
  proposal: Proposal,
  candidate: ProposalCandidate,
  sourceByPath: Map<string, SourceFile>,
): string | undefined {
  if (proposal.kind === "delete-file") {
    // 三个前置全部重新查一遍，不看模型怎么说
    if (!isWholeFileDead(candidate)) {
      const why: string[] = [];
      if (candidate.fileInboundCount > 0)
        why.push(`被 ${candidate.fileInboundCount} 个文件 import`);
      if (candidate.fileHasTopLevelSideEffects) why.push("顶层有副作用语句");
      if (candidate.siblingExports.dead < candidate.siblingExports.total) {
        why.push(
          `${candidate.siblingExports.total} 个导出里只有 ${candidate.siblingExports.dead} 个是死的`,
        );
      }
      return `${proposal.targetFile} 不满足删除整个文件的前提：${why.join("、") || "未知"}`;
    }
    return undefined;
  }

  if (proposal.kind === "unexport-symbol") {
    for (const operation of proposal.operations) {
      if (operation.op !== "delete-declaration") continue;

      const source = sourceByPath.get(operation.file);
      const node = source && locateExportedStatement(source, operation.symbol);

      // 删除前要确认初始化表达式没有副作用。
      // 这条不因为模型论证得多好就放行——它和 A2 用的是同一个判据
      if (node && Node.isVariableDeclaration(node) && !isPureExpression(node.getInitializer())) {
        return `${operation.symbol} 的初始化表达式可能有副作用，不能删除声明`;
      }
    }
    return undefined;
  }

  // ── delete-with-dependencies ───────────────────────
  //
  // 这一类的目标**按定义**就是初始化不纯的（`export const registered = register()`），
  // 纯度判据在这里不适用——否则这个 kind 根本不会存在。
  // 换成两条更硬的：连带符号必须是私有的，且**唯一那处引用就在目标声明内部**。
  //
  // 只数"引用恰为 1"是不够的：一个在别处被用了一次的符号同样能凑出 1。
  // 必须确认那一处就落在要删的目标里，删掉目标之后它才真的没人用了。
  const [head, ...dependencies] = proposal.operations;
  const targetSource = sourceByPath.get(head.file);
  const targetNode = targetSource && locateExportedStatement(targetSource, head.symbol);
  if (!targetNode) return `${head.file} 里找不到导出的 ${head.symbol}`;

  const targetStatement =
    targetNode.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? targetNode;
  const [start, end] = [targetStatement.getStart(), targetStatement.getEnd()];

  for (const operation of dependencies) {
    const source = sourceByPath.get(operation.file);
    if (!source) continue;

    if (locateExportedStatement(source, operation.symbol)) {
      return `${operation.symbol} 是导出符号，不能作为连带删除的私有依赖`;
    }

    const local = locateAnyDeclaration(source, operation.symbol);
    if (!local) return `${operation.file} 里找不到 ${operation.symbol}`;

    const references = countAllReferences(local);
    if (references === undefined) return `无法分析 ${operation.symbol} 的引用`;
    if (references.length !== 1) {
      return `${operation.symbol} 被引用 ${references.length} 处，不是只被目标符号使用，不能连带删除`;
    }

    const only = references[0];
    if (operation.file !== head.file || only.getStart() < start || only.getEnd() > end) {
      return `${operation.symbol} 唯一的引用不在 ${head.symbol} 的声明内部，不能连带删除`;
    }
  }

  return undefined;
}

/**
 * 静态推算这个方案会让具名导出减少几个。
 *
 * 只数**导出**符号：连带删除的私有声明不影响导出总数，
 * 而 unexport 与 delete-declaration 各让一个导出消失。
 */
function expectedExportsRemoved(
  proposal: Proposal,
  sourceByPath: Map<string, SourceFile>,
): number | undefined {
  if (proposal.kind === "delete-file") {
    const source = sourceByPath.get(proposal.targetFile);
    if (!source) return undefined;
    return countNamedExports(source);
  }

  let count = 0;
  for (const operation of proposal.operations) {
    const source = sourceByPath.get(operation.file);
    if (!source) return undefined;
    if (locateExportedStatement(source, operation.symbol)) count += 1;
  }
  return count;
}

/** 全仓引用节点，不含声明自身 */
function countAllReferences(node: Node): Node[] | undefined {
  const nameNode = Node.isVariableDeclaration(node)
    ? node.getNameNode()
    : (node as { getNameNode?: () => Node | undefined }).getNameNode?.();

  const identifier = nameNode?.asKind(SyntaxKind.Identifier);
  if (!identifier) return undefined;

  try {
    return identifier.findReferencesAsNodes().filter((reference) => reference !== identifier);
  } catch {
    return undefined;
  }
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

/** 供 CLI / 界面展示被拦下的方案 */
export function formatValidation(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.rejected.length > 0) {
    lines.push(`${result.rejected.length} 条方案未通过静态校验：`);
    for (const item of result.rejected) {
      lines.push(`  ${item.proposal.targetFile}#${item.proposal.targetSymbol}  ${item.reason}`);
    }
  }

  if (result.adjusted.length > 0) {
    lines.push("", `${result.adjusted.length} 处字段被强制改写：`);
    for (const item of result.adjusted) {
      lines.push(
        `  ${item.proposal.targetFile}#${item.proposal.targetSymbol}  ` +
          `${item.field}: ${item.from} → ${item.to}（${item.why}）`,
      );
    }
  }

  return lines.join("\n");
}
