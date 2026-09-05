import { generateObject } from "ai";
import { z } from "zod";
import { renderProposalFacts, type ProposalFacts } from "../analyze/facts.js";
import type { LanguageModel } from "../agent/llm.js";
import { stepSignal, TIMEOUTS } from "../core/limits.js";

/**
 * 让模型对「规则主动放弃的那部分」提方案。
 *
 * 这是整个项目里模型唯一参与**决策**的地方——前两条改造链路模型参与度是零。
 * 边界设计见 `docs/PROPOSAL.md`，这里只负责把它翻译成 schema 与一次调用。
 *
 * 两条设计原则，都体现在 schema 里而不是提示词里：
 *
 * 1. **模型输出指令，不输出代码。** operations 是机械可执行的结构化指令，
 *    由 ts-morph 执行，语法由编译器保证。让模型生成 diff 只会拿到语法错误
 *    加幻觉 API，而且无法验证。
 * 2. **每个方案必须带可证伪的预测。** `prediction.exportsRemoved` 是
 *    `z.number().int().positive()`——**一个没有数字预测的方案在类型层面就无法存在**。
 *    这不是提示词里的一句请求，是结构约束。执行后用确定性代码对账，不符即回滚。
 *
 * 提示词里说了什么不重要，模型能输出什么由 schema 决定。
 */

/**
 * 一条机械可执行的指令。
 *
 * 刻意用扁平结构而不是 discriminated union：结构化输出对嵌套 union 的支持
 * 在各家网关上表现不一，而这里真正需要 schema 保证的只有「字段类型对」。
 * **哪些字段组合合法是语义问题，交给 C3 的静态校验**——那一层能查符号是否
 * 真的存在，schema 查不了。
 */
export const operationSchema = z.object({
  op: z
    .enum(["delete-file", "unexport", "delete-declaration"])
    .describe("要执行的动作。delete-file 删整个文件，其余两个针对单个符号"),
  file: z.string().describe("目标文件的仓库相对路径"),
  symbol: z.string().describe("目标符号名。op 为 delete-file 时填空字符串"),
});

export const predictionSchema = z.object({
  exportsRemoved: z
    .number()
    .int()
    .positive()
    .describe("执行这个方案后，全仓具名导出总数会减少多少个。必须是准确数字，执行后会逐一核对"),
  filesRemoved: z.number().int().nonnegative().describe("会删掉几个文件。不删文件时填 0"),
});

export const proposalSchema = z.object({
  kind: z
    .enum(["delete-file", "unexport-symbol", "delete-with-dependencies"])
    .describe("方案类型，只能是这三种"),
  targetFile: z.string().describe("方案针对的主文件，仓库相对路径"),
  targetSymbol: z
    .string()
    .describe("方案针对的主符号名。必须是候选清单里出现过的符号，不能是你自己发现的"),
  rationale: z
    .string()
    .describe("为什么可以这么做，针对「工具的理由」逐点回应。给人看的，100 字以内"),
  operations: z.array(operationSchema).min(1).describe("机械可执行的指令序列"),
  prediction: predictionSchema,
  risk: z
    .enum(["low", "medium", "high"])
    .describe("风险等级。delete-with-dependencies 一律为 high"),
});

export const proposalBatchSchema = z.object({
  proposals: z
    .array(proposalSchema)
    .describe("方案列表。没有把握的候选就不要提，宁可少提也不要凑数"),
});

export type Operation = z.infer<typeof operationSchema>;
export type Proposal = z.infer<typeof proposalSchema>;

export interface ProposeResult {
  proposals: Proposal[];
  elapsedMs: number;
}

const SYSTEM_PROMPT = [
  "你在协助清理一个 TypeScript / 前端仓库里没人使用的导出。",
  "",
  "重要背景：**机械上安全的清理已经由确定性规则自动完成了，不需要你参与。**",
  "交给你的是规则主动放弃的部分——工具检出了问题但不敢动，或者压根没把它们算作死代码。",
  "每一条都附带了工具拒绝它的确切原因，你的任务是针对那个原因逐点回应。",
  "",
  "你只能提三种方案：",
  "",
  "1. delete-file —— 删除整个文件。",
  "   前提：该文件所有导出都已判定为死、没有任何文件 import 它、顶层无副作用语句。",
  "   这三条上下文里都给了，不满足就不要提。",
  "",
  "2. unexport-symbol —— 去掉 export 关键字，或删除整条声明。",
  "   适用于被规则排除但其实不是对外 API 的导出。",
  "   同文件内还有引用时只能去 export，不能删声明。",
  "",
  "3. delete-with-dependencies —— 删除死导出，并连带删除只被它使用的私有声明。",
  "   风险等级一律填 high。",
  "",
  "硬性规则：",
  "",
  "- **targetSymbol 必须来自上面的候选清单。** 不要提清单外的符号，那些没有经过检测，你看不到它们的引用情况。",
  "- **prediction 必须准确。** 执行后会重新扫描仓库核对导出总数，对不上整个方案会被回滚。",
  "  一个方案通常让导出数减少 1；delete-file 减少的是该文件的导出数。",
  "- **不确定就不提。** 漏掉一个死导出的代价是几十字节，误删一个还在用的导出是线上事故。",
  "  一条方案都提不出来是完全可以接受的答案。",
  "- 不要输出代码，只输出 operations 里的结构化指令。",
  "- 不要提修改函数体、跨文件搬运符号、调整目录结构这类方案，它们不在可执行范围内。",
].join("\n");

export async function proposeCleanup(
  model: LanguageModel,
  facts: ProposalFacts,
  signal?: AbortSignal,
): Promise<ProposeResult> {
  // 没有候选就不要浪费一次调用——模型面对空清单只会编
  if (facts.candidates.length === 0) {
    return { proposals: [], elapsedMs: 0 };
  }

  const started = Date.now();

  const { object } = await generateObject({
    model,
    schema: proposalBatchSchema,
    system: SYSTEM_PROMPT,
    prompt: renderProposalFacts(facts),
    abortSignal: stepSignal(signal, TIMEOUTS.modelCall),
  });

  return { proposals: object.proposals, elapsedMs: Date.now() - started };
}
