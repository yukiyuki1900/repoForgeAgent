import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { QueryPlan } from "../analyze/retrieval.js";

export type LanguageModel = Parameters<typeof generateObject>[0]["model"];

/**
 * 默认模型名。
 *
 * **它只在官方端点上有效**，所以只有在没配 `OPENAI_BASE_URL` 时才拿它兜底。
 * 这是一条和「兜底超时按 kind 推导」同源的规则，方向却相反：
 *
 * - 超时能从已有信息**完备地**推出来 → 推，别靠人记得传
 * - 而「这个网关上叫什么模型名」**推不出来** → 必须显式传，漏传要报错
 *
 * 判据是同一个：**信息在谁手里，决定权就在谁那里。**
 */
const DEFAULT_MODEL = "gpt-4o-mini";

/** 官方端点。指向这里时默认模型名是成立的 */
const OFFICIAL_HOST = "api.openai.com";

export type ModelProblem = "missing-key" | "gateway-without-model";

/**
 * 配置有没有毛病，没毛病返回 undefined。
 *
 * ## `gateway-without-model` 这一类是踩出来的
 *
 * `OPENAI_BASE_URL` 和 `REPOSURGEON_MODEL` 是**一对**：换了网关，模型名
 * 几乎必然也要跟着换。但此前它们是两个独立的可选项，只配前者不配后者时，
 * 代码会拿着 `gpt-4o-mini` 这个名字去请求 DeepSeek 的端点——
 * 拿回来的是一句「模型不存在」，**而报错里没有任何东西会告诉你
 * 「你的 baseURL 和 model 不配套」**。
 *
 * 这和「兜底超时漏传就静默拿到五分钟」是同一类问题：
 * **两个配置项之间有隐含依赖，漏配一个不报错，只在运行时给出一个
 * 难以定位的错误。** 与其让用户去猜，不如在这里直接判定为配置错误。
 *
 * 做成不依赖 `process.env` 的纯函数，是为了让它可测——**一个专门用来
 * 报配置错误的函数，自己不该只能靠改全局变量来验证。**
 */
export function checkModelConfig(env: NodeJS.ProcessEnv = process.env): ModelProblem | undefined {
  if (!env.OPENAI_API_KEY) return "missing-key";

  const baseURL = env.OPENAI_BASE_URL?.trim();
  const model = env.REPOSURGEON_MODEL?.trim();
  if (model) return undefined;

  // 没配模型名时，只有官方端点能靠默认值兜住
  if (baseURL && !baseURL.includes(OFFICIAL_HOST)) return "gateway-without-model";
  return undefined;
}

/**
 * 配置有问题时说给用户听的那句话。
 *
 * 两种问题的**修法完全不同**，所以文案必须分开：一个是「去配 key」，
 * 一个是「你配了，但配了一半」。压成同一句「模型未配置」的话，
 * 后一种情况下用户会去检查一个本来就没问题的 key。
 *
 * 文案由这一处出，`api.ts` 和 `cli.ts` 都取它——同一件事长出两种说法，
 * 改口径就要改两个地方。
 */
export function describeModelProblem(problem: ModelProblem): string {
  if (problem === "missing-key") {
    return "ask 需要模型：确定性分析可以没有 LLM，但「自己决定查什么」不行。请在 .env 配置 OPENAI_API_KEY";
  }
  return (
    "配了 OPENAI_BASE_URL 却没配 REPOSURGEON_MODEL。" +
    `这两项是一对：默认模型名（${DEFAULT_MODEL}）只在 OpenAI 官方端点上存在，` +
    "拿它去请求别的网关只会得到一句「模型不存在」。请显式指定模型名，例如 deepseek-chat。"
  );
}

/**
 * `resolveModel()` 返回 undefined 之后，给用户看的那句话。
 *
 * 调用方只知道「没拿到模型」，**不知道为什么**——原因留在这个模块里，
 * 让每个 caller 自己去读环境变量判断，等于把同一段判断抄三遍。
 */
export function describeModelUnavailable(env: NodeJS.ProcessEnv = process.env): string {
  return describeModelProblem(checkModelConfig(env) ?? "missing-key");
}

/**
 * 从环境变量解析模型，未配置或配置有毛病时返回 undefined。
 *
 * 调用方必须能在没有模型的情况下继续工作——分析流水线的事实部分
 * 全部由确定性代码产出，LLM 只负责解释，缺席时降级即可，不应让整个流程失败。
 *
 * 环境变量：
 * - OPENAI_API_KEY     必填，缺失即视为未配置
 * - OPENAI_BASE_URL    可选，用于对接 OpenAI 兼容网关（如 DeepSeek）
 * - REPOSURGEON_MODEL  可选，**但配了非官方 baseURL 时必填**
 */
export function resolveModel(): LanguageModel | undefined {
  const problem = checkModelConfig();
  if (problem) {
    // 缺 key 是常态（不配 LLM 也能用），不值得每次都喊；
    // 而配了一半是**用户以为自己配好了**，必须出声
    if (problem === "gateway-without-model") warnOnce(describeModelProblem(problem));
    return undefined;
  }

  const provider = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  return provider(process.env.REPOSURGEON_MODEL ?? DEFAULT_MODEL);
}

let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[llm] ${message}`);
}

export const queryPlanSchema = z.object({
  concepts: z.array(z.string()).describe("业务概念和同义词"),
  symbolKinds: z.array(z.string()).describe("需要检索的符号类型"),
  relationKinds: z.array(z.string()).describe("需要追踪的关系类型"),
  terms: z.array(z.string()).describe("用于全文检索的关键词"),
});

const PROMPT_PREFIX = "把下面的代码检索问题转换为结构化查询计划，只输出 JSON。";

/**
 * LLM 版查询计划解析。
 *
 * ## 它在默认工作流里是**主路径**，不是备选
 *
 * `workflow.ts` 的 `defaultQueryPlanner`：**有模型就用这个**，
 * 只有两种情况会退回 `retrieval.ts` 的规则实现 `parseQueryPlan`——
 * 没配模型，或者这次调用抛了错（`catch` 里兜住，不让检索整个失败）。
 *
 * 规则版靠 `CONCEPT_MAP` 做中文到标识符的映射，覆盖不了长尾表达。
 * 这正是 LLM 该干的活：**把意图翻译成检索词，而不是替代检索本身**——
 * 翻译完之后的 `hybridRetrieve` 仍然是纯确定性的。
 */
export async function parseQueryWithModel(model: LanguageModel, query: string): Promise<QueryPlan> {
  const { object } = await generateObject({
    model,
    schema: queryPlanSchema,
    prompt: `${PROMPT_PREFIX}\n\n${query}`,
  });
  return object;
}
