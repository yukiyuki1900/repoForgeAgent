import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

/**
 * 三种模式共用的任务机制。
 *
 * analyze / refactor / ask 的差别只在「干什么」和「产出什么」，
 * 而「提交后立刻返回、进度用 SSE 推、结束发 done 并关流」这套骨架是一样的。
 * 此前这套逻辑写死在 analysis 路由里，加一种模式就要复制一遍——
 * 复制出来的第二份迟早会在某个分支上忘记 `stream.end()`，让客户端一直挂着。
 *
 * 事件也统一成一种形状。三种模式的进度语义不同：
 * 工作流节点有耗时、改造步骤是纯文本、工具调用有名字和结果摘要。
 * 但对前端来说都是「一条带标签的时间线」，统一之后一个组件就能渲染三种。
 */

export type TaskKind = "analyze" | "refactor" | "ask";
export type TaskStatus = "running" | "completed" | "failed";

export interface TaskEvent {
  at: string;
  /** node = 工作流节点 · step = 改造步骤 · tool = 工具调用 */
  channel: "node" | "step" | "tool";
  label: string;
  detail?: string;
  /** 只有 node 事件区分开始与结束，另两种都是瞬时的 */
  phase?: "start" | "end" | "error";
  durationMs?: number;
}

export interface TaskRecord<TResult = unknown> {
  taskId: string;
  kind: TaskKind;
  root: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  /** 当前进行到哪一步，供列表与状态接口直接展示 */
  currentStep: string;
  /** 已发生的事件，供后接入的订阅者回放，避免错过前面的进度 */
  events: TaskEvent[];
  /**
   * 流式回答的累积文本。
   *
   * 文本增量**不进 events**：一段回答几千个 token，逐条塞进事件数组
   * 会让内存与回放体积都失控，而它们的信息量完全等价于拼接后的结果。
   * 这里只留最新的完整文本，重连时一次补齐。
   */
  text?: string;
  subscribers: Set<PassThrough>;
  result?: TResult;
  error?: string;
}

/** 已完成的任务保留上限，超出后按开始时间淘汰最旧的 */
const MAX_RETAINED = 20;

const tasks = new Map<string, TaskRecord>();

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export interface StartTaskInput<TResult> {
  kind: TaskKind;
  root: string;
  /** 附加在任务上的描述信息，例如 ask 的问题、refactor 是否写入 */
  meta?: Record<string, unknown>;
  run: (context: {
    emit: (event: Omit<TaskEvent, "at">) => void;
    /** 推送回答的增量文本 */
    emitText: (delta: string) => void;
  }) => Promise<TResult>;
}

/**
 * 提交任务：立刻返回记录，实际执行在后台进行。
 *
 * 不 await run()——稍大的仓库同步执行必然请求超时，
 * 早期版本就是这么挂的。
 */
export function startTask<TResult>(input: StartTaskInput<TResult>): TaskRecord<TResult> {
  const record: TaskRecord<TResult> = {
    taskId: randomUUID(),
    kind: input.kind,
    root: input.root,
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: "start",
    events: [],
    subscribers: new Set(),
    ...input.meta,
  };

  tasks.set(record.taskId, record as TaskRecord);
  evictOld();

  const emit = (event: Omit<TaskEvent, "at">): void => {
    publish(record as TaskRecord, { ...event, at: new Date().toISOString() });
  };

  const emitText = (delta: string): void => {
    record.text = (record.text ?? "") + delta;
    const payload = formatEvent("delta", { delta });
    for (const stream of record.subscribers) stream.write(payload);
  };

  void (async () => {
    try {
      record.result = await input.run({ emit, emitText });
      record.status = "completed";
    } catch (error) {
      record.status = "failed";
      record.error = error instanceof Error ? error.message : String(error);
      emit({ channel: "step", label: "失败", detail: record.error, phase: "error" });
    } finally {
      record.finishedAt = new Date().toISOString();
      finish(record as TaskRecord);
    }
  })();

  return record;
}

function publish(record: TaskRecord, event: TaskEvent): void {
  record.events.push(event);
  // node 事件用 start 标记当前步骤；另两种是瞬时的，直接以自己为准
  if (event.phase !== "end") record.currentStep = event.label;

  const payload = formatEvent("progress", event);
  for (const stream of record.subscribers) stream.write(payload);
}

/** 终态统一走 done 事件并关闭流，否则标准 SSE 客户端会一直挂着 */
function finish(record: TaskRecord): void {
  const payload = formatEvent("done", summaryOf(record));
  for (const stream of record.subscribers) {
    stream.write(payload);
    stream.end();
  }
  record.subscribers.clear();
}

/**
 * 接一条 SSE 流。
 *
 * 先回放已发生的事件再订阅后续；任务如果已经结束，同样以 done 收尾并关流。
 * 两条路径的协议完全一致，客户端不需要区分「接得早」还是「接得晚」。
 */
export function attachStream(record: TaskRecord): PassThrough {
  const stream = new PassThrough();

  for (const event of record.events) {
    stream.write(formatEvent("progress", event));
  }

  // 中途接入时把已经生成的回答一次补齐，之后再接增量
  if (record.text) stream.write(formatEvent("delta", { delta: record.text, replace: true }));

  if (record.status !== "running") {
    stream.write(formatEvent("done", summaryOf(record)));
    stream.end();
    return stream;
  }

  record.subscribers.add(stream);
  stream.on("close", () => record.subscribers.delete(stream));
  return stream;
}

/** done 事件只带轻量摘要，完整结果由客户端按需拉状态接口 */
export function summaryOf(record: TaskRecord) {
  return {
    taskId: record.taskId,
    kind: record.kind,
    status: record.status,
    currentStep: record.currentStep,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
  };
}

export function toResponse(record: TaskRecord) {
  return { ...summaryOf(record), root: record.root, events: record.events, result: record.result };
}

export function formatEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function evictOld(): void {
  const finished = [...tasks.values()]
    .filter((record) => record.status !== "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  for (const record of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED))) {
    tasks.delete(record.taskId);
  }
}
