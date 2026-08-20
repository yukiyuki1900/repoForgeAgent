#!/usr/bin/env node
import { Command } from "commander";
import { runAnalysis, type WorkflowState } from "./workflow.js";

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
    const workflow = await runAnalysis(directory, options.query);
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

function formatSummary(workflow: WorkflowState): string {
  const detail = workflow.retrieval.length
    ? `检索结果：${workflow.retrieval.map((item) => item.path).join("、")}`
    : `Mermaid：${workflow.mermaid}`;

  const narration = workflow.narration
    ? `架构解读：${workflow.narration.summary}`
    : "架构解读：未配置模型，仅输出确定性分析结果";

  return [
    `分析完成：${workflow.files.length} 个文件，${workflow.edges.length} 条依赖边，${workflow.findings.length} 个发现`,
    `当前节点：${workflow.currentStep}`,
    narration,
    detail,
  ].join("\n");
}

program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
