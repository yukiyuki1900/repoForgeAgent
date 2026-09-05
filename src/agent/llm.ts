import { createOpenAI } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { z } from "zod";
import type { QueryPlan } from "../analyze/retrieval.js";

export type LanguageModel = Parameters<typeof generateObject>[0]["model"];

const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * 从环境变量解析模型，未配置时返回 undefined。
 *
 * 调用方必须能在没有模型的情况下继续工作——分析流水线的事实部分
 * 全部由确定性代码产出，LLM 只负责解释，缺席时降级即可，不应让整个流程失败。
 *
 * 环境变量：
 * - OPENAI_API_KEY     必填，缺失即视为未配置
 * - OPENAI_BASE_URL    可选，用于对接 OpenAI 兼容网关（如 DeepSeek）
 * - REPOSURGEON_MODEL  可选，默认 gpt-4o-mini
 */
export function resolveModel(): LanguageModel | undefined {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const provider = createOpenAI({ apiKey, baseURL: process.env.OPENAI_BASE_URL });
  return provider(process.env.REPOSURGEON_MODEL ?? DEFAULT_MODEL);
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
 * 注意：默认工作流当前使用的是 retrieval.ts 的规则实现 parseQueryPlan，
 * 该函数需要显式传入 model 才会被调用。
 */
export async function parseQueryWithModel(model: LanguageModel, query: string): Promise<QueryPlan> {
  const { object } = await generateObject({
    model,
    schema: queryPlanSchema,
    prompt: `${PROMPT_PREFIX}\n\n${query}`,
  });
  return object;
}
