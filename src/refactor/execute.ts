import fs from "node:fs";
import path from "node:path";
import type { ApplyStatus } from "./apply.js";
import {
  analyzeDeadExports,
  locateAnyDeclaration,
  locateExportedStatement,
} from "../analyze/deadexports.js";
import { openSemanticProject } from "../scan/graph.js";
import type { FileNode } from "../core/analysis.js";
import { remove, unexport } from "./prune.js";
import type { Proposal } from "./propose.js";
import { scanFiles } from "../scan/scanner.js";
import {
  captureDiff,
  collectDiagnostics,
  introducedSince,
  preflight,
  rollback,
  writeArtifacts,
  type DiagnosticNote,
} from "./verify.js";

/**
 * 执行一条**已经通过 C3 静态校验**的方案，并对账。
 *
 * 这是第三条走完整条链路的改造，模板和前两条一字不差：
 * 算出事实 → 判断能不能安全改 → 改 → 用确定性代码验证 → 不符就整体回滚。
 *
 * 三条链路的区别只在第二层验证拿什么对账：
 *
 * ```
 * import type 破环   环数      改完应该剩几个环
 * 死导出清理         导出总数   改完应该剩多少个具名导出
 * 模型提的方案       导出总数 + 文件数   由方案自带的 prediction 给出
 * ```
 *
 * 前两条的预测由确定性代码算出，这一条的预测**来自模型**——但它在 C3
 * 已经跟静态推算值核对过一次了。所以这里对的是另一件事：
 *
 * ```
 * C3   模型预测   vs  静态计算的期望值   →  模型理解偏差
 * C4   静态计算   vs  重扫仓库的实测值   →  执行偏差
 * ```
 *
 * ## 两个刻意的缺席
 *
 * **没有沙箱。** 改动直接落在工作区，安全性由 git 门禁提供：目标文件必须
 * 已被跟踪且无未提交改动，否则拒绝执行；验证不过就 `git checkout --` 整体还原。
 * 这不等于沙箱隔离——真正的隔离还在 `LIMITATIONS.md` 的路线图上，
 * 说成沙箱只会在第一个追问里露馅。
 *
 * **没有 `--apply`。** 前两条链路提供了全自动执行，因为那是规则判定安全的
 * 机械变换。这一条改的正是**工具判定为不安全**的那些东西——工具主动放弃了
 * 那些判断，不能因为「模型说可以」就把它们变回自动。人必须先看到方案、
 * 预测和风险等级，选中一条，才执行这一条。
 */

export interface ProposalExecution {
  status: ApplyStatus;
  proposal: Proposal;
  /** 实际落到 AST 上的指令数。少于 operations 说明有符号没能重新定位 */
  applied: number;
  typecheck?: {
    baselineErrors: number;
    afterErrors: number;
    introduced: DiagnosticNote[];
    elapsedMs: number;
  };
  exports?: {
    before: number;
    /** before - prediction.exportsRemoved */
    predicted: number;
    /** 写入后重新扫描的实测值 */
    actual: number;
  };
  files?: {
    predicted: number;
    actual: number;
    /** 预期被删、但磁盘上还在的 */
    survived: string[];
  };
  outputDir?: string;
  diffPath?: string;
  reportPath?: string;
  reason?: string;
}

export interface ExecuteOptions {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  /** 必须是 validateProposals 返回的 accepted 里的一条 */
  proposal: Proposal;
  onStep?: (message: string) => void;
}

export async function applyProposal(options: ExecuteOptions): Promise<ProposalExecution> {
  const { root, files, contents, proposal } = options;
  const step = options.onStep ?? (() => {});

  const targets = [...new Set(proposal.operations.map((operation) => operation.file))].sort();

  const guard = preflight(root, targets);
  if (!guard.ok) {
    return { status: "aborted", proposal, applied: 0, reason: guard.reason };
  }
  step(`前置检查通过：${targets.length} 个目标文件均已被 git 跟踪且无未提交改动`);

  const semantic = openSemanticProject(root, files, contents);
  const exportsBefore = analyzeDeadExports({ root, files, contents }).totalExports;

  // ── 第一层验证：类型 ────────────────────────────────
  const typeStart = Date.now();
  const baseline = collectDiagnostics(semantic.project);
  step(`类型基线：${baseline.total} 条已有错误`);

  const touched = new Map<string, string>();
  const deleted: string[] = [];
  let applied = 0;

  for (const operation of proposal.operations) {
    const parsed = semantic.parsed.find((item) => item.file.path === operation.file);
    if (!parsed) {
      return {
        status: "aborted",
        proposal,
        applied,
        reason: `${operation.file} 不在解析结果里，放弃执行`,
      };
    }

    if (operation.op === "delete-file") {
      // 在内存里把它换成一个什么都不导出的模块，让类型检查回答
      // 「还有人在用这个文件的导出吗」。磁盘上的删除留到写入阶段——
      // 类型没过就一个字节都不该动。
      //
      // 第一版这里写的是 `project.removeSourceFile()`，**那是无效的**：
      // Project 建在真实文件系统上，从项目里移掉之后 TypeScript 仍会顺着
      // import 从磁盘把它读回来当依赖，于是删一个正被 import 的文件也能
      // 一路绿灯通过类型检查。是端到端用例把这个洞挖出来的。
      //
      // 已知缺口：`import "./config"` 这种纯副作用导入，换成空模块不会报错，
      // 只有文件真的消失才会。这一类由 `isWholeFileDead` 的入边检查兜底
      // （入边不为 0 就不允许删整个文件），这里不重复实现。
      parsed.source.replaceWithText("export {};\n");
      deleted.push(operation.file);
      applied += 1;
      continue;
    }

    // 每条改动前重新定位：上一条删除会让后面的语句整体上移，
    // 缓存下来的节点引用与行号都不再可靠
    // 连带删除的目标是非导出的私有声明，先试导出的，再退回任意顶层声明
    const node =
      locateExportedStatement(parsed.source, operation.symbol) ??
      locateAnyDeclaration(parsed.source, operation.symbol);

    if (!node) {
      // C3 查过它存在，到这里还找不到，说明前一条指令把它一起带走了。
      // 这属于方案内部自相矛盾，整条放弃而不是跳过——
      // 半条执行成功的方案，它的 prediction 就不再有意义
      return {
        status: "aborted",
        proposal,
        applied,
        reason: `${operation.file} 里的 ${operation.symbol} 在执行时已不存在，放弃整条方案`,
      };
    }

    if (operation.op === "unexport") unexport(node);
    else remove(node);

    applied += 1;
    touched.set(operation.file, parsed.source.getFullText());
  }

  const after = collectDiagnostics(semantic.project);
  const introduced = introducedSince(baseline, after);
  const typecheck = {
    baselineErrors: baseline.total,
    afterErrors: after.total,
    introduced,
    elapsedMs: Date.now() - typeStart,
  };
  step(`类型检查：${after.total} 条错误，新增 ${introduced.length} 条（${typecheck.elapsedMs}ms）`);

  if (introduced.length > 0) {
    // 还没写盘，放弃即可，不需要回滚
    return {
      status: "aborted",
      proposal,
      applied,
      typecheck,
      reason: `执行会引入 ${introduced.length} 条新的类型错误，已放弃写入`,
    };
  }

  // ── 写入 ──────────────────────────────────────────
  for (const [relative, text] of touched) {
    fs.writeFileSync(path.join(root, relative), text, "utf8");
  }
  for (const relative of deleted) {
    fs.rmSync(path.join(root, relative), { force: true });
  }
  step(`已写入 ${touched.size} 个文件，删除 ${deleted.length} 个文件`);

  const diff = captureDiff(root, targets);

  // ── 第二层验证：结构 ────────────────────────────────
  step("重新扫描仓库，核对导出总数与文件…");
  const rescan = await scanFiles(root);
  const actualExports = analyzeDeadExports({
    root,
    files: rescan.files,
    contents: rescan.contents,
  }).totalExports;

  const predicted = exportsBefore - proposal.prediction.exportsRemoved;
  const exports = { before: exportsBefore, predicted, actual: actualExports };
  step(`具名导出：${exportsBefore} → ${actualExports}（预测 ${predicted}）`);

  // 删文件这件事不能只看导出数——一个空文件的导出数也是 0。
  // 直接问磁盘：说好要删的，是不是真的不在了
  const survived = deleted.filter((relative) => fs.existsSync(path.join(root, relative)));
  const fileReport = {
    predicted: proposal.prediction.filesRemoved,
    actual: deleted.length - survived.length,
    survived,
  };

  // `survived` 只进报告，不做判据。
  //
  // 初版这里还有一个 `survived.length === 0 &&`，变异测试给它判了 0/7——
  // 不是断言漏了，是**这个条件在逻辑上永远不会独立触发**：
  // `actual = deleted.length - survived.length`，只要 predicted 是对的，
  // survived 一非空就必然让下面那个等式先不成立。
  //
  // 一个永远由别人代劳的判据，留着只会让防线看起来比实际更厚。
  // 但 survived 这个**列表**对人有用——它说得出是哪个文件没删掉，所以留在报告里。
  const matched =
    actualExports === predicted && fileReport.actual === proposal.prediction.filesRemoved;

  const status: ApplyStatus = matched ? "applied" : "rolled-back";
  const reason = matched ? undefined : describeMismatch(exports, fileReport);

  const output = writeArtifacts(root, "proposals", {
    diff,
    report: renderReport({ status, proposal, typecheck, exports, files: fileReport, reason }),
  });

  if (!matched) {
    rollback(root, targets);
    step("已还原全部改动");
  }

  return { status, proposal, applied, typecheck, exports, files: fileReport, reason, ...output };
}

function describeMismatch(
  exports: NonNullable<ProposalExecution["exports"]>,
  files: NonNullable<ProposalExecution["files"]>,
): string {
  const parts: string[] = [];
  if (exports.actual !== exports.predicted) {
    parts.push(`实测剩余 ${exports.actual} 个导出，与预测的 ${exports.predicted} 个不一致`);
  }
  if (files.survived.length > 0) {
    parts.push(`说好要删的文件还在：${files.survived.join("、")}`);
  }
  if (files.actual !== files.predicted) {
    parts.push(`实际删除 ${files.actual} 个文件，方案预测 ${files.predicted} 个`);
  }
  return `${parts.join("；")}，已还原`;
}

interface ReportInput {
  status: ApplyStatus;
  proposal: Proposal;
  typecheck: NonNullable<ProposalExecution["typecheck"]>;
  exports: NonNullable<ProposalExecution["exports"]>;
  files: NonNullable<ProposalExecution["files"]>;
  reason?: string;
}

function renderReport(input: ReportInput): string {
  const { status, proposal, typecheck, exports, files } = input;
  const verdict =
    status === "applied"
      ? "✅ 改动已保留：类型检查无新增错误，实测导出数与方案预测一致"
      : "↩︎ 改动已还原：验证未通过，diff 保留在同目录供人工评估";

  const lines = ["# 模型提出的方案 · 执行与验证报告", "", verdict, ""];
  if (input.reason) lines.push(`> ${input.reason}`, "");

  lines.push(
    "## 方案",
    "",
    `- 类型：\`${proposal.kind}\``,
    `- 目标：\`${proposal.targetFile}\` 的 \`${proposal.targetSymbol}\``,
    `- 风险：**${proposal.risk}**`,
    "",
    `> ${proposal.rationale}`,
    "",
    "### 指令",
    "",
    "| 动作 | 文件 | 符号 |",
    "|---|---|---|",
    ...proposal.operations.map(
      (operation) =>
        `| \`${operation.op}\` | \`${operation.file}\` | ${
          operation.symbol ? `\`${operation.symbol}\`` : "—"
        } |`,
    ),
    "",
  );

  if (proposal.risk === "high") {
    lines.push(
      "> ⚠️ 这条方案改的是工具判定为**不安全**的东西。类型检查加导出数对账",
      "> 能证明改动是机械正确的，**证明不了运行时行为等价**。",
      "",
    );
  }

  lines.push(
    "## 验证",
    "",
    "### 类型检查",
    "",
    "判据是**不新增**错误，而非零错误——真实仓库的基线几乎从来不是干净的。",
    "",
    `- 改动前：${typecheck.baselineErrors} 条错误`,
    `- 改动后：${typecheck.afterErrors} 条错误`,
    `- 新增：${typecheck.introduced.length} 条`,
    `- 耗时：${typecheck.elapsedMs}ms`,
    "",
  );

  if (typecheck.introduced.length > 0) {
    lines.push(
      ...typecheck.introduced
        .slice(0, 20)
        .map((note) => `  - \`${note.file}:${note.line}\` TS${note.code} ${note.message}`),
      "",
    );
  }

  lines.push(
    "### 与方案预测对账",
    "",
    "模型的预测在给人看之前已经跟静态推算值核对过一次（C3），这里对的是另一件事：",
    "**静态计算出的期望值，和重新扫描仓库得到的实测值。**",
    "前者查的是模型有没有理解自己的方案，后者查的是执行有没有真的做到。",
    "",
    `- 具名导出：${exports.before} → ${exports.actual}（预测 ${exports.predicted}）`,
    `- 删除文件：${files.actual} 个（预测 ${files.predicted} 个）`,
    `- 对账：${status === "applied" ? "一致" : "**不一致**"}`,
    "",
  );

  if (files.survived.length > 0) {
    lines.push(
      "说好要删、但磁盘上仍然存在的文件：",
      "",
      ...files.survived.map((item) => `- \`${item}\``),
      "",
    );
  }

  return lines.join("\n");
}

/** 供 CLI 直接打印 */
export function formatExecution(result: ProposalExecution): string {
  const lines: string[] = ["─".repeat(60)];
  const { proposal } = result;

  lines.push(
    `方案    ${proposal.kind}  ${proposal.targetFile} 的 ${proposal.targetSymbol}`,
    `风险    ${proposal.risk}`,
    `理由    ${proposal.rationale}`,
    "",
  );

  if (result.status === "aborted" || result.status === "no-op") {
    lines.push("✗ 已放弃执行，未写入任何文件", `原因：${result.reason ?? "未知"}`);
    for (const note of result.typecheck?.introduced.slice(0, 10) ?? []) {
      lines.push(`  ${note.file}:${note.line}  TS${note.code} ${note.message}`);
    }
    return lines.join("\n");
  }

  lines.push(result.status === "applied" ? "✓ 方案已执行" : "↩ 验证未通过，改动已还原", "");

  for (const operation of proposal.operations) {
    lines.push(`        ${operation.op}  ${operation.file}  ${operation.symbol || "—"}`);
  }

  if (result.typecheck) {
    lines.push(
      "",
      `类型检查 基线 ${result.typecheck.baselineErrors} 条错误 → 改后 ${result.typecheck.afterErrors} 条，新增 ${result.typecheck.introduced.length} 条`,
    );
  }
  if (result.exports) {
    lines.push(
      `导出对账 ${result.exports.before} → ${result.exports.actual}（预测 ${result.exports.predicted}，${
        result.exports.actual === result.exports.predicted ? "一致" : "不一致"
      }）`,
    );
  }
  if (result.files && result.files.predicted > 0) {
    lines.push(
      `文件对账 删除 ${result.files.actual} 个（预测 ${result.files.predicted} 个，${
        result.files.actual === result.files.predicted && result.files.survived.length === 0
          ? "一致"
          : "不一致"
      }）`,
    );
  }
  if (result.reason) lines.push("", result.reason);
  if (result.outputDir) {
    lines.push("", `产物    ${result.outputDir}`, "        refactor.diff · verify-report.md");
  }
  if (result.status === "applied") {
    lines.push(
      "",
      proposal.risk === "high"
        ? "⚠ 这条方案改的是工具判定为不安全的东西，对账只能证明改动机械正确，证明不了行为等价——务必人工复核"
        : "改动已在工作区，用 git diff 复核后再提交；git checkout -- . 可整体撤销",
    );
  }

  return lines.join("\n");
}
