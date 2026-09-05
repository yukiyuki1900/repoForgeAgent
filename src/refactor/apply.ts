import fs from "node:fs";
import path from "node:path";
import type { ImportDeclaration } from "ts-morph";
import { analyzeCycles } from "../analyze/analyzers.js";
import { extractGraph, openSemanticProject } from "../scan/graph.js";
import type { FileNode, Finding, RelationEdge } from "../core/model.js";
import { planTypeOnlyRefactor, type ImportCandidate, type RefactorPlan } from "./refactor.js";
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

export type { DiagnosticNote };

/**
 * 把 `import type` 改造真正写进目标仓库，并自证改对了。
 *
 * 「Agent 能改代码」这句话的含金量全在验证环节。这里不接受「tsc 没报错」
 * 作为唯一凭据——它只说明改动能编译，不说明改动**有用**。所以验证分两层：
 *
 * 1. 类型层：改动前后各做一次全量 pre-emit 检查，只要出现**新增**错误就判失败。
 *    比「零错误」宽容，因为真实仓库的 tsc 很少是干净的；比「不报错」严格，
 *    因为基线里已有的错误不能拿来掩盖新引入的问题。
 * 2. 结构层：重新扫描、重建依赖图、重跑 Tarjan，实测环数必须与 dry-run 的
 *    预测**完全一致**。预测 3→1 而实测 3→2，说明模型对边的理解是错的，
 *    哪怕代码能编译也要回滚。
 *
 * 回滚交给 git：前置检查确保目标文件已被跟踪且没有未提交改动，
 * 失败时 `git checkout --` 就是最可靠的还原，不需要自己维护快照。
 */

export type ApplyStatus =
  /** 已写入并通过两层验证 */
  | "applied"
  /** 写入后验证失败，已还原 */
  | "rolled-back"
  /** 前置检查或类型检查未通过，从未写入 */
  | "aborted"
  /** 没有可安全改写的边 */
  | "no-op";

export interface AppliedEdit {
  file: string;
  line: number;
  specifier: string;
  names: string[];
}

export interface SkippedEdit extends AppliedEdit {
  reason: string;
}

export interface ApplyResult {
  status: ApplyStatus;
  plan: RefactorPlan;
  edits: AppliedEdit[];
  /** 判定可拆、但当前实现不敢写入的边 */
  skipped: SkippedEdit[];
  typecheck?: {
    baselineErrors: number;
    afterErrors: number;
    introduced: DiagnosticNote[];
    elapsedMs: number;
  };
  cycles?: {
    before: number;
    /** dry-run 的模拟结果 */
    predicted: number;
    /** 写入后重跑分析的实测结果 */
    actual: number;
  };
  outputDir?: string;
  /** 无论成功还是回滚都会落盘，回滚时留作人工评估的材料 */
  diffPath?: string;
  reportPath?: string;
  reason?: string;
}

export interface ApplyOptions {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  edges: RelationEdge[];
  cycles: Finding[];
  onStep?: (message: string) => void;
}

export async function applyTypeOnlyRefactor(options: ApplyOptions): Promise<ApplyResult> {
  const { root, files, contents, edges, cycles } = options;
  const step = options.onStep ?? (() => {});

  // 判定与改写必须共用同一份 AST，否则计划里的行号未必落在同一个节点上
  const semantic = openSemanticProject(root, files, contents);
  const plan = planTypeOnlyRefactor({ root, files, contents, edges, cycles, semantic });

  const allCandidates = plan.cycles.flatMap((cycle) => cycle.candidates);
  if (allCandidates.length === 0) {
    return { status: "no-op", plan, edits: [], skipped: [], reason: "计划里没有可拆的边" };
  }

  const byPath = new Map(files.map((file) => [file.path, file]));
  const writable: ImportCandidate[] = [];
  const skipped: SkippedEdit[] = [];

  for (const candidate of allCandidates) {
    const reason = unwritableReason(byPath.get(candidate.file));
    if (reason) skipped.push({ ...toEdit(candidate), reason });
    else writable.push(candidate);
  }

  if (writable.length === 0) {
    return {
      status: "no-op",
      plan,
      edits: [],
      skipped,
      reason: "可拆的边全部落在当前实现不敢写入的文件上",
    };
  }

  const targets = [...new Set(writable.map((item) => item.file))].sort();

  const guard = preflight(root, targets);
  if (!guard.ok) {
    return { status: "aborted", plan, edits: [], skipped, reason: guard.reason };
  }
  step(`前置检查通过：${targets.length} 个目标文件均已被 git 跟踪且无未提交改动`);

  // ── 第一层验证：类型 ────────────────────────────────
  const typeStart = Date.now();
  const baseline = collectDiagnostics(semantic.project);
  step(`类型基线：${baseline.total} 条已有错误`);

  const edits: AppliedEdit[] = [];
  const touched = new Map<string, string>();

  for (const candidate of writable) {
    const parsed = semantic.parsed.find((item) => item.file.path === candidate.file);
    const decl = parsed && locateDeclaration(parsed.source.getImportDeclarations(), candidate);
    if (!parsed || !decl) {
      skipped.push({ ...toEdit(candidate), reason: "改写时未能重新定位到这条 import" });
      continue;
    }
    decl.setIsTypeOnly(true);
    edits.push(toEdit(candidate));
    touched.set(candidate.file, parsed.source.getFullText());
  }

  if (edits.length === 0) {
    return { status: "aborted", plan, edits: [], skipped, reason: "没有一条 import 能重新定位" };
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
    // 还没写盘，直接放弃即可，不需要回滚
    return {
      status: "aborted",
      plan,
      edits,
      skipped,
      typecheck,
      reason: `改动会引入 ${introduced.length} 条新的类型错误，已放弃写入`,
    };
  }

  // ── 写入 ──────────────────────────────────────────
  for (const [relative, text] of touched) {
    fs.writeFileSync(path.join(root, relative), text, "utf8");
  }
  step(`已写入 ${touched.size} 个文件`);

  const diff = captureDiff(root, targets);

  // ── 第二层验证：结构 ────────────────────────────────
  step("重新扫描仓库，验证环是否真的消失…");
  const rescan = await scanFiles(root);
  const rebuilt = extractGraph(root, rescan.files, rescan.contents);
  const actual = analyzeCycles(rescan.files, rebuilt.edges).length;

  const cycleReport = { before: plan.cyclesBefore, predicted: plan.cyclesAfter, actual };
  step(`循环依赖：${cycleReport.before} → ${actual}（预测 ${cycleReport.predicted}）`);

  const matched = actual === plan.cyclesAfter;
  const status: ApplyStatus = matched ? "applied" : "rolled-back";
  const reason = matched
    ? undefined
    : `实测剩余 ${actual} 个环，与预测的 ${plan.cyclesAfter} 个不一致，已还原`;

  const output = writeArtifacts(root, "refactors", {
    diff,
    report: renderVerifyReport({
      status,
      plan,
      edits,
      skipped,
      typecheck,
      cycles: cycleReport,
      diff,
      reason,
    }),
  });

  if (!matched) {
    rollback(root, targets);
    step("已还原全部改动");
  }

  return {
    status,
    plan,
    edits,
    skipped,
    typecheck,
    cycles: cycleReport,
    reason,
    ...output,
  };
}

/**
 * .vue 目前不写入。
 *
 * SFC 的 script 块是被抽出来拼成虚拟 TS 文件的（`script` + `scriptSetup` 直接
 * 相连），虚拟文件的行号与 .vue 原文并不对齐，把 `getFullText()` 写回去会把
 * template 和 style 整段抹掉。判定结果照常给出，交给人按提示手改。
 */
function unwritableReason(file: FileNode | undefined): string | undefined {
  if (!file) return "文件不在本次扫描结果里";
  if (file.language === "vue") return "Vue SFC 的虚拟脚本与源文件行号不对齐，需人工修改";
  return undefined;
}

function toEdit(candidate: ImportCandidate): AppliedEdit {
  return {
    file: candidate.file,
    line: candidate.line,
    specifier: candidate.specifier,
    names: candidate.names,
  };
}

/** 行号 + 说明符双重定位，避免同一行有多条声明时改错 */
function locateDeclaration(
  declarations: ImportDeclaration[],
  candidate: ImportCandidate,
): ImportDeclaration | undefined {
  return declarations.find(
    (decl) =>
      decl.getStartLineNumber() === candidate.line &&
      decl.getModuleSpecifierValue() === candidate.specifier,
  );
}

// ── 产物 ──────────────────────────────────────────────

interface ArtifactInput {
  status: ApplyStatus;
  plan: RefactorPlan;
  edits: AppliedEdit[];
  skipped: SkippedEdit[];
  typecheck: NonNullable<ApplyResult["typecheck"]>;
  cycles: NonNullable<ApplyResult["cycles"]>;
  diff: string;
  reason?: string;
}

function renderVerifyReport(input: ArtifactInput): string {
  const { status, edits, skipped, typecheck, cycles } = input;
  const verdict =
    status === "applied"
      ? "✅ 改动已保留：类型检查无新增错误，实测环数与预测一致"
      : "↩︎ 改动已还原：验证未通过，diff 保留在同目录供人工评估";

  const lines = ["# import type 拆环 · 验证报告", "", verdict, ""];

  if (input.reason) lines.push(`> ${input.reason}`, "");

  lines.push(
    "## 改动",
    "",
    "| 文件 | 行 | 导入 | 来源 |",
    "|---|---|---|---|",
    ...edits.map(
      (edit) =>
        `| \`${edit.file}\` | ${edit.line} | ${edit.names.join(", ")} | \`${edit.specifier}\` |`,
    ),
    "",
  );

  if (skipped.length > 0) {
    lines.push(
      "## 判定可拆但未写入",
      "",
      "| 文件 | 行 | 原因 |",
      "|---|---|---|",
      ...skipped.map((item) => `| \`${item.file}\` | ${item.line} | ${item.reason} |`),
      "",
    );
  }

  lines.push(
    "## 验证",
    "",
    "### 类型检查",
    "",
    `判据是**不新增**错误，而非零错误——真实仓库的基线几乎从来不是干净的。`,
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
    "### 循环依赖",
    "",
    "重新扫描仓库、重建依赖图、重跑 Tarjan，与 dry-run 的模拟结果对账。",
    "",
    `- 改动前：${cycles.before} 个环`,
    `- 模拟预测：${cycles.predicted} 个环`,
    `- 实测：${cycles.actual} 个环`,
    `- 对账：${cycles.actual === cycles.predicted ? "一致" : "**不一致**"}`,
    "",
  );

  return lines.join("\n");
}

/** 供 CLI 直接打印 */
export function formatApplyResult(result: ApplyResult): string {
  const lines: string[] = ["─".repeat(60)];

  if (result.status === "no-op" || result.status === "aborted") {
    lines.push(
      result.status === "no-op" ? "未执行改造" : "✗ 已放弃改造，未写入任何文件",
      `原因：${result.reason ?? "未知"}`,
    );
    for (const note of result.typecheck?.introduced.slice(0, 10) ?? []) {
      lines.push(`  ${note.file}:${note.line}  TS${note.code} ${note.message}`);
    }
    if (result.skipped.length > 0) {
      lines.push("", "以下边判定可拆但未写入，可手工处理：");
      for (const item of result.skipped) {
        lines.push(`  ${item.file}:${item.line}  ${item.reason}`);
      }
    }
    return lines.join("\n");
  }

  lines.push(
    result.status === "applied" ? "✓ 改造已应用" : "↩ 验证未通过，改动已还原",
    "",
    `改动    ${result.edits.length} 条 import，涉及 ${new Set(result.edits.map((e) => e.file)).size} 个文件`,
  );
  for (const edit of result.edits) {
    lines.push(`        ${edit.file}:${edit.line}  → import type { ${edit.names.join(", ")} }`);
  }

  if (result.typecheck) {
    lines.push(
      "",
      `类型检查 基线 ${result.typecheck.baselineErrors} 条错误 → 改后 ${result.typecheck.afterErrors} 条，新增 ${result.typecheck.introduced.length} 条`,
    );
  }
  if (result.cycles) {
    lines.push(
      `环验证   ${result.cycles.before} → ${result.cycles.actual}（预测 ${result.cycles.predicted}，${
        result.cycles.actual === result.cycles.predicted ? "一致" : "不一致"
      }）`,
    );
  }
  if (result.skipped.length > 0) {
    lines.push("", `另有 ${result.skipped.length} 条判定可拆但未写入：`);
    for (const item of result.skipped) {
      lines.push(`        ${item.file}:${item.line}  ${item.reason}`);
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
