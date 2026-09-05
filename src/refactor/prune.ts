import fs from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { ApplyStatus } from "./apply.js";
import {
  analyzeDeadExports,
  locateExportedStatement,
  planDeadExportRemoval,
  type BlockedRemoval,
  type DeadExportEdit,
  type DeadExportPlan,
} from "../analyze/deadexports.js";
import { openSemanticProject } from "../scan/graph.js";
import type { FileNode } from "../core/analysis.js";
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
 * 把未使用的导出真正清理掉，并自证清理对了。
 *
 * 这是第二条走完整条链路的改造，用的是和 `import type` 破环**完全相同的模板**：
 * 确定性代码算出事实 → 判断能不能安全改 → 改 → 用确定性代码验证 → 不符就回滚。
 * 两者共用 `verify.ts` 的骨架，区别只在第二层验证拿什么对账。
 *
 * - `import type` 对的是**环数**：改完之后应该剩几个环
 * - 这里对的是**导出总数**：改完之后应该剩多少个具名导出
 *
 * 判据都必须是「与预测**完全一致**」而不是「变少了」。后者近乎永远成立，
 * 等于没有验证——只要删掉任何一个导出，「变少了」就为真。
 */

export interface PruneResult {
  status: ApplyStatus;
  plan: DeadExportPlan;
  edits: DeadExportEdit[];
  /** 判定该清理、但改写阶段没敢动的 */
  skipped: BlockedRemoval[];
  typecheck?: {
    baselineErrors: number;
    afterErrors: number;
    introduced: DiagnosticNote[];
    elapsedMs: number;
  };
  exports?: {
    before: number;
    /** 计划阶段的预测 */
    predicted: number;
    /** 写入后重新扫描的实测值 */
    actual: number;
  };
  outputDir?: string;
  diffPath?: string;
  reportPath?: string;
  reason?: string;
}

export interface PruneOptions {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  onStep?: (message: string) => void;
}

export async function applyDeadExportRemoval(options: PruneOptions): Promise<PruneResult> {
  const { root, files, contents } = options;
  const step = options.onStep ?? (() => {});

  // 判定与改写共用同一份 AST：换一个 Project 解析，符号定位就可能落在别的节点上
  const semantic = openSemanticProject(root, files, contents);
  const plan = planDeadExportRemoval({ root, files, contents, semantic });

  if (plan.edits.length === 0) {
    return {
      status: "no-op",
      plan,
      edits: [],
      skipped: plan.blocked,
      reason: "没有可安全清理的导出",
    };
  }

  const targets = [...new Set(plan.edits.map((edit) => edit.file))].sort();

  const guard = preflight(root, targets);
  if (!guard.ok) {
    return { status: "aborted", plan, edits: [], skipped: plan.blocked, reason: guard.reason };
  }
  step(`前置检查通过：${targets.length} 个目标文件均已被 git 跟踪且无未提交改动`);

  // ── 第一层验证：类型 ────────────────────────────────
  const typeStart = Date.now();
  const baseline = collectDiagnostics(semantic.project);
  step(`类型基线：${baseline.total} 条已有错误`);

  const edits: DeadExportEdit[] = [];
  const skipped: BlockedRemoval[] = [...plan.blocked];
  const touched = new Map<string, string>();

  const byFile = new Map<string, DeadExportEdit[]>();
  for (const edit of plan.edits) {
    byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  }

  for (const [filePath, fileEdits] of byFile) {
    const parsed = semantic.parsed.find((item) => item.file.path === filePath);
    if (!parsed) {
      for (const edit of fileEdits) {
        skipped.push({ ...edit, reason: "改写时文件不在解析结果里" });
      }
      continue;
    }

    for (const edit of fileEdits) {
      // 每条改动前重新定位：上一条删除会让后面的语句整体上移，
      // 缓存下来的节点引用与行号都不再可靠
      const node = locateExportedStatement(parsed.source, edit.symbol);
      if (!node) {
        skipped.push({ ...edit, reason: "改写时未能重新定位到这条声明" });
        continue;
      }

      if (edit.action === "unexport") unexport(node);
      else remove(node);

      edits.push(edit);
    }

    touched.set(filePath, parsed.source.getFullText());
  }

  if (edits.length === 0) {
    return {
      status: "aborted",
      plan,
      edits: [],
      skipped,
      reason: "没有一条声明能重新定位",
    };
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
      plan,
      edits,
      skipped,
      typecheck,
      reason: `清理会引入 ${introduced.length} 条新的类型错误，已放弃写入`,
    };
  }

  // ── 写入 ──────────────────────────────────────────
  for (const [relative, text] of touched) {
    fs.writeFileSync(path.join(root, relative), text, "utf8");
  }
  step(`已写入 ${touched.size} 个文件`);

  const diff = captureDiff(root, targets);

  // ── 第二层验证：结构 ────────────────────────────────
  step("重新扫描仓库，核对导出总数…");
  const rescan = await scanFiles(root);
  const actual = analyzeDeadExports({
    root,
    files: rescan.files,
    contents: rescan.contents,
  }).totalExports;

  const report = { before: plan.exportsBefore, predicted: plan.exportsAfter, actual };
  step(`具名导出：${report.before} → ${actual}（预测 ${report.predicted}）`);

  const matched = actual === plan.exportsAfter;
  const status: ApplyStatus = matched ? "applied" : "rolled-back";
  const reason = matched
    ? undefined
    : `实测剩余 ${actual} 个导出，与预测的 ${plan.exportsAfter} 个不一致，已还原`;

  const output = writeArtifacts(root, "prunes", {
    diff,
    report: renderReport({ status, edits, skipped, typecheck, exports: report, plan, reason }),
  });

  if (!matched) {
    rollback(root, targets);
    step("已还原全部改动");
  }

  return { status, plan, edits, skipped, typecheck, exports: report, reason, ...output };
}

/**
 * 去掉 `export` 关键字。变量要落到它所属的 VariableStatement 上。
 *
 * 和下面的 `remove` 一起导出，是因为第三条链路（模型提的方案）执行的
 * 也正是这两个动作。**改写原语只有一份实现**，否则两边的行为迟早会分叉——
 * 而分叉的那一刻，两边的验证都还是绿的。
 */
export function unexport(node: Node): void {
  if (Node.isVariableDeclaration(node)) {
    node.getFirstAncestorByKind(SyntaxKind.VariableStatement)?.setIsExported(false);
    return;
  }
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node)
  ) {
    node.setIsExported(false);
  }
}

/** 删除整条声明。变量是最后一个绑定时，ts-morph 会连整条语句一起删掉 */
export function remove(node: Node): void {
  if (
    Node.isVariableDeclaration(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node)
  ) {
    node.remove();
  }
}

interface ReportInput {
  status: ApplyStatus;
  plan: DeadExportPlan;
  edits: DeadExportEdit[];
  skipped: BlockedRemoval[];
  typecheck: NonNullable<PruneResult["typecheck"]>;
  exports: NonNullable<PruneResult["exports"]>;
  reason?: string;
}

function renderReport(input: ReportInput): string {
  const { status, edits, skipped, typecheck, exports: counts } = input;
  const verdict =
    status === "applied"
      ? "✅ 改动已保留：类型检查无新增错误，实测导出数与预测一致"
      : "↩︎ 改动已还原：验证未通过，diff 保留在同目录供人工评估";

  const lines = ["# 未使用的导出清理 · 验证报告", "", verdict, ""];
  if (input.reason) lines.push(`> ${input.reason}`, "");

  lines.push(
    "## 改动",
    "",
    "| 文件 | 行 | 符号 | 种类 | 改法 |",
    "|---|---|---|---|---|",
    ...edits.map(
      (edit) =>
        `| \`${edit.file}\` | ${edit.line} | \`${edit.symbol}\` | ${edit.kind} | ${
          edit.action === "unexport" ? "去掉 export" : "删除整条声明"
        } |`,
    ),
    "",
  );

  if (skipped.length > 0) {
    lines.push(
      "## 判定该清理但未执行",
      "",
      "| 文件 | 符号 | 原因 |",
      "|---|---|---|",
      ...skipped.map((item) => `| \`${item.file}\` | \`${item.symbol}\` | ${item.reason} |`),
      "",
    );
  }

  if (input.plan.testOnly.length > 0) {
    lines.push(
      "## 只被测试引用",
      "",
      "这些导出在生产代码里没有引用者，只有测试在用。**工具不动它们**——",
      "删掉意味着连同测试一起删，那是产品决策，不是机械变换。",
      "",
      ...input.plan.testOnly.map((item) => `- \`${item.file}:${item.line}\` \`${item.symbol}\``),
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
    "### 导出总数",
    "",
    "重新扫描仓库、重跑一次导出收集，与计划阶段的预测对账。",
    "判据是**完全相等**而不是「变少了」——后者只要删掉任何一个导出就成立，等于没验证。",
    "",
    `- 改动前：${counts.before} 个具名导出`,
    `- 计划预测：${counts.predicted} 个`,
    `- 实测：${counts.actual} 个`,
    `- 对账：${counts.actual === counts.predicted ? "一致" : "**不一致**"}`,
    "",
  );

  return lines.join("\n");
}

/** 供 CLI 直接打印 */
export function formatPruneResult(result: PruneResult): string {
  const lines: string[] = ["─".repeat(60)];

  if (result.status === "no-op" || result.status === "aborted") {
    lines.push(
      result.status === "no-op" ? "未执行清理" : "✗ 已放弃清理，未写入任何文件",
      `原因：${result.reason ?? "未知"}`,
    );
    for (const note of result.typecheck?.introduced.slice(0, 10) ?? []) {
      lines.push(`  ${note.file}:${note.line}  TS${note.code} ${note.message}`);
    }
    if (result.skipped.length > 0) {
      lines.push("", "以下导出判定该清理但未执行：");
      for (const item of result.skipped) {
        lines.push(`  ${item.file}  ${item.symbol}  ${item.reason}`);
      }
    }
    return lines.join("\n");
  }

  lines.push(
    result.status === "applied" ? "✓ 清理已应用" : "↩ 验证未通过，改动已还原",
    "",
    `改动    ${result.edits.length} 个导出，涉及 ${new Set(result.edits.map((e) => e.file)).size} 个文件`,
  );
  for (const edit of result.edits) {
    lines.push(
      `        ${edit.file}:${edit.line}  ${edit.symbol}  → ${
        edit.action === "unexport" ? "去掉 export" : "删除声明"
      }`,
    );
  }

  if (result.typecheck) {
    lines.push(
      "",
      `类型检查 基线 ${result.typecheck.baselineErrors} 条错误 → 改后 ${result.typecheck.afterErrors} 条，新增 ${result.typecheck.introduced.length} 条`,
    );
  }
  if (result.exports) {
    lines.push(
      `导出验证 ${result.exports.before} → ${result.exports.actual}（预测 ${result.exports.predicted}，${
        result.exports.actual === result.exports.predicted ? "一致" : "不一致"
      }）`,
    );
  }
  if (result.plan.testOnly.length > 0) {
    lines.push("", `另有 ${result.plan.testOnly.length} 个导出只被测试引用，未做处理：`);
    for (const item of result.plan.testOnly) {
      lines.push(`        ${item.file}:${item.line}  ${item.symbol}`);
    }
  }
  if (result.skipped.length > 0) {
    lines.push("", `另有 ${result.skipped.length} 个判定该清理但未执行：`);
    for (const item of result.skipped) {
      lines.push(`        ${item.file}  ${item.symbol}  ${item.reason}`);
    }
  }
  if (result.reason) lines.push("", result.reason);
  if (result.outputDir) {
    lines.push("", `产物    ${result.outputDir}`, "        refactor.diff · verify-report.md");
  }
  if (result.status === "applied") {
    lines.push("", "改动已在工作区，用 git diff 复核后再提交；git checkout -- . 可整体撤销");
  }

  return lines.join("\n");
}
