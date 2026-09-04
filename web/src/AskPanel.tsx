import { useRef, useState } from "react";
import { ActivityLog, formatElapsed } from "./ActivityLog";
import { StreamingMarkdown } from "./Markdown";
import { describeError, runTask, TaskCancelled, TaskDisconnected, type TaskEvent } from "./task";
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
  const controller = useRef<AbortController>();

  const ask = async (override?: string) => {
    const trimmed = (override ?? question).trim();
    if (!trimmed) {
      setNotice("请先输入问题");
      return;
    }

    controller.current = new AbortController();
    setBusy(true);
    setRetryable(undefined);
    setEvents([]);
    setResult(undefined);
    setStreaming("");
    setNotice("");
    setStartedAt(Date.now());
    setFinishedAt(undefined);

    try {
      const status = await runTask<AskResult>({
        url: "/ask",
        body: { root, question: trimmed },
        onEvent: (event) => setEvents((previous) => [...previous, event]),
        onText: (delta, replace) =>
          setStreaming((previous) => (replace ? delta : previous + delta)),
        signal: controller.current.signal,
      });

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
        if (status.failure?.retriable ?? true) setRetryable(trimmed);
        return;
      }
      setResult(status.result);
    } catch (error) {
      // 用户自己点的停止不是故障，不该弹红字
      if (error instanceof TaskCancelled) return;
      setNotice(describeError(error));
      // 连接断了不给重试入口：任务在服务端还活着，再点一次只会起第二个，
      // 两个一起跑。真失败和看不见了，该给的选项不一样
      if (!(error instanceof TaskDisconnected)) setRetryable(trimmed);
    } finally {
      setFinishedAt(Date.now());
      setBusy(false);
    }
  };

  const stop = () => controller.current?.abort();

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
            停止生成
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
