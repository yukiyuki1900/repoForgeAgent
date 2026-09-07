import { useEffect, useRef, useState } from "react";
import { ActivityLog, formatElapsed } from "./ActivityLog";
import { StreamingMarkdown } from "./Markdown";
import {
  describeConnection,
  describeError,
  loadTask,
  peekTask,
  resumeTask,
  runTask,
  TaskCancelled,
  TaskDisconnected,
  type TaskEvent,
  type TaskStatus,
} from "./task";
import { forget, recall } from "./session";
import { taskFromUrl, writeTaskToUrl } from "./deeplink";
import { TaskHistory, type TaskHistoryItem } from "./TaskHistory";
import { useTypewriter } from "./typewriter";

/**
 * 追问面板。
 *
 * 两条原则：
 *
 * **过程默认折叠，但必须能展开。** 十几次工具调用铺开会占掉大半屏，
 * 而其中绝大多数只是「查了一下」。折叠成一行摘要，想核对时再展开——
 * 但绝不能没有：一个看不到推理路径的 Agent 回答，和一段编出来的话没有区别。
 *
 * **回答边生成边显示，但按块渲染。** 直接对增量文本反复解析 Markdown 会闪：
 * 表格写到一半时分隔行还没到，会先被当成普通段落，下一帧又重排成表格。
 * 所以以空行为界——成块的部分正常渲染，正在写的那一段保持纯文本。
 * 表格行之间没有空行，这条边界恰好让整张表在写完前都不会中途重排。
 *
 * **节奏由客户端排。** 服务端确实在逐段推，但 TCP 缓冲会合并、React 会
 * 批处理，加上模型吐字本来就快——直接渲染的结果是「唰」地全出来。
 * 所以文本先过一层打字机（typewriter.ts），按帧吐字。
 *
 * **停止要真的停。** 按钮不是把界面切回空闲就完事——`AbortController`
 * 会触发一次服务端 cancel，把 signal 一路送到 `streamText`。
 * 只做前端的「停止生成」是障眼法，token 照烧。
 *
 * **失败要能重来。** 一句红字提示而没有重试入口，等于让用户自己
 * 把问题再打一遍。停止和失败要分开：用户自己停的不算故障，不提示。
 */

interface AskResult {
  question: string;
  answer: string;
  calls: Array<{ name: string; summary: string }>;
  steps: number;
  exhausted: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

const EXAMPLES = [
  "这个仓库的循环依赖是怎么形成的",
  "哪个模块被依赖得最多，它做了哪些事",
  "找处理用户登录的组件",
];

export function AskPanel({ root }: { root: string }) {
  const [question, setQuestion] = useState("");
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [result, setResult] = useState<AskResult | undefined>();
  /** 流式累积的回答文本，边收边渲染 */
  const [streaming, setStreaming] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [finishedAt, setFinishedAt] = useState<number>();
  /** 上一次失败的问题，用于重试——不能依赖输入框，用户可能已经改了 */
  const [retryable, setRetryable] = useState<string>();
  /** 当前正看着哪个任务。地址栏里的编号、历史列表的高亮都跟着它走 */
  const [taskId, setTaskId] = useState<string>();
  /**
   * 这次是搭上了别人正在跑的任务，不是自己发起的。
   *
   * 只影响一件事：**按钮是「停止」还是「离开」**。系统替用户做的复用，
   * 用户并不知情，这时候给他一个会掐掉别人回答的按钮是不对的。
   */
  const [reused, setReused] = useState(false);
  /** 递增一次让历史列表重拉。任务终结时拨一下，新跑的那条才会出现在列表里 */
  const [reloadToken, setReloadToken] = useState(0);
  const controller = useRef<AbortController>();

  /**
   * 把一个终态翻译成界面语言。
   *
   * 单独抽出来是因为**现在有三条路会走到同一个终态**：提交、接回正在跑的、
   * 从历史里读一条已经结束的。三份各写一遍的话，最先走样的一定是
   * 「超时该不该给重试」这类分支——**它只在出错时才被看见。**
   */
  const applyStatus = (status: TaskStatus<AskResult>, trimmed: string) => {
    if (status.status === "cancelled") {
      // 超时和用户主动停是同一个状态、不同的原因：
      // 前者要给重试入口，后者一个字都不用说
      if (status.cancelReason === "timeout") {
        setNotice("任务超时已中止");
        setRetryable(trimmed);
      }
      return;
    }

    if (status.status === "failed") {
      // 编号让用户报得出来，服务端日志里 grep 它就能捞到这一次的全部记录
      setNotice(`执行失败：${status.error ?? "未知错误"}（编号 ${status.traceId.slice(0, 8)}）`);
      // **只有服务端说「重试有用」才给按钮。** 路径下没有源码、仓库不干净
      // 这类失败再点一万次也一样，给按钮是把无能为力包装成了选择。
      // 老服务端不返回 failure，那时退回原来的行为：一律给
      // `trimmed` 为空说明这是「接回来的任务」，我们手上没有原问题文本，
      // 给不出可点的重试——**没有内容的重试按钮点下去只会更困惑**
      if (trimmed && (status.failure?.retriable ?? true)) setRetryable(trimmed);
      return;
    }
    setResult(status.result);
  };

  const consume = async (
    run: (handlers: {
      onEvent: (event: TaskEvent) => void;
      onConnectionChange: (state: Parameters<typeof describeConnection>[0]) => void;
      onText: (delta: string, replace: boolean) => void;
      signal: AbortSignal;
    }) => Promise<TaskStatus<AskResult>>,
    trimmed: string,
  ) => {
    try {
      const status = await run({
        onEvent: (event) => setEvents((previous) => [...previous, event]),
        onConnectionChange: (state) => setNotice(describeConnection(state)),
        onText: (delta, replace) =>
          setStreaming((previous) => (replace ? delta : previous + delta)),
        signal: controller.current!.signal,
      });

      applyStatus(status, trimmed);
    } catch (error) {
      // 用户自己点的停止不是故障，不该弹红字
      if (error instanceof TaskCancelled) return;
      setNotice(describeError(error));
      // 连接断了不给重试入口：任务在服务端还活着，再点一次只会起第二个，
      // 两个一起跑。真失败和看不见了，该给的选项不一样
      if (trimmed && !(error instanceof TaskDisconnected)) setRetryable(trimmed);
    } finally {
      setFinishedAt(Date.now());
      setBusy(false);
      // 跑完了才让历史列表重拉：这条任务的终态这时候才落进归档
      setReloadToken((previous) => previous + 1);
    }
  };

  const ask = async (override?: string) => {
    const trimmed = (override ?? question).trim();
    if (!trimmed) {
      setNotice("请先输入问题");
      return;
    }

    controller.current = new AbortController();
    setBusy(true);
    setReused(false);
    setRetryable(undefined);
    setEvents([]);
    setResult(undefined);
    setStreaming("");
    setNotice("");
    setStartedAt(Date.now());
    setFinishedAt(undefined);

    await consume(
      (handlers) =>
        runTask<AskResult>({
          url: "/ask",
          body: { root, question: trimmed },
          // 记下 taskId，刷新之后能接回来。**服务端一直记得这个任务，
          // 此前只有前端会忘**——「离线任务」这条承诺在界面上是断的
          resume: { kind: "ask", root },
          // 编号一到手就写进地址栏，**不等任务跑完**：任务跑到一半时
          // 复制走的链接必须是能用的，那正是最想发给别人的时刻
          onAccepted: (accepted) => {
            setTaskId(accepted.taskId);
            setReused(accepted.reused === true);
            writeTaskToUrl("ask", accepted.taskId);
          },
          ...handlers,
        }),
      trimmed,
    );
  };

  /**
   * 打开一个指定编号的任务——地址栏来的、历史列表点的，都走这里。
   *
   * **先探一次，再决定怎么接**，而且分成两条完全不同的路：
   *
   * - 还在跑 → `resumeTask` 挂 SSE，回放 + 续传，和刷新恢复是同一条路
   * - 已结束 → `loadTask` 直接读全量。**不要去订阅一条已经结束的流**：
   *   服务端会把整条时间线重推一遍才发 done，大任务上纯属白烧；
   *   而内存里已经淘汰掉的任务连流都没有，那条路由只会 404
   */
  const open = async (id: string, historic?: TaskHistoryItem) => {
    const peeked = await peekTask(id, root);
    if (!peeked) {
      // 探不到就把线索一起清掉，别让地址栏留着一个死编号——
      // 用户刷新一次就会再撞一次同样的空
      setNotice("这个任务已经找不到了（可能超出了保留上限）");
      forget("ask");
      writeTaskToUrl("ask", undefined);
      return;
    }

    setTaskId(id);
    // 带着编号主动接回来的，取消权归他——用户拿着编号来，
    // 说明他认这个任务是他的，和「系统悄悄把他并过去」不是一回事
    setReused(false);
    writeTaskToUrl("ask", id);
    setRetryable(undefined);
    setEvents([]);
    setResult(undefined);
    setStreaming("");
    setNotice("");
    setStartedAt(historic ? Date.parse(historic.startedAt) : Date.now());
    setFinishedAt(undefined);

    if (peeked.status === "running") {
      controller.current = new AbortController();
      setBusy(true);
      setNotice("正在接回这个任务…");
      await consume(
        (handlers) => resumeTask<AskResult>(id, { resume: { kind: "ask", root }, ...handlers }),
        "",
      );
      return;
    }

    try {
      const status = await loadTask<AskResult>(id, root);
      setEvents(status.events ?? []);
      setStartedAt(Date.parse(status.startedAt));
      setFinishedAt(status.finishedAt ? Date.parse(status.finishedAt) : Date.now());
      applyStatus(status, "");
      // 结果太大没归档时得说清楚，否则用户看到的是「打开了但什么都没有」
      if (status.status === "completed" && !status.result) {
        setNotice("这次的结果太大没有归档，只保留了过程记录");
      }
    } catch (error) {
      setNotice(describeError(error));
    }
  };

  /**
   * 页面打开时决定看哪个任务。
   *
   * **地址栏优先于本地记录**：URL 里的编号是用户（或发链接给他的人）
   * 明说的，本地那条只是我们替他记住的——**明说的永远盖过猜的**。
   *
   * 两者都要先探一眼再接（`open` 里做）：服务端内存只留最近 20 条，
   * 进程重启更是全清。直接去接一个不存在的任务，用户会先看到
   * 「正在重连（1/5）」再看到「连接中断」——**为一个根本不存在的东西
   * 表演一遍重连**，比没有恢复功能还糟。
   */
  useEffect(() => {
    let dropped = false;

    void (async () => {
      const fromUrl = taskFromUrl("ask");
      const pending = fromUrl ?? recall("ask", root)?.taskId;
      if (!pending || dropped) return;

      await open(pending);
    })();

    return () => {
      dropped = true;
    };
  }, [root]);

  const stop = () => {
    // 离开不是失败，但必须说一句——否则界面停下来了，用户会以为任务也停了
    if (reused) setNotice("已离开这个任务，它仍在后台继续。可以从历史记录再点回来");
    controller.current?.abort();
  };

  const started = startedAt !== undefined;

  // 最终结果到达后源文本换成 result.answer，但仍然让打字机播完，
  // 否则最后一截会突然跳出来
  const source = result?.answer ?? streaming;
  const typed = useTypewriter(source);

  return (
    <>
      <section className="control-panel mode-actions">
        <div className="field">
          <label>问题</label>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void ask();
            }}
            placeholder="这个仓库的循环依赖是怎么形成的"
          />
          <div className="example-chips">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" onClick={() => setQuestion(example)}>
                {example}
              </button>
            ))}
          </div>
        </div>
        {busy ? (
          <button className="primary-button" onClick={stop}>
            {reused ? "离开" : "停止生成"}
          </button>
        ) : (
          <button className="primary-button" onClick={() => void ask()}>
            提问 →
          </button>
        )}
      </section>

      {notice && (
        <div className="notice">
          {notice}
          {retryable && (
            <button type="button" className="inline-retry" onClick={() => void ask(retryable)}>
              重试
            </button>
          )}
        </div>
      )}

      {/*
        历史放在活动日志**之前**：没跑任务时它是这一屏唯一有内容的东西，
        排在后面等于藏在一片空白下面
      */}
      <TaskHistory
        root={root}
        kind="ask"
        currentTaskId={taskId}
        reloadToken={reloadToken}
        onPick={(item) => {
          // 点正在看的那条不该把界面清空重来
          if (item.taskId !== taskId) void open(item.taskId, item);
        }}
      />

      {started && (
        <ActivityLog
          events={events}
          running={busy}
          startedAt={startedAt}
          finishedAt={finishedAt}
          label="查证"
        />
      )}

      {(result || streaming) && (
        <section className="panel">
          <div className="panel-head">
            <h2>回答</h2>
            <span className="panel-action">
              {result && typed.settled
                ? `${result.calls.length} 次调用 / ${result.steps} 轮${
                    result.exhausted ? " · 已达上限" : ""
                  }${
                    startedAt !== undefined && finishedAt !== undefined
                      ? ` · ${formatElapsed(finishedAt - startedAt)}`
                      : ""
                  }`
                : "生成中…"}
            </span>
          </div>
          <div className="narration">
            {result?.exhausted && typed.settled && (
              <div className="notice demo">
                模型在轮次上限内没能收敛，下面只是已查到的线索。可以把问题问得更具体一些。
              </div>
            )}
            <div className="answer-body">
              {/*
                流式期间用累积文本，完成后换成 SDK 汇总的最终结果——
                多步调用时中间轮次也可能吐字，累积值未必等于最后那段回答。
              */}
              <StreamingMarkdown text={typed.text} done={result !== undefined && typed.settled} />
            </div>
            {result?.usage && typed.settled && (
              <p className="locate-hint">
                token 输入 {result.usage.promptTokens} · 输出 {result.usage.completionTokens}
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}
