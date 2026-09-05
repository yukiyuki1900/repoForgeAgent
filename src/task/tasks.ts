import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

import { TIMEOUTS } from "../core/limits.js";
import { classify, type TaskFailure } from "../core/failure.js";
import { log } from "../core/log.js";
import { newTrace } from "../core/trace.js";

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
  /**
   * W3C Trace Context 的 trace-id，沿用客户端送来的那个。
   *
   * **它是「用户报障」和「服务端日志」之间唯一的桥。** 用户说「卡住了」，
   * 报的是这个编号的前 8 位；没有它，那句话在日志里对应不到任何东西。
   */
  traceId: string;
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
  /**
   * 失败的人话描述。保留它是为了**不破坏已有的调用方**，
   * 内容和 `failure.message` 一致。新代码该读 `failure`
   */
  error?: string;
  /**
   * 结构化的失败信息。
   *
   * 比一个字符串多回答两个问题：**是哪一类**（供聚合与排障）、
   * **重试有没有用**（供界面决定给不给重试入口）。
   */
  failure?: TaskFailure;
  /** 谁把它停掉的。只在 status 为 cancelled 时有值 */
  cancelReason?: CancelReason;
  /**
   * 取消这个任务的把手。
   *
   * **前端断开连接不等于任务停了** ——那只是「不看了」，
   * 后台该跑还跑，该烧的 token 一个不少。要真的停下来，
   * signal 必须一路传到 `streamText`。
   */
  controller: AbortController;
}

/** 已完成的任务保留上限，超出后按开始时间淘汰最旧的 */
const MAX_RETAINED = 20;

/**
 * 心跳间隔。
 *
 * 它解决的是一个**前端无法自己判断**的问题：SSE 连接看起来是开着的，
 * 但一个字节都过不来（TCP 半开、中间网关静默丢弃）。这种情况下服务端
 * 往坏掉的 socket 里写是不报错的，浏览器也不会触发 error 事件重连。
 *
 * 早期版本让前端用「多久没收到进度」来猜，那是**用错了指标**：
 * 进度的间隔取决于任务快慢，一个合法的慢节点（`narrate` 单节点 18 秒）
 * 完全可能长时间没有事件。心跳是恒定频率的，收不到就只可能是链路问题。
 *
 * 发成具名事件而不是 SSE 注释行（`: ping`），因为注释行浏览器会吞掉，
 * **JS 侧感知不到**——那样只能保活代理，帮不了前端判断。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 任务整体超时。
 *
 * 这里原来写着「在最外层设一道，比在每个可能卡住的地方各设一道更可靠
 * ——后者总会漏掉刚加的那个」。**那句话只对了一半。**
 *
 * 对的部分：最外层这道确实不能省，因为大部分步骤**根本打不断**——
 * ts-morph 建图、类型检查、Tarjan 全是同步 CPU 密集，一旦开始，
 * 任何 signal 都停不了它。这道网是它们唯一的防线。
 *
 * 错的部分：不该**只有**这一道。总时长 = 各步骤之和，而步骤数本身是
 * 动态的（`ask` 的轮数由模型决定，1 轮和 8 轮差 8 倍），给一个方差这么大
 * 的分布设固定阈值，必然两头不讨好。真正的超时控制该落在单步上。
 *
 * 兜底值**按 `kind` 取**，而不是一个跨模式的常量。原来那个常量是
 * 五分钟：三条路由都显式传了各自的值，所以线上没问题——但新加一种模式
 * 只要忘了传，就会静默拿到五分钟，`ask` 那种要十分钟的直接被腰斩。
 * 这跟工具事件回填那条是同一个道理：**能从已有信息推出来的，就别靠
 * 人记得传**，漏传的失败是静默的。
 */
const defaultTimeout = (kind: TaskKind): number => TIMEOUTS.task[kind];

const tasks = new Map<string, TaskRecord>();

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export interface StartTaskInput<TResult> {
  kind: TaskKind;
  root: string;
  /** 客户端送来的 trace-id；不传就自己生成一个 */
  traceId?: string;
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
    traceId: input.traceId ?? newTrace().traceId,
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

  log("task.start", { traceId: record.traceId, taskId: record.taskId, kind: record.kind });

  const timer = setTimeout(
    () => {
      // 超时和用户取消走同一条路：都是 abort。
      // 区别只记在 cancelReason 上，不占一个状态位
      if (record.status === "running") cancel(record as TaskRecord, "timeout");
    },
    input.timeoutMs ?? defaultTimeout(input.kind),
  );
  // 别让一个等待中的定时器把进程钉住
  timer.unref?.();

  const emit = (event: Omit<TaskEvent, "at">): void => {
    publish(record as TaskRecord, { ...event, at: new Date().toISOString() });
  };

  const emitText = (delta: string): void => {
    record.text = (record.text ?? "") + delta;
    // 文本增量不进 events，所以也没有 id——重连时靠 replace 全量补齐
    const payload = formatEvent("delta", { delta });
    for (const stream of record.subscribers) push(stream, payload);
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
        const failure = classify(error);
        record.status = "failed";
        record.failure = failure;
        record.error = failure.message;
        emit({ channel: "step", label: "失败", detail: failure.message, phase: "error" });
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
      // 收尾这一条是排障时最常看的：一次任务到底怎么结束的、花了多久、
      // 失败属于哪一类。**它必须带 traceId**，否则用户报的编号对不上任何东西
      log("task.finish", {
        traceId: record.traceId,
        taskId: record.taskId,
        kind: record.kind,
        status: record.status,
        durationMs: Date.parse(record.finishedAt) - Date.parse(record.startedAt),
        failureCode: record.failure?.code,
        error: record.error,
      });
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
  log("task.cancel", { traceId: record.traceId, taskId: record.taskId, reason });
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

/**
 * 往一条订阅流里写。
 *
 * **订阅者消失是常态，不是故障。** 任务是离线的：用户发起之后可以断网、
 * 可以关页面，**只有显式 cancel 才该终止它**。所以每个写入点都必须能
 * 容忍「对面已经没了」，而且是**静默跳过**——一旦往上抛，异常会顺着
 * `emit()` 冒进任务体，被那层 try/catch 抓成 `status = "failed"`：
 * **一个客户端的网络问题，会把后台任务判死。**
 *
 * 两个条件是实测量过的，它们的分量**不一样**，别当成对称的一对：
 *
 * - `writableEnded` —— **承重**。`finish()` 调 `end()` 之后 `close` 要等
 *   读端消费完才来，`clearInterval` 挂在 `close` 上，所以这段空隙里心跳
 *   还活着。裸 `write` 在这里撞出过真实崩溃：`ERR_STREAM_WRITE_AFTER_END`
 *   是未捕获错误，直接崩进程。去掉这半边，变异测试立刻变红。
 *
 * - `destroyed` —— **只是省事，不承重**。去掉它测试全绿（27/27）。原因是
 *   写一条已销毁的流本身不报错：干净的 `destroy()` 是静默的，
 *   `destroy(err)` 会重新抛那个 error，而那条路已经由 `attachStream` 里的
 *   `error` 监听兜住了。留着是因为它免费、且表达了意图——但**它不是那道
 *   防线**，防线在 `attachStream`。
 */
function push(stream: PassThrough, payload: string): void {
  if (stream.writableEnded || stream.destroyed) return;
  stream.write(payload);
}

function publish(record: TaskRecord, event: TaskEvent): void {
  // 事件在数组里的下标就是它的 SSE id，不用再维护一个自增计数器
  const id = record.events.length;
  record.events.push(event);
  // node 事件用 start 标记当前步骤；另两种是瞬时的，直接以自己为准
  if (event.phase !== "end") record.currentStep = event.label;

  const payload = formatEvent("progress", event, id);
  for (const stream of record.subscribers) push(stream, payload);
}

/** 终态统一走 done 事件并关闭流，否则标准 SSE 客户端会一直挂着 */
function finish(record: TaskRecord): void {
  const payload = formatEvent("done", summaryOf(record));
  for (const stream of record.subscribers) {
    push(stream, payload);
    if (!stream.destroyed) stream.end();
  }
  record.subscribers.clear();
}

/**
 * 接一条 SSE 流。
 *
 * 先回放已发生的事件再订阅后续；任务如果已经结束，同样以 done 收尾并关流。
 * 两条路径的协议完全一致，客户端不需要区分「接得早」还是「接得晚」。
 */
export function attachStream(
  record: TaskRecord,
  lastEventId?: string,
  /** 心跳间隔，仅供测试注入——真等 15 秒的用例没人会跑 */
  heartbeatMs: number = HEARTBEAT_MS,
): PassThrough {
  const stream = new PassThrough();

  // **这条监听是整个「离线任务」承诺的兜底。**
  //
  // 后台任务是离线的：用户发起之后可以断网、可以关页面，只有显式 cancel
  // 才该终止它。而这条流是**唯一一处「客户端的问题」能物理接触到服务端**
  // 的地方——它一旦以未捕获错误的形式冒出去，就不是「这个订阅者掉线」，
  // 而是**整个进程崩掉、所有人的任务一起陪葬**。
  //
  // 缺口是实测确认的，不是假想：Node 流上没有 `error` 监听就是未捕获异常，
  // 而 Koa 的 respond 是 `body.pipe(res)`（application.js:303）——`pipe()`
  // **不会**给源流挂 error 监听，`onFinished` 听的也是 response 不是它。
  // 所以只要有谁 `destroy(err)` 了这条流（socket hang up、代理掐断），
  // 进程就没了。
  //
  // 这里**故意什么都不做**：订阅者的链路出问题不是任务的故障，不该改状态、
  // 不该记 error、更不该往上抛。清理交给下面的 `close`（error 之后
  // autoDestroy 一定会走到那儿）。**观察者的失败不能改变被观察者的行为。**
  stream.on("error", () => {});

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

  // 心跳不进 events，也不带 id——它不是进度，只是「这条链路还通」。
  // 走 `push` 是必须的而不是顺手：`end()` 到 `close` 之间那段空隙里
  // `clearInterval` 还没执行，裸 `write` 在这里撞出过真实崩溃
  const beat = setInterval(() => push(stream, formatEvent("ping", {})), heartbeatMs);
  beat.unref?.();

  stream.on("close", () => {
    clearInterval(beat);
    record.subscribers.delete(stream);
  });
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
    failure: record.failure,
    cancelReason: record.cancelReason,
    traceId: record.traceId,
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
