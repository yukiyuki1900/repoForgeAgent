/**
 * 失败分类。
 *
 * ## 为什么一个字符串不够
 *
 * 原来 `record.error` 只有一句人话。它同时要服务三种读者，而三种都没服务好：
 *
 * - **用户**看不出「这是我的问题还是它的问题」，也不知道该不该重试
 * - **界面**没法据此决定给不给重试入口——只能一律给，或者一律不给
 * - **排障的人**没法按类型聚合，只能 grep 一句可能随时被改掉的中文
 *
 * 所以拆成三个字段：`code` 给机器分类，`message` 给人看，`retriable`
 * 直接回答那个唯一真正影响用户行为的问题——**再点一次有没有用**。
 *
 * ## 为什么在抛出点打标，而不是事后猜
 *
 * 事后靠正则匹配错误文案是最脆的做法：**改一句提示语，分类就静默失效**，
 * 而且没有任何测试会因此变红。所以已知的失败在**抛出的地方**就带上分类，
 * `classify()` 只负责认领这些标记、以及给没打标的兜一个 `internal`。
 *
 * 这和工具事件回填那条是同一个道理：能在源头确定的事，别放到下游去推断。
 */

/**
 * 失败类型。
 *
 * 刻意保持得少。分类的价值在于**能据此做不同的事**，而不在于分得细——
 * 多一个没人会区别对待的 code，只是多一个要维护的枚举值。
 */
export type FailureCode =
  | "timeout" // 某一步超时：模型调用、git 子进程
  | "model" // 模型调用失败：鉴权、限流、网关错误
  | "git" // git 命令失败：仓库脏、锁被占、不是仓库
  | "input" // 输入本身有问题：路径下没有源码
  | "internal"; // 兜底。出现得多说明分类该补了

export interface TaskFailure {
  code: FailureCode;
  message: string;
  /**
   * 重试有没有意义。
   *
   * **这是整个结构里唯一直接决定界面行为的字段**：为真才给重试入口。
   * 给一个必然再次失败的操作配重试按钮，是把无能为力包装成了选择。
   */
  retriable: boolean;
}

/** 哪些类型重试才有意义 */
const RETRIABLE: Record<FailureCode, boolean> = {
  // 超时和模型故障多半是瞬时的：网关抖动、限流、这一次刚好慢
  timeout: true,
  model: true,
  // 仓库脏、路径下没源码——再点一次结果一模一样
  git: false,
  input: false,
  // 不知道是什么就别承诺能好
  internal: false,
};

/** 带分类的错误。在**抛出的地方**打标，不留给下游猜 */
export class TaskError extends Error {
  readonly retriable: boolean;

  constructor(
    readonly code: FailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TaskError";
    this.retriable = RETRIABLE[code];
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把任何抛出来的东西归成一类。
 *
 * 只认三种线索，都不是文案匹配：
 * 1. 我们自己打的标（`TaskError`）
 * 2. 平台给的标准错误名——`AbortSignal.timeout()` 触发时是 `TimeoutError`
 * 3. 子进程超时的 `ETIMEDOUT` / `killed`
 */
export function classify(error: unknown): TaskFailure {
  if (error instanceof TaskError) {
    return { code: error.code, message: error.message, retriable: error.retriable };
  }

  const code = detect(error);
  return { code, message: messageOf(error), retriable: RETRIABLE[code] };
}

function detect(error: unknown): FailureCode {
  if (typeof error !== "object" || error === null) return "internal";

  // `AbortSignal.timeout()` 触发时抛的是 name 为 TimeoutError 的 DOMException。
  // 这是**平台定义的**名字，不是我们的文案，改提示语不会影响它
  const { name, code } = error as { name?: string; code?: string };
  if (name === "TimeoutError") return "timeout";
  // execFileSync 撞上 timeout 选项时是 ETIMEDOUT
  if (code === "ETIMEDOUT") return "timeout";

  return "internal";
}
