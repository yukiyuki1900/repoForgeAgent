import { readFileSync } from "node:fs";
import { analyzeCycles } from "./analyzers.js";
import { applyTypeOnlyRefactor } from "./apply.js";
import { askCodebase, type AskResult } from "./ask.js";
import { extractGraph } from "./graph.js";
import type { Model } from "./llm.js";
import { formatPlan, planTypeOnlyRefactor, type RefactorPlan } from "./refactor.js";
import { scanFiles } from "./scanner.js";
import type { TaskEvent } from "./tasks.js";
import { buildIndex } from "./tools.js";

/**
 * 任务体：三种模式各自「干什么」。
 *
 * 从路由里抽出来是为了能测。API 层剩下的只有参数校验与 SSE 接线，
 * 而**返回值的形状**才是最容易出错的地方——前端的 TypeScript 接口是
 * 手写的，字段名少一个字母不会有任何编译错误，只会在页面上显示成空白。
 * 抽成纯函数之后，这层契约可以直接断言。
 */

export type Emit = (event: Omit<TaskEvent, "at">) => void;

export interface RefactorJobResult {
  applied: boolean;
  plan: RefactorPlan | null;
  text: string;
  outcome?: {
    status: string;
    edits: unknown[];
    skipped: unknown[];
    typecheck?: unknown;
    cycles?: unknown;
    reason?: string;
    outputDir?: string;
    diff?: string;
  };
}

export async function runRefactorJob(
  root: string,
  apply: boolean,
  emit: Emit,
): Promise<RefactorJobResult> {
  emit({ channel: "step", label: "扫描仓库" });
  const { files, contents } = await scanFiles(root);
  if (files.length === 0) throw new Error(`在 ${root} 下没有找到可分析的源码文件`);
  emit({ channel: "step", label: "扫描仓库", detail: `${files.length} 个文件` });

  const { edges } = extractGraph(root, files, contents);
  const cycles = analyzeCycles(files, edges);
  emit({ channel: "step", label: "检测循环依赖", detail: `${cycles.length} 处` });

  if (cycles.length === 0) {
    return { applied: false, plan: null, text: "没有循环依赖，无需改造" };
  }

  if (!apply) {
    const plan = planTypeOnlyRefactor({ root, files, contents, edges, cycles });
    emit({
      channel: "step",
      label: "生成改造计划",
      detail: `${plan.cyclesBefore} 个环 → ${plan.cyclesAfter} 个环`,
    });
    return { applied: false, plan, text: formatPlan(plan) };
  }

  const outcome = await applyTypeOnlyRefactor({
    root,
    files,
    contents,
    edges,
    cycles,
    onStep: (message) => emit({ channel: "step", label: "改造", detail: message }),
  });

  return {
    applied: true,
    plan: outcome.plan,
    text: formatPlan(outcome.plan, { dryRun: false }),
    outcome: {
      status: outcome.status,
      edits: outcome.edits,
      skipped: outcome.skipped,
      typecheck: outcome.typecheck,
      cycles: outcome.cycles,
      reason: outcome.reason,
      outputDir: outcome.outputDir,
      diff: readDiff(outcome.diffPath),
    },
  };
}

export async function runAskJob(
  root: string,
  question: string,
  model: Model,
  emit: Emit,
  maxSteps?: number,
  onTextDelta?: (delta: string) => void,
): Promise<AskResult> {
  emit({ channel: "step", label: "建立索引" });
  const index = await buildIndex(root);
  emit({
    channel: "step",
    label: "建立索引",
    detail: `${index.files.length} 个文件 · ${index.symbols.length} 个符号`,
  });

  return askCodebase({
    model,
    index,
    question,
    maxSteps,
    onToolCall: (call) => emit({ channel: "tool", label: call.name, detail: call.summary }),
    onTextDelta,
  });
}

/** diff 直接回传给前端展示，读不到就算了，不影响主结果 */
function readDiff(diffPath?: string): string | undefined {
  if (!diffPath) return undefined;
  try {
    return readFileSync(diffPath, "utf8");
  } catch {
    return undefined;
  }
}
