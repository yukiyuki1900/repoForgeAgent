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

import { forget, remember } from "./session.js";
import { readSseFrames } from "./sse.js";
import { newTrace, shortTrace, type TraceContext } from "./trace.js";

export interface TaskAccepted {
  taskId: string;
  kind: "analyze" | "refactor" | "ask";
  status: string;
  statusUrl: string;
  eventsUrl: string;
  /**
   * 探针地址。**和 `statusUrl` 分开是有原因的**：那个返回全量事件与结果，
   * 成本随任务大小增长，当探针用会越探越贵。
   */
  probeUrl: string;
  /**
   * 服务端复用了一个正在跑的同源任务，不是新建的。
   *
   * 显示上不需要区分——复用之后走的路径完全一样（接上那条流、回放已发生的
   * 进度），界面自然就显示成「已经在跑了」。**但它决定了一件事：谁有权停。**
   *
   * 复用是**系统替用户做的决定**，用户并不知道自己被并到了别人的任务上。
   * 这时候把「停止」摆在他面前，点下去会掐掉另一个页面正在看的回答——
   * **你没发起的任务，你没有权力替别人终止。** 所以这种情况下按钮变成
   * 「离开」：只断自己这条订阅，不发 cancel。
   *
   * 反过来，带着 taskId 主动接回来的（刷新恢复、地址栏、历史列表）
   * **保留取消权**：用户拿着编号来，说明他认这个任务是他的。
   */
  reused?: boolean;
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

/**
 * 探针超时。
 *
 * 探针接口是「查一次 Map 加序列化十来个字段」，微秒级。
 * 5 秒答不上来只可能是服务端的事件循环被钉死了——**这个超时不是故障，
 * 它就是我们要的那个答案**。
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * 探针判定「服务端在忙」之后的退避下限。
 *
 * 比普通重连退避（500ms 起步）狠得多，因为**这两种失败要的是相反的处理**：
 * 链路假死要尽快重连，服务端过载要离它远点——回去得越快，压得越狠。
 */
const BUSY_BACKOFF_MS = 8_000;

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

/**
 * 心跳超时：45 秒一帧都没收到。
 *
 * 单独一个类型，是因为它**不能和普通的连接失败同等对待**。
 * 「收不到心跳」是一个症状、两个病因：
 *
 * ```
 * 链路假死（TCP 半开、代理丢包）  →  该重连，那是唯一的自愈手段
 * 服务端事件循环被同步 CPU 钉死    →  绝不能重连，重连会触发全量回放，火上浇油
 * ```
 *
 * 这两种在客户端看来一模一样，所以拿到它之后要先探一下再决定。
 */
class HeartbeatTimeout extends Error {
  constructor() {
    super("超过 45 秒没有收到任何数据");
    this.name = "HeartbeatTimeout";
  }
}

/** 探针的三种结论，各自对应一种完全不同的下一步 */
type ProbeResult =
  /** 服务端有反应，任务还在跑 → 那就是这条链路的问题，重连 */
  | { verdict: "alive" }
  /** 服务端有反应，任务已经结束了 → `done` 帧丢了，别重连，直接收尾 */
  | { verdict: "settled" }
  /** 服务端答不上来 → 它在忙，离它远点 */
  | { verdict: "busy" };

/**
 * 问服务端一句「你还转得动吗」。
 *
 * **它的价值主要不在返回值，而在答不答得上来。** 事件循环被钉死时
 * 这个请求也一样排不上队，那个超时本身就是答案。
 *
 * 反过来说，这件事只能由客户端主动探，不能指望服务端过载时主动上报——
 * **能上报的前提是还没坏透**，而那正是出问题时最先失去的能力。
 */
async function probe(probeUrl: string, trace: TraceContext): Promise<ProbeResult> {
  try {
    const response = await fetch(probeUrl, {
      headers: { traceparent: trace.traceparent },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // 404 说明任务已经被淘汰了（或者服务端重启过）。这时候重连也只会拿到 404，
    // 当成「已终结」收尾，让后面那次拉状态去给出真正的结论
    if (response.status === 404) return { verdict: "settled" };
    if (!response.ok) return { verdict: "busy" };

    const summary = (await response.json()) as { status?: string };
    return summary.status === "running" ? { verdict: "alive" } : { verdict: "settled" };
  } catch {
    // 超时、断网、CORS——都归到「指望不上它」。**这里刻意不细分**：
    // 客户端此刻能做的决定只有一个（要不要马上重连），细分不会改变它
    return { verdict: "busy" };
  }
}

/**
 * 链路状态。
 *
 * **加它是因为算了一笔账**：服务端卡住时，一轮是「45 秒等心跳 + 5 秒探针
 * + 8 秒退避」≈ 58 秒，五轮下来将近五分钟——而这五分钟里界面上
 * **什么都不会变**，进度条停在原地，用户既不知道在重连，也不知道要等多久。
 *
 * 那正好违反了这个项目自己的一条原则：**等待也要有反馈**。
 * 重连本来就是在替用户扛事，扛得无声无息就成了假死。
 */
export type ConnectionState =
  | {
      status: "reconnecting";
      /** 第几次，从 1 开始 */
      attempt: number;
      max: number;
      /** 探针判定服务端在忙——这时候等得更久是**故意的**，不是卡了 */
      serverBusy: boolean;
    }
  | { status: "connected" };

/**
 * 链路状态的文案，三个面板共用一份。
 *
 * 各写各的话，同一件事会在三个地方长出三种说法，改口径要改三处。
 *
 * 每一条都带上「任务仍在后台继续」——**这正是用户在这一刻最需要知道的**：
 * 他看到的是界面卡住了，而事实是活还在干。少了这句，重连提示只会让人
 * 更慌，甚至去点第二次。
 */
export function describeConnection(state: ConnectionState): string {
  if (state.status === "connected") return "连接已恢复，继续接收进度";
  return state.serverBusy
    ? `服务端繁忙，正在等待后重试（${state.attempt}/${state.max}）·任务仍在后台继续`
    : `连接中断，正在重连（${state.attempt}/${state.max}）·任务仍在后台继续`;
}

export interface RunTaskOptions {
  url: string;
  body: unknown;
  onEvent: (event: TaskEvent) => void;
  /**
   * 链路状态变化。
   *
   * 只在**真的发生了重连**时才通知：连上就一直安静，
   * 否则界面会为一次正常的连接闪一下「已连接」。
   */
  onConnectionChange?: (state: ConnectionState) => void;
  /** 回答的增量文本；`replace` 表示这是重连时的一次性补齐 */
  onText?: (delta: string, replace: boolean) => void;
  /** 外部取消信号。abort 时会真的通知服务端停止，不只是不看了 */
  signal?: AbortSignal;
  /**
   * 心跳超时阈值，**仅供测试注入**——真等 45 秒的用例没人会跑。
   *
   * 服务端 `attachStream` 的心跳间隔也是这么处理的，两边保持一致。
   */
  heartbeatTimeoutMs?: number;
  /**
   * 提供了就把 `taskId` 记下来，刷新之后可以接回去。
   *
   * `root` 一起存，是因为**换了仓库就不该再接回上一个仓库的任务**——
   * 那会让界面显示成「正在分析当前仓库」，而实际跑的是另一个。
   */
  resume?: { kind: TaskAccepted["kind"]; root: string };
  /**
   * 服务端受理之后立刻回调，早于任何进度事件。
   *
   * 存在的理由只有一个：**taskId 要能进 URL**。`runTask` 要等任务跑完
   * 才返回，而地址栏必须在任务**开始时**就带上编号——否则用户在任务
   * 跑到一半时复制走的链接是没有编号的，那正是最想分享出去的时刻。
   */
  onAccepted?: (accepted: TaskAccepted) => void;
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
  heartbeatTimeoutMs: number,
): Promise<void> {
  // 这个 controller 有两个触发源：外部取消、以及心跳超时。
  // 心跳超时**主动断开**是新增的能力——连接看着是开的、一个字节都不来，
  // 那种状态浏览器不会自己重连，只能我们动手
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  // 是不是**我们自己**因为心跳超时掐断的。
  //
  // 没有这个标记的话，心跳超时和外部取消、网络出错在 catch 里长得一样——
  // 而它们要的处理完全不同。**这是「先探再决定」能成立的前提**
  let starved = false;

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const keepAlive = (): void => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      starved = true;
      abort();
    }, heartbeatTimeoutMs);
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
  } catch (error) {
    // 这里**不判断外部取消**。我一开始写的是 `starved && !signal?.aborted`，
    // 变异测试证明那半边是死的：去掉它 16/16 全绿。
    //
    // 原因是调用方 `runTask` 的 catch **第一件事就是判 `signal?.aborted`**，
    // 轮不到看错误类型。留着只会让人以为这里也在管取消——
    // **两处判同一件事，读的人得先确认它们没矛盾。**
    if (starved) throw new HeartbeatTimeout();
    throw error;
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * 提交一个任务，然后一路跟到它结束。
 *
 * 拿到 `taskId` 之后会**记住它**，好让刷新页面能接回来——服务端一直
 * 记得那个任务，此前只有前端会忘。终结时清掉，但**断开时刻意保留**：
 * 那正是最需要能接回去的时候。
 */
export async function runTask<TResult>(options: RunTaskOptions): Promise<TaskStatus<TResult>> {
  const { url, body, signal } = options;
  // **在请求发出之前**就把编号定下来：请求根本没到服务端的那类失败
  // （DNS、断网、代理拒绝）也才有编号可报，而那恰恰是最需要编号的一类
  const trace = newTrace();

  if (signal?.aborted) throw new TaskCancelled();

  const accepted = await submit(url, body, trace, signal);

  if (options.resume) {
    remember(options.resume.kind, {
      taskId: accepted.taskId,
      root: options.resume.root,
      startedAt: Date.now(),
    });
  }

  options.onAccepted?.(accepted);

  return follow(accepted, trace, options);
}

/**
 * 接回一个已经在跑的任务，不再提交。
 *
 * 和 `runTask` 共用后半段——**这不是为了少写几行，是为了不出现两套语义**：
 * 重连退避、心跳探针、断线提示如果各写一份，两条路迟早会在某个分支上
 * 给出不一样的行为，而那种差异只会在出问题时才被发现。
 */
/**
 * 看一眼这个任务还在不在，不订阅、不重连。
 *
 * 恢复之前必须先问这一句：服务端只保留最近 20 条已完成的任务，进程重启
 * 更是全清。直接去接一个早就不存在的任务，用户会先看到「正在重连
 * （1/5）」再看到「连接中断」——**为一个根本不存在的东西表演一遍重连**。
 *
 * 复用的是心跳探针那条轻量路由，理由一样：它的成本不随任务大小增长。
 */
export async function peekTask(
  taskId: string,
  /**
   * 带上仓库路径，服务端在内存里找不到时才能去归档里找。
   *
   * 不带也能用——那就退回原来的语义：**只问内存**。
   */
  root?: string,
): Promise<{ status: string } | undefined> {
  const trace = newTrace();
  try {
    const response = await fetch(`/tasks/${taskId}/summary${rootQuery(root)}`, {
      headers: { traceparent: trace.traceparent },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as { status: string };
  } catch {
    // 探不到就当它不在。**恢复是锦上添花**，为它多等、多试都不值得
    return undefined;
  }
}

/**
 * 直接把一个**已经结束**的任务读回来，不订阅、不重连。
 *
 * 从历史列表点进一条跑完的任务时走这条路，而不是 `resumeTask`：
 * 订阅一条已结束任务的 SSE，服务端会把整条时间线重推一遍才发 `done`，
 * 大任务上纯属白烧——**而且内存里已经淘汰掉的任务根本没有流可接**，
 * 那条 events 路由会 404。
 */
export async function loadTask<TResult>(
  taskId: string,
  root: string,
): Promise<TaskStatus<TResult>> {
  const trace = newTrace();
  const response = await fetch(`/tasks/${taskId}${rootQuery(root)}`, {
    headers: { traceparent: trace.traceparent },
  });
  if (!response.ok) throw requestFailed(response, await readError(response), trace.traceId);
  return (await response.json()) as TaskStatus<TResult>;
}

function rootQuery(root?: string): string {
  return root ? `?root=${encodeURIComponent(root)}` : "";
}

export async function resumeTask<TResult>(
  taskId: string,
  options: Omit<RunTaskOptions, "url" | "body">,
): Promise<TaskStatus<TResult>> {
  const trace = newTrace();
  if (options.signal?.aborted) throw new TaskCancelled();

  // 结果接口带上 root：任务跑完时可能已经被挤出内存了（服务端只留 20 条），
  // 带着它服务端才能回落到归档，否则**眼看着跑完了，最后一步拿 404**
  const query = rootQuery(options.resume?.root);

  return follow(
    {
      taskId,
      // 从调用方拿，别写死。这个字段目前没人读，但写死一个 "ask" 是在
      // 埋雷：哪天有人按 kind 分支，analyze / refactor 的恢复会**静默走错**
      kind: options.resume?.kind ?? "ask",
      status: "running",
      statusUrl: `/tasks/${taskId}${query}`,
      eventsUrl: `/tasks/${taskId}/events`,
      probeUrl: `/tasks/${taskId}/summary${query}`,
      traceId: trace.traceId,
    },
    trace,
    options,
  );
}

async function follow<TResult>(
  accepted: TaskAccepted,
  trace: TraceContext,
  options: Omit<RunTaskOptions, "url" | "body">,
): Promise<TaskStatus<TResult>> {
  const { onEvent, onText, signal } = options;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  // 服务端可能沿用了我们的 trace-id，也可能因为解析不出而另生成一个，
  // 以它回的为准——排障时要对上的是**服务端日志里那个**
  const traceId = accepted.traceId || trace.traceId;
  // 任务终结了就把恢复钥匙扔掉；**断线时不扔**，那正是要用它的时候
  const done = (): void => {
    if (options.resume) forget(options.resume.kind);
  };

  let lastEventId: string | undefined;
  let attempt = 0;
  // 是否已经告诉过界面「正在重连」。用它来决定恢复时要不要报一声——
  // 没断过就不该冒出一句「已恢复」
  let announced = false;

  /**
   * 用户点了停止：界面立刻停，取消请求在后台发，用户不该等一个网络往返。
   *
   * **搭车的那一路不发 cancel。** 服务端复用了别人正在跑的任务时，
   * 这个页面只是个观察者——断开自己这条订阅就够了，掐掉任务会让
   * 另一个页面上正在生成的回答半句话断掉，而那边的用户什么都没做。
   */
  const cancelled = (): TaskCancelled => {
    if (!accepted.reused) void requestCancel(accepted.taskId, trace);
    done();
    return new TaskCancelled();
  };

  for (;;) {
    // 这一轮有没有真的收到过东西。**只有连续失败才该放弃**——
    // 一个跑了十分钟、中间断过八次但每次都续上的任务是健康的
    let progressed = false;
    // 探针说服务端在忙。它只影响「等多久」，不影响「还要不要等」
    let serverBusy = false;

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
          if (announced) {
            announced = false;
            options.onConnectionChange?.({ status: "connected" });
          }
        },
        heartbeatTimeoutMs,
      );
      break;
    } catch (error) {
      if (signal?.aborted) throw cancelled();

      // 重试没有意义的失败（401、404、400…）立刻放手。
      // EventSource 时代做不到这件事，因为看不见状态码
      if (error instanceof TaskRequestError && !error.retriable) {
        throw new TaskDisconnected(`进度连接已断开：${error.message}`, traceId);
      }

      // 心跳超时不能直接重连——**同一个症状有两个病因，处理相反**。
      // 花一个极轻的请求把它们分开，比猜一个退避曲线可靠
      if (error instanceof HeartbeatTimeout) {
        const result = await probe(accepted.probeUrl, trace);

        // 任务其实已经结束了，只是 done 帧没送到。
        // **这一分支是白捡的**：不探的话要白白重连一次才发现
        if (result.verdict === "settled") break;

        serverBusy = result.verdict === "busy";
      }

      attempt = progressed ? 1 : attempt + 1;
      if (attempt > MAX_RECONNECTS) {
        // **这里不调 done()**：钥匙留着，用户刷新一下就能接着看。
        // 提示语说的是「任务仍在后台继续」，扔掉钥匙就等于自己打自己的脸
        throw new TaskDisconnected(
          `连接中断，重连 ${MAX_RECONNECTS} 次仍未恢复，任务仍在后台继续`,
          traceId,
        );
      }
    }

    // 在开始等之前就报出去。**报晚了等于没报**——用户要的正是
    // 「这段安静是有人在处理」，而不是等完之后才被告知刚才发生过什么
    announced = true;
    options.onConnectionChange?.({
      status: "reconnecting",
      attempt,
      max: MAX_RECONNECTS,
      serverBusy,
    });

    try {
      // 服务端在忙的时候拉长退避。注意是**取较大值**而不是直接替换：
      // 连着失败多次之后，正常退避本来就可能超过这个下限
      const wait = serverBusy ? Math.max(backoffMs(attempt), BUSY_BACKOFF_MS) : backoffMs(attempt);
      await delay(wait, signal);
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

  // 走到这里任务一定是终态了（`done` 帧或探针确认），钥匙可以扔了
  done();
  return (await response.json()) as TaskStatus<TResult>;
}
