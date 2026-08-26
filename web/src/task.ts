/**
 * 三种模式共用的任务客户端。
 *
 * 后端把 analyze / refactor / ask 统一成了「提交拿 taskId、进度走 SSE、
 * 结束拉状态」，前端就不该再为每种模式各写一份订阅逻辑——
 * 复制出来的第二份迟早会漏掉 `source.close()`，留下一条永远重连的连接。
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
}

export interface TaskStatus<TResult> {
  taskId: string;
  kind: TaskAccepted["kind"];
  status: "running" | "completed" | "failed";
  currentStep: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  root: string;
  events: TaskEvent[];
  result?: TResult;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function submit(url: string, body: unknown): Promise<TaskAccepted> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `API ${response.status}`);
  }
  return (await response.json()) as TaskAccepted;
}

/**
 * 提交并跟到结束。
 *
 * SSE 断线时不丢弃已经收到的进度：后端支持重放，且任务仍在后台跑，
 * 这里只把失败原因交给调用方，由它决定是提示还是重试。
 */
export async function runTask<TResult>(
  url: string,
  body: unknown,
  onEvent: (event: TaskEvent) => void,
  /** 回答的增量文本；`replace` 表示这是重连时的一次性补齐 */
  onText?: (delta: string, replace: boolean) => void,
): Promise<TaskStatus<TResult>> {
  const accepted = await submit(url, body);

  await new Promise<void>((resolve, reject) => {
    const source = new EventSource(accepted.eventsUrl);

    source.addEventListener("progress", (message) => {
      onEvent(JSON.parse((message as MessageEvent).data) as TaskEvent);
    });

    source.addEventListener("delta", (message) => {
      const payload = JSON.parse((message as MessageEvent).data) as {
        delta: string;
        replace?: boolean;
      };
      onText?.(payload.delta, payload.replace === true);
    });

    source.addEventListener("done", () => {
      source.close();
      resolve();
    });

    source.onerror = () => {
      source.close();
      reject(new Error("进度连接中断，任务可能仍在后台运行"));
    };
  });

  const response = await fetch(accepted.statusUrl);
  if (!response.ok) throw new Error(`状态查询失败 ${response.status}`);
  return (await response.json()) as TaskStatus<TResult>;
}
