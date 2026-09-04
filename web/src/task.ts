/**
 * 三种模式共用的任务客户端。
 *
 * 后端把 analyze / refactor / ask 统一成了「提交拿 taskId、进度走流、
 * 结束拉状态」，前端就不该再为每种模式各写一份订阅逻辑——
 * 复制出来的第二份迟早会漏掉某一处清理。
 *
 * ## 传输：格式还是 SSE，客户端换成了 fetch
 *
 * 这两件事经常被混为一谈。**SSE 是传输格式**（`text/event-stream` 的分帧），
 * **EventSource 是浏览器给它配的一个客户端实现**。换掉的是后者。
 * 帧解析在 `sse.ts`，换的理由也写在那里，一句话是：
 * **EventSource 的 `onerror` 里什么都拿不到，而且发不了自定义请求头**——
 * 前者让错误无法分类，后者让客户端的失败无法和服务端日志对上号。
 *
 * ## 三件容易只做一半的事
 *
 * **停止**：断开连接只是「不看了」，后台该跑还跑、token 照烧。
 * 真的要停，得调服务端的 cancel 接口。
 *
 * **重连**：后端一直支持中途接入回放（`Last-Event-ID`），
 * 现在重连由我们自己发起，于是可以做退避加抖动，也可以区分
 * 「重试有意义」和「重试也没用」——这是 EventSource 给不了的。
 *
 * **超时**：这里**不判断任务超时**。任务快慢只有服务端知道，它有自己的
 * 分层兜底；前端再设一道就有了两套真相。前端只判断一件自己有资格判断的
 * 事：**这条链路还通不通**，依据是服务端的定频心跳，不是进度事件的间隔。
 */

import { readSseFrames } from "./sse.js";
import { newTrace, shortTrace, type TraceContext } from "./trace.js";

export interface TaskAccepted {
  taskId: string;
  kind: "analyze" | "refactor" | "ask";
  status: string;
  statusUrl: string;
  eventsUrl: string;
  traceId: string;
}

export interface TaskEvent {
  at: string;
  /** node = 工作流节点 · step = 改造步骤 · tool = 工具调用 */
  channel: "node" | "step" | "tool";
  label: string;
  detail?: string;
  phase?: "start" | "end" | "error";
  durationMs?: number;
  /** 只有 tool 通道有。`result` 是**预览**，不是完整返回值 */
  tool?: {
    args?: string;
    result?: string;
    resultOmitted?: number;
  };
}

export interface TaskStatus<TResult> {
  taskId: string;
  kind: TaskAccepted["kind"];
  status: "running" | "completed" | "failed" | "cancelled";
  /** 只在 cancelled 时有值：是用户停的还是超时 */
  cancelReason?: "user" | "timeout";
  currentStep: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /**
   * 结构化的失败信息。
   *
   * `retriable` 是这里唯一直接决定界面行为的字段：**为真才给重试入口**。
   * 给一个必然再次失败的操作配重试按钮，是把无能为力包装成了选择。
   */
  failure?: {
    code: "timeout" | "model" | "git" | "input" | "internal";
    message: string;
    retriable: boolean;
  };
  root: string;
  traceId: string;
  events: TaskEvent[];
  result?: TResult;
}

/**
 * 多久收不到任何字节就认为链路断了。
 *
 * 服务端每 15 秒发一次心跳，这里给三个周期的余量——**这个阈值是有依据的**
 * （心跳是定频的），而「多久没进度」那种阈值只能靠猜。
 *
 * 和 EventSource 版本的区别：那时候撞上这个阈值只能直接放弃，
 * 因为连接还「开着」、浏览器不认为需要重连。现在撞上就**主动断开重连**，
 * 而重连能靠 `Last-Event-ID` 无缝续上——**同一个阈值，从判死变成了自愈**。
 */
const HEARTBEAT_TIMEOUT_MS = 45_000;
/** 连续重连多少次仍然接不上就放弃 */
const MAX_RECONNECTS = 5;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 用户主动停止不是错误，UI 不该当故障提示 */
export class TaskCancelled extends Error {
  constructor() {
    super("已停止");
    this.name = "TaskCancelled";
  }
}

/**
 * 连接断了，但任务在服务端还活着。
 *
 * 和 `failed` 分开是因为**该给用户的选项不同**：任务真失败了该给「重试」，
 * 而这里再点一次重试只会起第二个任务，第一个还在后台跑。
 * 所以这种情况不提供重试入口，只如实说明任务仍在继续。
 */
export class TaskDisconnected extends Error {
  constructor(
    message: string,
    readonly traceId?: string,
  ) {
    super(traceId ? `${message}（编号 ${shortTrace(traceId)}）` : message);
    this.name = "TaskDisconnected";
  }
}

/**
 * 请求失败，且带着服务端给的真实原因。
 *
 * **这个类是换掉 EventSource 换来的东西。** 以前只有一个空的 error 事件，
 * 401 过期、500 崩了、CORS 配错、断网在前端长得一模一样；现在状态码、
 * 响应体、trace 编号都拿得到，错误才谈得上分类。
 */
export class TaskRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly traceId?: string,
    /** 重试有没有意义。4xx 基本无意义，5xx 和网络故障有 */
    readonly retriable = false,
  ) {
    super(traceId ? `${message}（编号 ${shortTrace(traceId)}）` : message);
    this.name = "TaskRequestError";
  }
}

export interface RunTaskOptions {
  url: string;
  body: unknown;
  onEvent: (event: TaskEvent) => void;
  /** 回答的增量文本；`replace` 表示这是重连时的一次性补齐 */
  onText?: (delta: string, replace: boolean) => void;
  /** 外部取消信号。abort 时会真的通知服务端停止，不只是不看了 */
  signal?: AbortSignal;
}

/**
 * 哪些失败重试才有意义。
 *
 * 分清楚这件事本身就是换传输层的目的之一：**EventSource 会对一个
 * 401 一遍遍重连到天荒地老**，因为它根本看不见状态码。
 */
function isRetriable(status: number): boolean {
  // 408 请求超时、429 被限流，这两个 4xx 是明确该重试的
  if (status === 408 || status === 429) return true;
  // 其余 4xx 是「请求本身有问题」，重试一万次也一样
  if (status >= 400 && status < 500) return false;
  return true;
}

/** 全抖动退避：不加抖动的话，服务端一恢复所有客户端会同时齐射 */
function backoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.random() * ceiling;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new TaskCancelled());
    }
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface FailureDetail {
  message: string;
  /** 服务端那边的编号。它和我们本地生成的可能不同——以服务端的为准 */
  traceId?: string;
}

async function readError(response: Response): Promise<FailureDetail> {
  // 服务端的错误体和 trace 编号，**这两样在 EventSource 上都拿不到**
  const detail = (await response.json().catch(() => ({}))) as { error?: string };
  return {
    message: detail.error ?? `请求失败 ${response.status}`,
    traceId: response.headers.get("X-Trace-Id") ?? undefined,
  };
}

function requestFailed(
  response: Response,
  detail: FailureDetail,
  fallback: string,
): TaskRequestError {
  return new TaskRequestError(
    detail.message,
    response.status,
    detail.traceId ?? fallback,
    isRetriable(response.status),
  );
}

async function submit(
  url: string,
  body: unknown,
  trace: TraceContext,
  signal?: AbortSignal,
): Promise<TaskAccepted> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", traceparent: trace.traceparent },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) throw requestFailed(response, await readError(response), trace.traceId);
  return (await response.json()) as TaskAccepted;
}

/**
 * 告诉服务端别跑了。
 *
 * 失败也不抛：用户已经点了停止，界面必须停下来。
 * 后端没收到这个请求最多是白烧一点 token，不该让 UI 卡在「停止中」。
 */
async function requestCancel(taskId: string, trace: TraceContext): Promise<void> {
  try {
    await fetch(`/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: { traceparent: trace.traceparent },
    });
  } catch {
    // 故意吞掉
  }
}

interface StreamHandlers {
  onEvent: RunTaskOptions["onEvent"];
  onText: RunTaskOptions["onText"];
}

/**
 * 连一次流，读到 `done` 为止。
 *
 * 返回 = 任务已终结（不论成败），抛出 = 这次连接没成功，由上层决定要不要重连。
 */
async function connectOnce(
  eventsUrl: string,
  lastEventId: string | undefined,
  trace: TraceContext,
  handlers: StreamHandlers,
  signal: AbortSignal | undefined,
  onEventId: (id: string) => void,
): Promise<void> {
  // 这个 controller 有两个触发源：外部取消、以及心跳超时。
  // 心跳超时**主动断开**是新增的能力——连接看着是开的、一个字节都不来，
  // 那种状态浏览器不会自己重连，只能我们动手
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const keepAlive = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(abort, HEARTBEAT_TIMEOUT_MS);
  };

  try {
    keepAlive();

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      traceparent: trace.traceparent,
    };
    // 断点续传：服务端只补发这条之后的。EventSource 是自动带的，
    // 现在得自己带——这也正是「能自己带头」换来的自由
    if (lastEventId !== undefined) headers["Last-Event-ID"] = lastEventId;

    const response = await fetch(eventsUrl, { headers, signal: controller.signal });

    if (!response.ok) throw requestFailed(response, await readError(response), trace.traceId);
    if (!response.body) throw new TaskRequestError("响应没有流式内容", 0, trace.traceId, true);

    for await (const frame of readSseFrames(response.body)) {
      keepAlive();
      if (frame.id !== undefined) onEventId(frame.id);

      // 心跳只做一件事：把「链路还通」的计时器推后（上面那行）。它不进时间线
      if (frame.event === "ping") continue;

      if (frame.event === "progress") {
        handlers.onEvent(JSON.parse(frame.data) as TaskEvent);
      } else if (frame.event === "delta") {
        const payload = JSON.parse(frame.data) as { delta: string; replace?: boolean };
        handlers.onText?.(payload.delta, payload.replace === true);
      } else if (frame.event === "done") {
        return;
      }
    }

    // 流自己结束了却没给 done：服务端进程没了，或者中间设备掐断。
    // 这不是终态，值得重连一次看看
    throw new TaskRequestError("连接意外结束", 0, trace.traceId, true);
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", abort);
  }
}

export async function runTask<TResult>(options: RunTaskOptions): Promise<TaskStatus<TResult>> {
  const { url, body, onEvent, onText, signal } = options;
  // **在请求发出之前**就把编号定下来：请求根本没到服务端的那类失败
  // （DNS、断网、代理拒绝）也才有编号可报，而那恰恰是最需要编号的一类
  const trace = newTrace();

  if (signal?.aborted) throw new TaskCancelled();

  const accepted = await submit(url, body, trace, signal);
  // 服务端可能沿用了我们的 trace-id，也可能因为解析不出而另生成一个，
  // 以它回的为准——排障时要对上的是**服务端日志里那个**
  const traceId = accepted.traceId || trace.traceId;

  let lastEventId: string | undefined;
  let attempt = 0;

  /** 用户点了停止：界面立刻停，取消请求在后台发，用户不该等一个网络往返 */
  const cancelled = (): TaskCancelled => {
    void requestCancel(accepted.taskId, trace);
    return new TaskCancelled();
  };

  for (;;) {
    // 这一轮有没有真的收到过东西。**只有连续失败才该放弃**——
    // 一个跑了十分钟、中间断过八次但每次都续上的任务是健康的
    let progressed = false;

    try {
      await connectOnce(
        accepted.eventsUrl,
        lastEventId,
        trace,
        { onEvent, onText },
        signal,
        (id) => {
          lastEventId = id;
          progressed = true;
        },
      );
      break;
    } catch (error) {
      if (signal?.aborted) throw cancelled();

      // 重试没有意义的失败（401、404、400…）立刻放手。
      // EventSource 时代做不到这件事，因为看不见状态码
      if (error instanceof TaskRequestError && !error.retriable) {
        throw new TaskDisconnected(`进度连接已断开：${error.message}`, traceId);
      }

      attempt = progressed ? 1 : attempt + 1;
      if (attempt > MAX_RECONNECTS) {
        throw new TaskDisconnected(
          `连接中断，重连 ${MAX_RECONNECTS} 次仍未恢复，任务仍在后台继续`,
          traceId,
        );
      }
    }

    try {
      await delay(backoffMs(attempt), signal);
    } catch {
      // delay 只会因为 abort 而失败
      throw cancelled();
    }
  }

  const response = await fetch(accepted.statusUrl, {
    headers: { traceparent: trace.traceparent },
    signal,
  });
  if (!response.ok) throw requestFailed(response, await readError(response), traceId);
  return (await response.json()) as TaskStatus<TResult>;
}
