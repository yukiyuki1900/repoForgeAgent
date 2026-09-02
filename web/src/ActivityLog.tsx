import { useEffect, useState } from "react";
import type { TaskEvent } from "./task";

/**
 * 活动日志：一行聚合摘要 + 实时计时，点开才是逐条明细。
 *
 * 之前是把每次工具调用铺成一行。十几次调用就占掉大半屏，而其中绝大多数
 * 只是「查了一下」——真正需要核对的是最终回答里那几个具体断言。
 * 所以默认折叠成「已查看 N 个文件、N 次搜索」，想核对时再展开。
 *
 * 计时放在最显眼处。一次追问要跑十几秒到几分钟，用户最需要的信息不是
 * 「现在在查什么」，而是「它还活着吗、跑了多久了」。
 */

interface Props {
  events: TaskEvent[];
  running: boolean;
  /** 任务开始的时间戳；未开始时为空 */
  startedAt?: number;
  /** 任务结束的时间戳；进行中为空 */
  finishedAt?: number;
  label?: string;
}

/**
 * 工具按用途归类。
 *
 * 逐个报工具名对使用者没有意义——「listHotspots 调了 1 次」不解决任何问题。
 * 归成「搜索 / 查看文件 / 依赖查询」这三类，一眼能看出模型的查证方式。
 */
const TOOL_GROUPS: Record<string, string> = {
  searchFiles: "search",
  findSymbol: "search",
  readSource: "read",
  getFileSummary: "inspect",
  getDependents: "inspect",
  getDependencies: "inspect",
  listCycles: "inspect",
  listHotspots: "inspect",
};

const GROUP_LABELS: Array<{ key: string; render: (count: number) => string }> = [
  { key: "read", render: (n) => `已查看 ${n} 个文件` },
  { key: "search", render: (n) => `${n} 次搜索` },
  { key: "inspect", render: (n) => `${n} 次依赖查询` },
];

/**
 * 耗时文案。
 *
 * `precise` 决定要不要小数位：走时的时候取整（每秒只跳一格，读起来稳），
 * 结束后的总耗时才给到 0.1s——那是个需要记住的数字，值得精确。
 */
export function formatElapsed(ms: number, precise = true): string {
  const seconds = ms / 1000;

  if (seconds < 60) {
    if (!precise) return `${Math.floor(seconds)}s`;
    return ms < 1000 ? `${ms}ms` : `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

/** 走时间隔。每秒一次即可——更快只会让数字糊成一片，读不出任何信息 */
const TICK_MS = 1000;

/**
 * 走时。
 *
 * 结束后定格在 finishedAt，而不是继续跳——一个跑完还在走的计时器
 * 会让人以为任务卡住了。
 */
function useElapsed(startedAt?: number, finishedAt?: number): number {
  const [now, setNow] = useState(() => Date.now());

  // 用 undefined 判断而不是 falsy：时间戳 0 是合法值，
  // 写成 `!startedAt` 会让它被当成「还没开始」，计时永远停在 0
  useEffect(() => {
    if (startedAt === undefined || finishedAt !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt, finishedAt]);

  if (startedAt === undefined) return 0;
  return (finishedAt ?? now) - startedAt;
}

/**
 * 工具调用的参数与返回值。
 *
 * **展示的是预览，不是完整返回值**——`readSource` 一次能返回上百行源码，
 * 服务端已经截断过，这里如实把省略量说出来。
 *
 * 静默截断会让人以为看到了全部，然后基于半份数据下判断；
 * 这条教训在给模型的上下文那层已经付过一次代价了，展示层同理。
 */
export function ToolDetail({ tool }: { tool: NonNullable<TaskEvent["tool"]> }) {
  if (!tool.args && !tool.result) return null;

  return (
    <div className="activity-tool">
      {tool.args && (
        <div className="activity-tool-row">
          <span className="activity-tool-key">参数</span>
          <code>{tool.args}</code>
        </div>
      )}
      {tool.result && (
        <div className="activity-tool-row">
          <span className="activity-tool-key">返回</span>
          <code>
            {tool.result}
            {tool.resultOmitted ? (
              <em className="activity-tool-omitted">…另有 {tool.resultOmitted} 字符未显示</em>
            ) : null}
          </code>
        </div>
      )}
    </div>
  );
}

/**
 * 展开后的一行。
 *
 * 抽成独立组件是为了能被单测直接渲染——展开态藏在 `useState` 后面，
 * 而这套 web 测试用的是 `renderToStaticMarkup`，点不了按钮。
 * 组件留在这里但断言够不着，等于没写：**把接线放进一个测得到的边界里，
 * 比补一个点击模拟的测试栈便宜得多。**
 */
export function ActivityRow({ event }: { event: TaskEvent }) {
  return (
    <div className={`activity-row ${event.channel}`}>
      <span className="activity-name">
        {event.channel === "tool" ? `→ ${event.label}` : event.label}
      </span>
      <span className="activity-note">{event.detail ?? ""}</span>
      {event.tool && <ToolDetail tool={event.tool} />}
    </div>
  );
}

export function ActivityLog({ events, running, startedAt, finishedAt, label }: Props) {
  const [open, setOpen] = useState(false);
  const elapsed = useElapsed(startedAt, finishedAt);

  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.channel !== "tool") continue;
    const group = TOOL_GROUPS[event.label] ?? "inspect";
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }

  const summary = GROUP_LABELS.filter((group) => counts.has(group.key))
    .map((group) => group.render(counts.get(group.key)!))
    .join("、");

  // 没有工具调用时退回最近一条步骤描述，总比空着强
  const lastStep = [...events].reverse().find((event) => event.channel === "step");
  const headline = summary || lastStep?.label || (running ? "准备中" : "无活动");

  return (
    <div className={`activity ${running ? "running" : ""}`}>
      <button type="button" className="activity-head" onClick={() => setOpen(!open)}>
        <span className="activity-time">
          {running ? "已处理" : label ? `${label} 用时` : "用时"} {formatElapsed(elapsed, !running)}
        </span>
        <span className="activity-summary">{headline}</span>
        <span className={`activity-caret ${open ? "open" : ""}`}>⌄</span>
      </button>

      {open && (
        <div className="activity-detail">
          {events.length === 0 ? (
            <p className="activity-empty">尚无记录</p>
          ) : (
            events.map((event, index) => <ActivityRow key={index} event={event} />)
          )}
        </div>
      )}
    </div>
  );
}
