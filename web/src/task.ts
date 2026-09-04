/**
 * 三种模式共用的任务客户端。
 *
 * 后端把 analyze / refactor / ask 统一成了「提交拿 taskId、进度走 SSE、
 * 结束拉状态」，前端就不该再为每种模式各写一份订阅逻辑——
 * 复制出来的第二份迟早会漏掉 `source.close()`，留下一条永远重连的连接。
 *
 * ## 三件容易只做一半的事
 *
 * **停止**：关掉 EventSource 只是「不看了」，后台该跑还跑、token 照烧。
 * 真的要停，得调服务端的 cancel 接口。
 *
 * **重连**：后端一直支持中途接入回放，但这里以前在 `onerror` 里直接
 * close + reject，那个能力等于白做。现在区分「浏览器正在自动重连」
 * 和「浏览器已经放弃」两种情况，前者等它，靠 `Last-Event-ID` 续传。
 *
 * **超时**：这里**不判断任务超时**。任务快慢只有服务端知道，它有自己的
 * 五分钟兜底；前端再设一道，就有了两套真相——而第一版正是这么错的：
 * 前端「九十秒没进度」就单方面宣布卡死，却没通知服务端，任务继续在后台
 * 烧 token，用户一点重试就变成两个任务并行。
 *
 * 前端只判断一件自己有资格判断的事：**这条链路还通不通**。依据是服务端
 * 的定频心跳，不是进度事件的间隔——后者取决于任务快慢，用它当指标必然
 * 误杀慢任务。
 */

export interface TaskAccepted {
  taskId: string;
  kind: "analyze" | "refactor" | "ask";
  status: string;
  statusUrl: string;
  eventsUrl: string;
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
  root: string;
  events: TaskEvent[];
  result?: TResult;
}

/**
 * 多久收不到心跳就认为链路断了。
 *
 * 服务端每 15 秒发一次，这里给三个周期的余量——**这个阈值是有依据的**
 * （心跳是定频的），而「多久没进度」那种阈值只能靠猜。
 */
const HEARTBEAT_TIMEOUT_MS = 45_000;
/** 连续重连多少次仍然接不上就放弃 */
const MAX_RECONNECTS = 5;

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
  constructor(message: string) {
    super(message);
    this.name = "TaskDisconnected";
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

async function submit(url: string, body: unknown, signal?: AbortSignal): Promise<TaskAccepted> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `API ${response.status}`);
  }
  return (await response.json()) as TaskAccepted;
}

/**
 * 告诉服务端别跑了。
 *
 * 失败也不抛：用户已经点了停止，界面必须停下来。
 * 后端没收到这个请求最多是白烧一点 token，不该让 UI 卡在「停止中」。
 */
async function requestCancel(taskId: string): Promise<void> {
  try {
    await fetch(`/tasks/${taskId}/cancel`, { method: "POST" });
  } catch {
    // 故意吞掉
  }
}

export async function runTask<TResult>(options: RunTaskOptions): Promise<TaskStatus<TResult>> {
  const { url, body, onEvent, onText, signal } = options;

  if (signal?.aborted) throw new TaskCancelled();

  const accepted = await submit(url, body, signal);

  await new Promise<void>((resolve, reject) => {
    const source = new EventSource(accepted.eventsUrl);
    let settled = false;
    let reconnects = 0;
    let idle: ReturnType<typeof setTimeout>;

    const stop = (): void => {
      settled = true;
      clearTimeout(idle);
      signal?.removeEventListener("abort", onAbort);
      source.close();
    };

    const succeed = (): void => {
      stop();
      resolve();
    };

    const fail = (error: Error): void => {
      stop();
      reject(error);
    };

    // 收到任何字节都算链路还通——心跳、进度、文本增量都行
    const keepAlive = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        // 注意这里**不调 cancel**：用户没有表达任何停止的意图，
        // 只是我们看不见了。任务该继续跑，由服务端的超时兜底
        fail(new TaskDisconnected("连接已中断，任务仍在后台继续"));
      }, HEARTBEAT_TIMEOUT_MS);
    };

    function onAbort(): void {
      if (settled) return;
      // 先让界面停下来，取消请求在后台发——用户不该等一个网络往返
      void requestCancel(accepted.taskId);
      fail(new TaskCancelled());
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    source.addEventListener("progress", (message) => {
      keepAlive();
      onEvent(JSON.parse((message as MessageEvent).data) as TaskEvent);
    });

    source.addEventListener("delta", (message) => {
      keepAlive();
      const payload = JSON.parse((message as MessageEvent).data) as {
        delta: string;
        replace?: boolean;
      };
      onText?.(payload.delta, payload.replace === true);
    });

    // 心跳只做一件事：把「链路还通」的计时器推后。它不进时间线
    source.addEventListener("ping", keepAlive);

    source.addEventListener("done", succeed);

    // 重连成功，把计数清零：只有**连续**失败才该放弃
    source.onopen = () => {
      reconnects = 0;
      keepAlive();
    };

    source.onerror = () => {
      if (settled) return;

      // CLOSED 表示浏览器不会再自动重连了（4xx、CORS 之类），等下去没意义
      if (source.readyState === EventSource.CLOSED) {
        fail(new TaskDisconnected("进度连接已断开，任务仍在后台继续"));
        return;
      }

      // CONNECTING：浏览器正在自动重连。重连后服务端会带着 Last-Event-ID
      // 从断点续发，所以这里只需要等，不需要自己补数据
      reconnects += 1;
      if (reconnects > MAX_RECONNECTS) {
        fail(new TaskDisconnected(`连接中断，重连 ${MAX_RECONNECTS} 次仍未恢复`));
      }
    };

    keepAlive();
  });

  const response = await fetch(accepted.statusUrl, { signal });
  if (!response.ok) throw new Error(`状态查询失败 ${response.status}`);
  return (await response.json()) as TaskStatus<TResult>;
}
