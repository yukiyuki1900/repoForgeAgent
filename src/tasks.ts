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

/**
 * 四个终态里 `cancelled` 是后加的。
 *
 * 起初想把「用户点了停止」也算作 `failed`，但那会让前端没法区分
 * 「出错了，该提示重试」和「你自己停的，什么都不用说」——
 * **同一个状态承担两种产品语义，UI 只能猜。**
 *
 * 而超时**不单独设状态**：它和用户取消在机制上是同一件事（abort 掉），
 * 差别只在「谁触发的」，那是 `cancelReason` 一个字段的事。
 * 状态机每多一个状态，所有分支判断都要多一次，能用字段表达的就不占状态位。
 */
export type TaskStatus = "running" | "completed" | "failed" | "cancelled";

export type CancelReason = "user" | "timeout";

export interface TaskEvent {
  at: string;
  /** node = 工作流节点 · step = 改造步骤 · tool = 工具调用 */
  channel: "node" | "step" | "tool";
  label: string;
  detail?: string;
  /** 只有 node 事件区分开始与结束，另两种都是瞬时的 */
  phase?: "start" | "end" | "error";
  durationMs?: number;
  /**
   * 只有 `tool` 通道有的结构化明细。
   *
   * 事件本来是三种模式的**最小公约数**——`{channel, label, detail}` 之外
   * 一律不加。代价是工具这个信息最丰富的通道被压到了最低标准：
   * 界面上只看得到「调用了 readSource」，看不到读的哪个文件、读到了什么。
   *
   * 还这笔债的办法**不是**把 JSON 塞进 `detail` 变成一坨文本，
   * 而是给这一种通道开一个可选字段。归并的价值在于「都是一条带标签的
   * 时间线」这个共性成立，不在于所有通道必须一模一样。
   */
  tool?: ToolEventDetail;
}

export interface ToolEventDetail {
  args?: string;
  /** 返回值的预览，不是返回值本身。截断量见 `resultOmitted` */
  result?: string;
  resultOmitted?: number;
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
  /** 谁把它停掉的。只在 status 为 cancelled 时有值 */
  cancelReason?: CancelReason;
  /**
   * 取消这个任务的把手。
   *
   * **前端关掉 EventSource 不等于任务停了** ——那只是「不看了」，
   * 后台该跑还跑，该烧的 token 一个不少。要真的停下来，
   * signal 必须一路传到 `streamText`。
   */
  controller: AbortController;
}

/** 已完成的任务保留上限，超出后按开始时间淘汰最旧的 */
const MAX_RETAINED = 20;

/**
 * 任务整体超时。
 *
 * 放在任务层而不是 LLM 调用层：一次 ask 里除了模型调用还有建索引、
 * 工具执行，卡在任何一段都该被兜住。**在最外层设一道，比在每个可能
 * 卡住的地方各设一道更可靠**——后者总会漏掉刚加的那个。
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const tasks = new Map<string, TaskRecord>();

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export interface StartTaskInput<TResult> {
  kind: TaskKind;
  root: string;
  /** 附加在任务上的描述信息，例如 ask 的问题、refactor 是否写入 */
  meta?: Record<string, unknown>;
  /** 覆盖默认的整体超时 */
  timeoutMs?: number;
  run: (context: {
    emit: (event: Omit<TaskEvent, "at">) => void;
    /** 推送回答的增量文本 */
    emitText: (delta: string) => void;
    /** 传给下游的取消信号。不接它的任务只是「停止上报」，不是真的停了 */
    signal: AbortSignal;
  }) => Promise<TResult>;
}

/**
 * 提交任务：立刻返回记录，实际执行在后台进行。
 *
 * 不 await run()——稍大的仓库同步执行必然请求超时，
 * 早期版本就是这么挂的。
 */
export function startTask<TResult>(input: StartTaskInput<TResult>): TaskRecord<TResult> {
  const controller = new AbortController();
  const record: TaskRecord<TResult> = {
    taskId: randomUUID(),
    kind: input.kind,
    root: input.root,
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: "start",
    events: [],
    subscribers: new Set(),
    controller,
    ...input.meta,
  };

  tasks.set(record.taskId, record as TaskRecord);
  evictOld();

  const timer = setTimeout(() => {
    // 超时和用户取消走同一条路：都是 abort。
    // 区别只记在 cancelReason 上，不占一个状态位
    if (record.status === "running") cancel(record as TaskRecord, "timeout");
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // 别让一个等待中的定时器把进程钉住
  timer.unref?.();

  const emit = (event: Omit<TaskEvent, "at">): void => {
    publish(record as TaskRecord, { ...event, at: new Date().toISOString() });
  };

  const emitText = (delta: string): void => {
    record.text = (record.text ?? "") + delta;
    // 文本增量不进 events，所以也没有 id——重连时靠 replace 全量补齐
    const payload = formatEvent("delta", { delta });
    for (const stream of record.subscribers) stream.write(payload);
  };

  void (async () => {
    try {
      record.result = await input.run({ emit, emitText, signal: controller.signal });
      // 任务体可能吞掉 abort 正常返回，以信号为准而不是以它返回没返回为准
      record.status = controller.signal.aborted ? "cancelled" : "completed";
    } catch (error) {
      if (controller.signal.aborted) {
        // 被取消时下游抛出的 AbortError 是预期内的，不是故障
        record.status = "cancelled";
        record.error = undefined;
      } else {
        record.status = "failed";
        record.error = error instanceof Error ? error.message : String(error);
        emit({ channel: "step", label: "失败", detail: record.error, phase: "error" });
      }
    } finally {
      // 这行**不影响状态正确性**——即便定时器漏了没清，触发时 `cancel()`
      // 里的 `status === "running"` 守卫也会把它挡回去。
      // 它防的是资源：不清的话这个定时器会攥着 record 直到超时时刻，
      // 一个五分钟前就跑完的任务凭空多活五分钟。
      //
      // 变异测试里删掉它是 0/14，那是**真实的**结果而不是断言漏了：
      // 守卫已经兜住了后果，剩下的只有 GC 时机，测不出来也不该假装测得出。
      clearTimeout(timer);
      record.finishedAt = new Date().toISOString();
      finish(record as TaskRecord);
    }
  })();

  return record;
}

/**
 * 取消一个任务。
 *
 * 立刻把终态写好并关流，不等任务体自己反应过来——下游未必及时响应
 * signal（有些库压根不接），而用户点了停止之后界面不该继续转圈。
 * 任务体后续真正退出时会看到 `status !== "running"`，不再覆盖终态。
 */
export function cancelTask(taskId: string, reason: CancelReason = "user"): TaskRecord | undefined {
  const record = tasks.get(taskId);
  if (!record || record.status !== "running") return record;
  cancel(record, reason);
  return record;
}

function cancel(record: TaskRecord, reason: CancelReason): void {
  record.status = "cancelled";
  record.cancelReason = reason;
  record.finishedAt = new Date().toISOString();

  publish(record, {
    at: new Date().toISOString(),
    channel: "step",
    label: reason === "timeout" ? "已超时中止" : "已取消",
    phase: "error",
  });

  record.controller.abort(new Error(reason === "timeout" ? "task timed out" : "cancelled by user"));
  finish(record);
}

function publish(record: TaskRecord, event: TaskEvent): void {
  // 事件在数组里的下标就是它的 SSE id，不用再维护一个自增计数器
  const id = record.events.length;
  record.events.push(event);
  // node 事件用 start 标记当前步骤；另两种是瞬时的，直接以自己为准
  if (event.phase !== "end") record.currentStep = event.label;

  const payload = formatEvent("progress", event, id);
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
export function attachStream(record: TaskRecord, lastEventId?: string): PassThrough {
  const stream = new PassThrough();

  // 断线重连时浏览器会自动带上 Last-Event-ID，从那条之后接着发。
  // 不做这件事的话，重连会把前面所有事件再推一遍，前端时间线直接翻倍
  const resumeFrom = parseEventId(lastEventId);
  for (let index = resumeFrom; index < record.events.length; index += 1) {
    stream.write(formatEvent("progress", record.events[index], index));
  }

  // 中途接入时把已经生成的回答一次补齐，之后再接增量。
  //
  // 两种数据用两种续传策略，因为它们的特征不同：
  //   事件  离散、可数、必须不重不漏  → 序号增量续传
  //   文本  连续、只关心最终形态      → 全量替换
  // 给几千个 token 的文本逐段编号才是自找麻烦
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

/** Last-Event-ID 来自客户端，可能是任何东西；解析不出就从头补 */
function parseEventId(value?: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed + 1;
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
    cancelReason: record.cancelReason,
  };
}

export function toResponse(record: TaskRecord) {
  return { ...summaryOf(record), root: record.root, events: record.events, result: record.result };
}

/**
 * 拼一条 SSE 报文。
 *
 * 带 `id` 的那些是可续传的——浏览器会记住最后一条 id，
 * 重连时自动放进 `Last-Event-ID` 请求头，不需要客户端写一行代码。
 * **这是 SSE 协议自带的能力，不是我们发明的机制。**
 */
export function formatEvent(name: string, payload: unknown, id?: number): string {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function evictOld(): void {
  const finished = [...tasks.values()]
    .filter((record) => record.status !== "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  for (const record of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED))) {
    tasks.delete(record.taskId);
  }
}
