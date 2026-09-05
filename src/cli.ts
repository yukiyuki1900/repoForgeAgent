#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { analyzeCycles } from "./analyze/analyzers.js";
import { applyTypeOnlyRefactor, formatApplyResult } from "./refactor/apply.js";
import { askCodebase, formatAskResult } from "./agent/ask.js";
import { planDeadExportRemoval } from "./analyze/deadexports.js";
import { loadEnv } from "./core/env.js";
import { applyProposal, formatExecution } from "./refactor/execute.js";
import { resolveModel } from "./agent/llm.js";
import { buildIndex } from "./agent/tools.js";
import { extractGraph } from "./scan/graph.js";
import { applyDeadExportRemoval, formatPruneResult } from "./refactor/prune.js";
import { formatProposalFlow, proposeAndValidate } from "./refactor/proposalflow.js";
import { formatPlan, planTypeOnlyRefactor } from "./refactor/refactor.js";
import { scanFiles } from "./scan/scanner.js";
import { runAnalysis, type ProgressEvent, type WorkflowState } from "./workflow.js";

interface AnalyzeOptions {
  json?: boolean;
  query?: string;
  full?: boolean;
}

interface RefactorOptions {
  dryRun?: boolean;
  apply?: boolean;
  deadExports?: boolean;
  propose?: boolean;
  execute?: string;
}

interface AskOptions {
  maxSteps?: string;
  json?: boolean;
}

// 必须在读取任何配置之前加载
loadEnv();

const program = new Command()
  .name("reposurgeon")
  .description("Front-end repository semantic analyzer");

program
  .command("analyze")
  .argument("<directory>", "本地仓库目录")
  .option("--query <query>", "自然语言检索问题")
  .option("--full", "忽略意图裁剪，跑满全部节点")
  .option("--json", "仅输出 JSON")
  .action(async (directory: string, options: AnalyzeOptions) => {
    const workflow = await runAnalysis(directory, {
      query: options.query,
      full: options.full,
      // JSON 模式下保持输出纯净，不混入进度行
      onProgress: options.json ? undefined : printProgress,
    });
    if (!workflow.report) return;

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ...workflow.report,
            queryPlan: workflow.queryPlan,
            retrieval: workflow.retrieval,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(formatSummary(workflow));
  });

/** 节点结束时打一行，start 事件不输出，避免并行节点交错刷屏 */
function printProgress(event: ProgressEvent): void {
  if (event.phase === "start") return;

  const mark = event.phase === "end" ? "✓" : "✗";
  const elapsed = `${event.durationMs ?? 0}ms`.padStart(8);
  const detail = event.detail ? `  ${event.detail}` : "";
  console.log(`  ${mark} ${event.node.padEnd(20)}${elapsed}${detail}`);
}

function formatSummary(workflow: WorkflowState): string {
  const detail = workflow.retrieval.length
    ? `检索结果：${workflow.retrieval.map((item) => item.path).join("、")}`
    : `Mermaid：${workflow.mermaid}`;

  const skipped = workflow.executionPlan?.decisions.filter((item) => !item.run) ?? [];
  const narration = workflow.narration
    ? `架构解读：${workflow.narration.summary}`
    : `架构解读：${skipped.some((item) => item.node === "narrate") ? "按执行计划跳过（加 --full 可强制生成）" : "未配置模型，仅输出确定性分析结果"}`;

  const artifacts = path.join(workflow.root, ".reposurgeon");

  return [
    `分析完成：${workflow.files.length} 个文件，${workflow.edges.length} 条依赖边，${workflow.findings.length} 个发现`,
    ...(skipped.length > 0
      ? [`本次跳过：${skipped.map((item) => `${item.node}（${item.why}）`).join("；")}`]
      : []),
    narration,
    detail,
    "",
    `产物目录：${artifacts}`,
    `  报告   ${path.join(artifacts, "reports")}/report.{html,md,json}`,
    `  索引   ${path.join(artifacts, "index.db")}`,
    `  在 Web 看板里填入 ${workflow.root} 可直接加载这次结果`,
  ].join("\n");
}

program
  .command("refactor")
  .argument("<directory>", "本地仓库目录")
  .option("--dry-run", "只输出改造计划，不写入任何文件（默认）")
  .option("--apply", "写入改动，并用类型检查与结构对账验证；验证失败自动回滚")
  .option("--dead-exports", "改为清理未使用的导出（默认是用 import type 打破循环依赖）")
  .option("--propose", "让模型对「规则主动放弃的那部分」提方案，只列出不执行")
  .option(
    "--execute <序号>",
    "执行 --propose 列出的第 N 条方案。刻意只接受单个序号，没有「全部执行」",
  )
  .action(async (directory: string, options: RefactorOptions) => {
    const root = path.resolve(directory);
    const { files, contents } = await scanFiles(root);

    if (files.length === 0) {
      throw new Error(`在 ${root} 下没有找到可分析的源码文件`);
    }
    console.log(`  ✓ 扫描 ${files.length} 个文件`);

    if (options.propose) {
      await runPropose(root, files, contents, options.execute);
      return;
    }

    if (options.deadExports) {
      await runDeadExports(root, files, contents, Boolean(options.apply));
      return;
    }

    const { edges } = extractGraph(root, files, contents);
    const cycles = analyzeCycles(files, edges);
    console.log(`  ✓ 检测到 ${cycles.length} 处循环依赖\n`);

    if (cycles.length === 0) {
      console.log("没有循环依赖，无需改造");
      return;
    }

    if (!options.apply) {
      const plan = planTypeOnlyRefactor({ root, files, contents, edges, cycles });
      console.log(formatPlan(plan));
      console.log("\n确认无误后加 --apply 写入（会先做类型检查与环数对账，不通过自动回滚）");
      return;
    }

    const result = await applyTypeOnlyRefactor({
      root,
      files,
      contents,
      edges,
      cycles,
      onStep: (message) => console.log(`  · ${message}`),
    });

    console.log(`\n${formatPlan(result.plan, { dryRun: false })}\n`);
    console.log(formatApplyResult(result));

    // 回滚与放弃都不是崩溃，但不该被 CI 当成成功
    if (result.status === "rolled-back" || result.status === "aborted") {
      process.exitCode = 1;
    }
  });

/**
 * 提方案的命令行分支。
 *
 * 和前两条链路的交互**刻意不同**：那两条是 `--apply` 一把梭，因为改的是
 * 规则判定安全的机械变换。这条改的正是工具判定为不安全、主动放弃的东西，
 * 所以拆成两步——先列出，人挑一条，`--execute <序号>` 执行那一条。
 *
 * **没有「全部执行」，这是设计，不是没来得及做。**
 */
async function runPropose(
  root: string,
  files: Awaited<ReturnType<typeof scanFiles>>["files"],
  contents: Map<string, string>,
  execute?: string,
): Promise<void> {
  const model = resolveModel();
  if (!model) {
    console.log("需要配置模型才能提方案：设置 OPENAI_API_KEY 或 ANTHROPIC_API_KEY 后重试");
    process.exitCode = 1;
    return;
  }

  const flow = await proposeAndValidate({
    root,
    files,
    contents,
    model,
    onStep: (message) => console.log(`  · ${message}`),
  });

  console.log(`\n${formatProposalFlow(flow)}`);

  if (execute === undefined) return;

  const index = Number.parseInt(execute, 10);
  const chosen = flow.validation.accepted[index - 1];
  if (!Number.isInteger(index) || !chosen) {
    console.log(
      `\n序号 ${execute} 无效：当前只有 ${flow.validation.accepted.length} 条通过校验的方案`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\n执行第 ${index} 条…`);
  const result = await applyProposal({
    root,
    files,
    contents,
    proposal: chosen,
    onStep: (message) => console.log(`  · ${message}`),
  });

  console.log(`\n${formatExecution(result)}`);

  // 回滚与放弃都不是崩溃，但不该被 CI 当成成功
  if (result.status === "rolled-back" || result.status === "aborted") {
    process.exitCode = 1;
  }
}

/**
 * 死导出清理的命令行分支。
 *
 * 和拆环走同一套交互：不加 `--apply` 只出计划，加了才写盘并验证。
 * 区别只在第二层验证拿什么对账——那边是环数，这里是导出总数。
 */
async function runDeadExports(
  root: string,
  files: Awaited<ReturnType<typeof scanFiles>>["files"],
  contents: Map<string, string>,
  apply: boolean,
): Promise<void> {
  if (!apply) {
    const plan = planDeadExportRemoval({ root, files, contents });
    console.log(`  ✓ 检出 ${plan.exportsBefore} 个具名导出\n`);
    console.log(formatDeadExportPlan(plan));
    console.log("\n确认无误后加 --apply 写入（会先做类型检查与导出数对账，不通过自动回滚）");
    return;
  }

  const result = await applyDeadExportRemoval({
    root,
    files,
    contents,
    onStep: (message) => console.log(`  · ${message}`),
  });

  console.log(`\n${formatPruneResult(result)}`);

  // 回滚与放弃都不是崩溃，但不该被 CI 当成成功
  if (result.status === "rolled-back" || result.status === "aborted") {
    process.exitCode = 1;
  }
}

function formatDeadExportPlan(plan: ReturnType<typeof planDeadExportRemoval>): string {
  const lines = ["─".repeat(60)];

  if (plan.edits.length === 0) {
    lines.push("没有可安全清理的导出");
  } else {
    lines.push(
      `可清理 ${plan.edits.length} 个导出，${plan.exportsBefore} → ${plan.exportsAfter}`,
      "",
    );
    for (const edit of plan.edits) {
      const how = edit.action === "unexport" ? "去掉 export" : "删除整条声明";
      lines.push(`  ${edit.file}:${edit.line}  ${edit.symbol}  → ${how}`);
    }
  }

  if (plan.testOnly.length > 0) {
    lines.push("", `${plan.testOnly.length} 个导出只被测试引用（不自动处理）：`);
    for (const item of plan.testOnly) {
      lines.push(`  ${item.file}:${item.line}  ${item.symbol}`);
    }
  }

  // 「没检出」和「检出了但不敢动」是两回事，后者才是需要人看的
  if (plan.blocked.length > 0) {
    lines.push("", `${plan.blocked.length} 个判定该清理但不敢动：`);
    for (const item of plan.blocked) {
      lines.push(`  ${item.file}  ${item.symbol}  ${item.reason}`);
    }
  }

  return lines.join("\n");
}

program
  .command("ask")
  .argument("<directory>", "本地仓库目录")
  .argument("<question>", "关于这个仓库的问题")
  .option("--max-steps <n>", "工具调用轮次上限", "8")
  .option("--json", "仅输出 JSON")
  .action(async (directory: string, question: string, options: AskOptions) => {
    const model = resolveModel();
    if (!model) {
      throw new Error(
        "ask 需要模型：确定性分析可以没有 LLM，但「自己决定查什么」不行。\n" +
          "请在 .env 里配置 OPENAI_API_KEY（兼容网关再配 OPENAI_BASE_URL）",
      );
    }

    let streamed = false;
    const index = await buildIndex(directory);
    if (!options.json) {
      console.log(
        `  ✓ 索引 ${index.files.length} 个文件 · ${index.symbols.length} 个符号 · ${index.edges.length} 条边\n`,
      );
    }

    const result = await askCodebase({
      model,
      index,
      question,
      maxSteps: Number(options.maxSteps) || 8,
      // 工具调用实时打印：模型的推理路径本身就是答案可信度的一部分
      onToolCall: options.json
        ? undefined
        : (call) => {
            if (streamed) process.stdout.write("\n");
            streamed = false;
            console.log(`  → ${call.name.padEnd(18)} ${call.summary}`);
          },
      // 回答边生成边打印，不让终端干等十几秒
      onTextDelta: options.json
        ? undefined
        : (delta) => {
            if (!streamed) {
              process.stdout.write(`\n${"─".repeat(60)}\n`);
              streamed = true;
            }
            process.stdout.write(delta);
          },
    });

    if (streamed) process.stdout.write("\n");
    console.log(options.json ? JSON.stringify(result, null, 2) : formatAskResult(result, streamed));

    // 撞上限说明没查完，不该被脚本当成成功
    if (result.exhausted) process.exitCode = 1;
  });

program.parseAsync().catch((error) => {
  console.error(formatFatal(error));
  process.exitCode = 1;
});

/** 依赖缺失时给出可操作的下一步，而不是甩一段模块解析栈 */
function formatFatal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return `${message}\n\n依赖可能未安装或已过期（拉取新代码后需要重新安装），请先执行：\n  pnpm install`;
  }
  return message;
}
