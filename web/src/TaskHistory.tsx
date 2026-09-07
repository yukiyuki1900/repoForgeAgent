import { useEffect, useState } from "react";
import { formatElapsed } from "./ActivityLog";

/**
 * 这个仓库跑过的任务。
 *
 * ## 它补的是哪个洞
 *
 * taskId 是 randomUUID，用户不可能记住。在这个列表之前，找回一个任务
 * 只有两条路：地址栏里还留着编号，或者 `localStorage` 里那唯一一条恢复
 * 记录还没被覆盖。两条都断了的话——**任务跑完了，结果还在服务端躺着，
 * 但界面上没有任何入口能走到它。**
 *
 * 「能寻址」和「能被发现」是两件事。前者的前提是你手里已经有编号，
 * 而这个列表是那个编号的来源。
 *
 * ## 为什么 `interrupted` 要单独显示
 *
 * 服务端归档是在任务**开始**时就写一行的，所以进程崩在半路的任务也留得下
 * 记录。这类记录在库里停在 `running` 上，服务端拿内存对账之后翻译成
 * `interrupted`。界面必须把它和「正在跑」区分开：**一个永远转圈的进度条
 * 是在撒谎**，而且用户点进去只会等来一次失败的重连。
 */

export interface TaskHistoryItem {
  taskId: string;
  kind: "analyze" | "refactor" | "ask";
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  label?: string;
  error?: string;
  cancelReason?: string;
  resultOmitted: boolean;
}

export async function fetchTaskHistory(root: string, limit = 20): Promise<TaskHistoryItem[]> {
  const response = await fetch(`/tasks?root=${encodeURIComponent(root)}&limit=${limit}`);
  if (!response.ok) return [];
  const body = (await response.json()) as { tasks?: TaskHistoryItem[] };
  return body.tasks ?? [];
}

const STATUS_TEXT: Record<TaskHistoryItem["status"], string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  // 不是「失败」——失败是跑出了结论说这事不行，这个是**没跑到有结论**。
  // 混为一谈的话，用户会去找一个根本不存在的错误原因
  interrupted: "已中断",
};

/** 相对时间只到「天」，再往前用户关心的是哪一天而不是几小时前 */
function describeWhen(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";

  const elapsed = Date.now() - at;
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Date(at).toLocaleDateString();
}

function describeDuration(item: TaskHistoryItem): string {
  if (!item.finishedAt) return "";
  const span = Date.parse(item.finishedAt) - Date.parse(item.startedAt);
  return Number.isFinite(span) && span > 0 ? formatElapsed(span) : "";
}

export function TaskHistory({
  root,
  kind,
  currentTaskId,
  reloadToken,
  onPick,
}: {
  root: string;
  /** 只看这一种模式的历史。三块面板各管各的，混在一起反而难找 */
  kind: TaskHistoryItem["kind"];
  currentTaskId?: string;
  /**
   * 变一次就重拉一次。
   *
   * 由父组件在任务终结时递增——**列表不自己轮询**：它旁边就是那个任务的
   * 实时进度，为一份用户正盯着的数据再开一条定时拉取，是白花的开销。
   */
  reloadToken?: number;
  onPick: (item: TaskHistoryItem) => void;
}) {
  const [items, setItems] = useState<TaskHistoryItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let dropped = false;
    void (async () => {
      try {
        const list = await fetchTaskHistory(root);
        if (!dropped) setItems(list.filter((item) => item.kind === kind));
      } catch {
        // 历史拉不到不该影响正在进行的事，静默留空
      }
    })();
    return () => {
      dropped = true;
    };
  }, [root, kind, reloadToken]);

  if (items.length === 0) return null;

  return (
    <section className="panel task-history">
      <div className="panel-head">
        <h2>历史记录</h2>
        <button type="button" className="panel-action link-button" onClick={() => setOpen(!open)}>
          {open ? "收起" : `展开 ${items.length} 条`}
        </button>
      </div>
      {open && (
        <ul className="history-list">
          {items.map((item) => (
            <li key={item.taskId} className={item.taskId === currentTaskId ? "current" : undefined}>
              <button type="button" onClick={() => onPick(item)}>
                <span className="history-label" title={item.label}>
                  {item.label ?? item.taskId.slice(0, 8)}
                </span>
                <span className={`history-status status-${item.status}`}>
                  {STATUS_TEXT[item.status]}
                </span>
                <span className="history-meta">
                  {describeWhen(item.startedAt)}
                  {describeDuration(item) && ` · ${describeDuration(item)}`}
                  {/* 结果太大没归档时先说清楚，别让用户点进去看见一片空白 */}
                  {item.resultOmitted && " · 结果未归档"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
