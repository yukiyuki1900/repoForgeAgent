import { streamText } from "ai";

import { TaskError } from "./failure.js";
import type { Model } from "./llm.js";
import { createTools, type CodebaseIndex, type ToolCall } from "./tools.js";
import { stepSignal, TIMEOUTS } from "./limits.js";

/**
 * 让模型自己决定查什么。
 *
 * 项目其余部分是**我们编排模型**：流水线的每一步都写死，LLM 只在 narrate
 * 这一个节点里做一次一问一答的结构化输出。这里相反，是**模型编排自己**——
 * 它拿到八个只读工具，自行决定调用顺序、调几轮、什么时候够了。
 *
 * 之所以敢把控制权交出去，是因为这个场景满足三个条件：
 *
 * 1. **工具全部只读**，最坏情况是查了一堆无关的东西，不会改坏任何东西
 * 2. **答案可核对**：回答里必须带路径与行号，人能立刻验证
 * 3. **循环有硬边界**：轮次上限 + 工具输出上限，不会无限烧 token
 *
 * 反过来说，改造（`refactor --apply`）就绝不交给模型自主决策——
 * 那里每一步都能改坏代码，必须由确定性代码控制并用编译器验证。
 * 同一个项目里两种模式并存，边界就是「这一步做错了，代价是什么」。
 */

const SYSTEM_PROMPT = `你是一个代码库分析助手。用户会问关于某个前端仓库的问题，你通过工具查证后回答。

规则：
1. 先查证再回答。不要凭文件名、目录名或常见约定猜测代码做了什么——用 readSource 确认。
2. 回答里的每个事实都要能追溯到工具返回的数据，并标明来源，例如 \`src/utils/request/index.ts:259\`。
3. 工具返回 truncated 字段时，说明你看到的只是一部分，不要把它当成全部。
4. 工具返回 error 和 suggestions 时，从 suggestions 里挑一个重试，不要换个名字继续猜。
5. 查不到就直说查不到，并说明你查了什么。编造一个合理的答案比承认查不到糟糕得多。
6. 回答用中文。**直接给结论**，不要写「我已经收集了足够信息」「让我总结一下」这类开场白。
7. 需要「哪个模块被依赖最多」这类排名时用 listHotspots，不要逐个文件调 getDependents 去试。
8. 可以在同一轮里并行调用多个工具，能并行就不要串行。`;

export interface AskResult {
  question: string;
  answer: string;
  calls: ToolCall[];
  /**
   * 对话轮次。
   *
   * 注意它**不等于**工具调用次数：模型可以在同一轮里并行发起多个工具调用，
   * 实测 18 次调用只用了 6 轮。早先文档里写的「一轮只调一个工具」是错的。
   */
  steps: number;
  /** 是否是因为撞到轮次上限才停下的 */
  exhausted: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AskOptions {
  model: Model;
  index: CodebaseIndex;
  question: string;
  /** 轮次上限，撞到即停并如实标注 */
  maxSteps?: number;
  onToolCall?: (call: ToolCall) => void;
  /**
   * 回答的增量文本。
   *
   * 一次追问要跑十几秒，其间界面上如果只有一个转圈，用户无从判断
   * 是在正常工作还是已经卡死。工具调用能盖住前半程，最后生成回答的
   * 那几秒仍然是空白——这段就靠它填。
   */
  onTextDelta?: (delta: string) => void;
  /**
   * 取消信号。
   *
   * 不接它的话，「停止生成」只能做到前端不再显示——
   * 模型那边照吐不误，token 照烧。
   */
  signal?: AbortSignal;
}

const DEFAULT_MAX_STEPS = 8;

export async function askCodebase(options: AskOptions): Promise<AskResult> {
  const { model, index, question } = options;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  const { tools, calls } = createTools(index, { onCall: options.onToolCall });

  const stream = streamText({
    model,
    tools,
    maxSteps,
    // 任务级取消 + 单轮上限。8 轮各自计时，而不是共用一个总预算——
    // 一轮卡住不该把后面还没开始的几轮一起判死
    abortSignal: stepSignal(options.signal, TIMEOUTS.modelCall),
    system: SYSTEM_PROMPT,
    prompt: [
      `仓库概览：${index.files.length} 个文件、${index.symbols.length} 个符号、${index.edges.length} 条关系边、${index.cycles.length} 处循环依赖。`,
      "",
      `问题：${question}`,
    ].join("\n"),
  });

  // 模型这一段单独包起来，是为了在**抛出的地方**就把失败归成 `model` 类。
  // 这一类判定为可重试：鉴权过期以外，网关抖动和限流都是瞬时的。
  // 取消和超时不在这里改写——前者由任务层按 signal 判定，后者
  // `classify` 会认平台给的 `TimeoutError`，都比我们自己猜准
  let text: string;
  let stepList: Awaited<typeof stream.steps>;
  let usage: Awaited<typeof stream.usage>;
  try {
    // 必须把流消费完，text / steps / usage 才会兑现
    for await (const part of stream.fullStream) {
      if (part.type === "text-delta") options.onTextDelta?.(part.textDelta);
    }

    // 流式推送的是过程，最终结果以 SDK 汇总的为准：
    // 多步调用时中间轮次也可能吐字，累积值未必等于最后那段回答
    text = await stream.text;
    stepList = await stream.steps;
    usage = await stream.usage;
  } catch (error) {
    if (options.signal?.aborted || (error as { name?: string }).name === "TimeoutError")
      throw error;
    throw new TaskError("model", `模型调用失败：${describe(error)}`, error);
  }

  // 撞上限时最后一步通常还在调工具、没来得及给结论。
  // 这种情况必须标出来——一个被截断的回答看起来和完整回答没有区别
  const steps = stepList.length;
  const exhausted = steps >= maxSteps && text.trim().length === 0;

  return {
    question,
    answer: exhausted
      ? `（达到 ${maxSteps} 轮工具调用上限仍未得出结论，以下是已查到的线索）\n` +
        calls.map((call) => `- ${call.summary}`).join("\n")
      : text,
    calls,
    steps,
    exhausted,
    usage: usage
      ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
      : undefined,
  };
}

/**
 * 供 CLI 打印。
 *
 * `alreadyStreamed` 为真时说明回答已经边生成边打过了，这里只补统计行——
 * 否则同一段文字会在终端里出现两遍。
 */
export function formatAskResult(result: AskResult, alreadyStreamed = false): string {
  const lines = alreadyStreamed
    ? ["─".repeat(60)]
    : ["─".repeat(60), result.answer, "", "─".repeat(60)];

  lines.push(
    `工具调用 ${result.calls.length} 次 · ${result.steps} 轮${result.exhausted ? "（已达上限）" : ""}`,
  );
  if (result.usage) {
    lines.push(
      `token    输入 ${result.usage.promptTokens} · 输出 ${result.usage.completionTokens}`,
    );
  }

  return lines.join("\n");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
