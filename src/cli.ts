#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { analyzeCycles } from "./analyzers.js";
import { applyTypeOnlyRefactor, formatApplyResult } from "./apply.js";
import { askCodebase, formatAskResult } from "./ask.js";
import { loadEnv } from "./env.js";
import { resolveModel } from "./llm.js";
import { buildIndex } from "./tools.js";
import { extractGraph } from "./graph.js";
import { formatPlan, planTypeOnlyRefactor } from "./refactor.js";
import { scanFiles } from "./scanner.js";
import { runAnalysis, type ProgressEvent, type WorkflowState } from "./workflow.js";

interface AnalyzeOptions {
  json?: boolean;
  query?: string;
  full?: boolean;
}

interface RefactorOptions {
  dryRun?: boolean;
  apply?: boolean;
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
  .option("--apply", "写入改动，并用类型检查与环数对账验证；验证失败自动回滚")
  .action(async (directory: string, options: RefactorOptions) => {
    const root = path.resolve(directory);
    const { files, contents } = await scanFiles(root);

    if (files.length === 0) {
      throw new Error(`在 ${root} 下没有找到可分析的源码文件`);
    }
    console.log(`  ✓ 扫描 ${files.length} 个文件`);

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
