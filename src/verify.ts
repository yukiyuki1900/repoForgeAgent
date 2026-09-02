import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ts, type Project } from "ts-morph";

/**
 * 改造的验证骨架。
 *
 * 从 `import type` 破环里抽出来，因为死导出清理要用同一套东西：写入前的 git
 * 门禁、类型诊断的基线对比、diff 落盘、验证失败回滚。
 *
 * 抽取本身就是一次检验——如果两条改造链路能共用同一副骨架，
 * 「算出事实 → 判断能否安全改 → 改 → 验证 → 不符回滚」才算得上可复制的模板，
 * 而不是在某一种变换上碰巧成立的做法。
 */

export interface DiagnosticNote {
  file: string;
  line: number;
  code: number;
  message: string;
}

export interface DiagnosticSnapshot {
  /**
   * 指纹 → 出现次数。
   *
   * **指纹刻意不含行号。**
   *
   * `import type` 是行内插入关键字，前后行号完全不变，所以最初直接用
   * `文件#行#错误码#文本` 做指纹是成立的。但删除一条声明会让它后面的所有语句
   * 整体上移——同一个**早就存在**的错误换了行号，比对时看起来就是「旧的消失了、
   * 新的出现了」，于是每一次删除都会被判成引入了新的类型错误，改造永远无法通过。
   *
   * 去掉行号后，同一文件里的同种错误会被合并成一个指纹，所以改成**计数比对**：
   * 只有某个指纹的出现次数比基线更多，才算真的新增。
   *
   * 这是判据必须随变换性质调整的一个例子：行内插入和行级删除，
   * 不能套用同一套对比方式。
   */
  counts: Map<string, number>;
  /** 指纹 → 一条代表性诊断，用于在报告里给出具体位置 */
  samples: Map<string, DiagnosticNote>;
  /** 错误诊断总条数 */
  total: number;
}

/** 收集全量错误级诊断 */
export function collectDiagnostics(project: Project): DiagnosticSnapshot {
  const counts = new Map<string, number>();
  const samples = new Map<string, DiagnosticNote>();
  let total = 0;

  for (const diagnostic of project.getPreEmitDiagnostics()) {
    if (diagnostic.getCategory() !== ts.DiagnosticCategory.Error) continue;

    const file = diagnostic.getSourceFile()?.getFilePath() ?? "<unknown>";
    const line = diagnostic.getLineNumber() ?? 0;
    const code = diagnostic.getCode();
    // ts-morph 把 messageText 包了一层，展平要用原始的 compiler 对象
    const message = ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, " ");

    const fingerprint = `${file}#${code}#${message}`;
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
    if (!samples.has(fingerprint)) samples.set(fingerprint, { file, line, code, message });
    total += 1;
  }

  return { counts, samples, total };
}

/**
 * 相对基线**新增**的错误。
 *
 * 判据是「不新增」而不是「零错误」：真实仓库的 tsc 基线几乎从来不是干净的，
 * 要求零错误等于这个能力在所有真实项目上都不可用。但基线里已有的错误
 * 也不能拿来掩盖新引入的问题，所以逐指纹比计数。
 */
export function introducedSince(
  baseline: DiagnosticSnapshot,
  after: DiagnosticSnapshot,
): DiagnosticNote[] {
  const introduced: DiagnosticNote[] = [];

  for (const [fingerprint, count] of after.counts) {
    const before = baseline.counts.get(fingerprint) ?? 0;
    if (count <= before) continue;

    const sample = after.samples.get(fingerprint);
    // 同一指纹多出 n 条就记 n 条，避免「多出 20 条同类错误」被压成一条
    for (let i = 0; i < count - before; i += 1) {
      if (sample) introduced.push(sample);
    }
  }

  return introduced;
}

// ── git ───────────────────────────────────────────────

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * 写入前的安全门。
 *
 * 只检查**将要改动的那几个文件**，不要求整个工作区干净——分析本身会在
 * 目标仓库生成 `.reposurgeon/`，按整树判断会导致第二次运行永远被拒。
 *
 * 回滚手段是 `git checkout --`，因此「已被跟踪」和「没有未提交改动」
 * 是不能让步的前提：前者意味着还原不回去，后者意味着还原会吃掉用户的工作。
 */
export function preflight(root: string, targets: string[]): { ok: boolean; reason?: string } {
  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { ok: false, reason: `${root} 不在 git 仓库里，没有可靠的回滚手段，拒绝写入` };
  }

  const untracked: string[] = [];
  for (const target of targets) {
    try {
      git(root, ["ls-files", "--error-unmatch", "--", target]);
    } catch {
      untracked.push(target);
    }
  }
  if (untracked.length > 0) {
    return { ok: false, reason: `以下文件未被 git 跟踪，无法回滚：${untracked.join("、")}` };
  }

  const dirty = git(root, ["status", "--porcelain", "--", ...targets]).trim();
  if (dirty) {
    const list = dirty
      .split("\n")
      .map((line) => line.slice(3))
      .join("、");
    return { ok: false, reason: `目标文件有未提交的改动，回滚会覆盖你的工作：${list}` };
  }

  return { ok: true };
}

export function captureDiff(root: string, targets: string[]): string {
  try {
    return git(root, ["diff", "--unified=3", "--", ...targets]);
  } catch {
    return "";
  }
}

export function rollback(root: string, targets: string[]): void {
  git(root, ["checkout", "--", ...targets]);
}

// ── 产物 ──────────────────────────────────────────────

/**
 * 落盘一次改造的 diff 与验证报告。
 *
 * **无论成功还是回滚都要写**：回滚掉的那份 diff 恰恰是最该留给人看的材料——
 * 它说明工具想改什么、为什么判定失败。只在成功时留档等于把失败藏起来。
 */
export function writeArtifacts(
  root: string,
  category: string,
  input: { diff: string; report: string },
): { outputDir: string; diffPath: string; reportPath: string } {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const outputDir = path.join(root, ".reposurgeon", category, stamp);
  fs.mkdirSync(outputDir, { recursive: true });

  const diffPath = path.join(outputDir, "refactor.diff");
  const reportPath = path.join(outputDir, "verify-report.md");

  fs.writeFileSync(diffPath, input.diff, "utf8");
  fs.writeFileSync(reportPath, input.report, "utf8");

  return { outputDir, diffPath, reportPath };
}
