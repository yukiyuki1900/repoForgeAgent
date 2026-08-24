#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { runAnalysis, type ProgressEvent, type WorkflowState } from "./workflow.js";

interface AnalyzeOptions {
  json?: boolean;
  query?: string;
}

const program = new Command()
  .name("reposurgeon")
  .description("Front-end repository semantic analyzer");

program
  .command("analyze")
  .argument("<directory>", "本地仓库目录")
  .option("--query <query>", "自然语言检索问题")
  .option("--json", "仅输出 JSON")
  .action(async (directory: string, options: AnalyzeOptions) => {
    const workflow = await runAnalysis(directory, {
      query: options.query,
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

  const narration = workflow.narration
    ? `架构解读：${workflow.narration.summary}`
    : "架构解读：未配置模型，仅输出确定性分析结果";

  const artifacts = path.join(workflow.root, ".reposurgeon");

  return [
    `分析完成：${workflow.files.length} 个文件，${workflow.edges.length} 条依赖边，${workflow.findings.length} 个发现`,
    narration,
    detail,
    "",
    `产物目录：${artifacts}`,
    `  报告   ${path.join(artifacts, "reports")}/report.{html,md,json}`,
    `  索引   ${path.join(artifacts, "index.db")}`,
    `  在 Web 看板里填入 ${workflow.root} 可直接加载这次结果`,
  ].join("\n");
}

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
