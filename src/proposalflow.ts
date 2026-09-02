import { collectProposalFacts, type ProposalFacts } from "./facts.js";
import type { Model } from "./llm.js";
import type { FileNode } from "./model.js";
import { proposeCleanup, type Proposal } from "./propose.js";
import { validateProposals, type ValidationResult } from "./validate.js";

/**
 * 把「提方案」这条链路串起来：收集事实 → 让模型提 → 静态校验 → 交给人看。
 *
 * 编排本身只有二十来行，值得单列一个文件的理由是**它划出了自动化的终点**：
 * 这个函数返回方案列表就结束了，不会顺手执行任何一条。
 * 执行是 `execute.ts` 的事，而且必须由人指名道姓选中一条才发生。
 *
 * 三段各自的立场：
 *
 * ```
 * facts.ts     给模型看什么   —— 只给确定性代码算出来的事实，截断如实报告
 * propose.ts   模型能说什么   —— schema 约束，没有数字预测的方案无法表达
 * validate.ts  哪些说了不算   —— 逐条对着 AST 复查，不采信模型说的任何事实
 * ```
 */

export interface ProposalFlow {
  facts: ProposalFacts;
  /** 模型的原始输出，含后来被拦下的。留着是为了让「拦下了什么」可查 */
  raw: Proposal[];
  validation: ValidationResult;
  /** 候选池为空，压根没发起模型调用 */
  skipped: boolean;
}

export async function proposeAndValidate(input: {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  model: Model;
  onStep?: (message: string) => void;
}): Promise<ProposalFlow> {
  const { root, files, contents, model } = input;
  const step = input.onStep ?? (() => {});

  const facts = collectProposalFacts({ root, files, contents });
  step(
    `候选池 ${facts.candidates.length} 个（工具主动放弃的部分）` +
      (facts.omittedCandidates > 0 ? `，另有 ${facts.omittedCandidates} 个未列出` : ""),
  );

  if (facts.candidates.length === 0) {
    // 面对空清单模型只会编，白花一次调用还引入幻觉风险
    return {
      facts,
      raw: [],
      validation: { accepted: [], rejected: [], adjusted: [] },
      skipped: true,
    };
  }

  const proposed = await proposeCleanup(model, facts);
  step(`模型提了 ${proposed.proposals.length} 条方案，开始逐条静态校验…`);

  const validation = validateProposals({
    root,
    files,
    contents,
    facts,
    proposals: proposed.proposals,
  });

  step(
    `校验通过 ${validation.accepted.length} 条，拦下 ${validation.rejected.length} 条` +
      (validation.adjusted.length > 0 ? `，强制改写 ${validation.adjusted.length} 处字段` : ""),
  );

  return { facts, raw: proposed.proposals, validation, skipped: false };
}

/**
 * 渲染给人看的方案列表。
 *
 * **被拦下的方案也要列出来**，和 `excluded` 一个道理：判据可以被质疑，
 * 但不能是隐形的。一个只展示成功结果的工具，没法让人判断它靠不靠谱。
 */
export function formatProposalFlow(flow: ProposalFlow): string {
  const lines = ["─".repeat(60)];
  const { accepted, rejected, adjusted } = flow.validation;

  if (flow.skipped) {
    lines.push(
      "候选池为空——工具没有主动放弃任何导出，模型无事可做。",
      "（没有发起模型调用：面对空清单模型只会编）",
    );
    return lines.join("\n");
  }

  lines.push(
    `候选 ${flow.facts.candidates.length} 个 · 模型提了 ${flow.raw.length} 条 · 通过校验 ${accepted.length} 条`,
    "",
  );

  if (accepted.length === 0) {
    lines.push("没有一条方案通过静态校验。");
  }

  accepted.forEach((proposal, index) => {
    lines.push(
      `[${index + 1}] ${proposal.kind}   风险 ${proposal.risk}`,
      `    目标  ${proposal.targetFile}  ${proposal.targetSymbol}`,
      `    理由  ${proposal.rationale}`,
      `    预测  导出 -${proposal.prediction.exportsRemoved}，文件 -${proposal.prediction.filesRemoved}`,
    );
    for (const operation of proposal.operations) {
      lines.push(`    指令  ${operation.op}  ${operation.file}  ${operation.symbol || "—"}`);
    }
    if (proposal.risk === "high") {
      lines.push("    ⚠ 改的是工具判定为不安全的东西，对账证明不了运行时行为等价");
    }
    lines.push("");
  });

  if (adjusted.length > 0) {
    lines.push(`${adjusted.length} 处字段被强制改写：`);
    for (const item of adjusted) {
      lines.push(
        `    ${item.proposal.targetFile}#${item.proposal.targetSymbol}  ` +
          `${item.field}: ${item.from} → ${item.to}（${item.why}）`,
      );
    }
    lines.push("");
  }

  if (rejected.length > 0) {
    lines.push(`${rejected.length} 条方案未通过静态校验（不进入上面的列表，但可查）：`);
    for (const item of rejected) {
      lines.push(
        `    ${item.proposal.targetFile}#${item.proposal.targetSymbol}  ${item.reason}`,
      );
    }
    lines.push("");
  }

  if (accepted.length > 0) {
    lines.push(
      "逐条复核后用 --execute <序号> 执行其中一条。",
      "**没有「全部执行」**：这些改动正是工具判定为不安全、主动放弃的那些。",
    );
  }

  return lines.join("\n");
}
