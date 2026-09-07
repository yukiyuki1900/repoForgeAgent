import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { getSqliteDriver } from "../report/storage.js";
import { log } from "../core/log.js";
import type { TaskKind, TaskRecord, TaskStatus } from "./tasks.js";

/**
 * 任务历史归档。
 *
 * ## 为什么必须落盘
 *
 * 在此之前，任务只活在内存 `Map` 里：保留最近 20 条已结束的，进程一重启
 * 全清。于是「后台任务是离线的，关掉页面它照跑」这条承诺只兑现了一半——
 * **任务确实还在跑，但用户再也找不回它的结果。**
 *
 * 根子上的问题是**一个 Map 同时扮演了两个角色**：正在跑的任务需要的是
 * 「运行时状态」（订阅者集合、AbortController、事件缓冲），而看历史需要的
 * 是「已经发生过的事实」。前者天然属于进程，后者不该随进程消失。
 * 混在一起的后果就是：**任务的寿命等于进程的寿命。**
 *
 * 这里把后者拆出来落到 SQLite：内存 Map 降级成「在跑的任务 + 热缓存」，
 * 归档是唯一可信的历史。
 *
 * ## 为什么写在目标仓库里，而不是一个全局库
 *
 * 沿用 `.reposurgeon/index.db` 那套：**归档跟着被分析的仓库走**。
 * 仓库删了历史跟着没，换台机器打开同一个仓库历史还在，
 * 也不需要考虑「一个全局库里几百个仓库的记录怎么清」。
 *
 * ## 三条和 storage.ts 一致的态度
 *
 * 1. **better-sqlite3 是可选依赖**，拿不到就整体降级成 no-op——
 *    历史看不了是遗憾，任务跑不了是事故。
 * 2. **任何写入失败都不能影响任务**。归档是旁路，不在主链路上。
 * 3. **只告警一次**，复用 storage 里那个模块级的加载状态。
 */

/**
 * 归档 payload 的体积上限。
 *
 * 一次 analyze 的 result 是几 MB（全仓文件表 + 依赖边），而归档表的用途是
 * **让用户找回看过什么**，不是当结果仓库用——完整分析结果本来就已经
 * 写在 `runs` 表和 `.reposurgeon/reports/` 里了，这里再存一份是净亏。
 *
 * 超限时**丢 result 保 events**：时间线是「这次任务发生了什么」的骨架，
 * 几 KB；result 是产物，另有出处。丢掉后在列表里标 `resultOmitted`，
 * **让界面能说明白「为什么点进去没有结果」，而不是显示一片空白**。
 */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** 每个仓库归档保留的条数，超出按开始时间淘汰最旧的 */
const MAX_ARCHIVED = 200;

const TASKS_TABLE = `
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    root TEXT NOT NULL,
    dedupe_key TEXT,
    trace_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    current_step TEXT,
    label TEXT,
    error TEXT,
    cancel_reason TEXT,
    result_omitted INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL
  )
`;

/** 列表页永远是「按开始时间倒序取前 N 条」，这条索引就是为它建的 */
const TASKS_INDEX = `CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at DESC)`;

/** 归档不可用时只提示一次，别在每个任务结束时刷屏 */
let warned = false;

function openArchive(root: string, readonly = false) {
  const Database = getSqliteDriver();
  if (!Database) return undefined;

  const dbPath = path.join(root, ".reposurgeon", "index.db");
  if (readonly) {
    if (!existsSync(dbPath)) return undefined;
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(TASKS_TABLE);
  db.exec(TASKS_INDEX);
  migrate(db);
  return db;
}

/**
 * 补上老库缺的列。
 *
 * `CREATE TABLE IF NOT EXISTS` 对**已经存在**的表什么都不做——它不会
 * 发现建表语句里新加了一列。用户本地那个已经写过任务的 `index.db`
 * 会一直停在旧结构上，而 `INSERT` 会因为列不存在直接失败。
 *
 * 所以列必须显式补，而且**只在可写连接上补**：读取路径的 SELECT 一律
 * 不带新列，这样老库在被写入迁移之前也能正常读——
 * **升级不该让人先丢一次历史。**
 */
function migrate(db: DatabaseHandle): void {
  const columns = db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "dedupe_key")) {
    db.exec("ALTER TABLE tasks ADD COLUMN dedupe_key TEXT");
  }
}

/** 只取用得到的那两个方法：better-sqlite3 是可选依赖，别让它的类型变成必需 */
interface DatabaseHandle {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
}

/**
 * 任务在列表里显示成一句什么话。
 *
 * 用户翻历史时认的是「我当时问了什么」，不是一串 uuid。
 * 三种模式各有各的说法，所以这件事只能在**知道 kind 的地方**做。
 */
export function taskLabel(record: TaskRecord): string {
  const meta = record as unknown as { question?: string; apply?: boolean; query?: string };
  if (record.kind === "ask") return meta.question ?? "问答";
  if (record.kind === "refactor") return meta.apply ? "改造（写入）" : "改造（预演）";
  return meta.query ? `分析：${meta.query}` : "分析";
}

/**
 * 落一条归档。**在任务开始和结束时各调一次。**
 *
 * 开始时就写，是为了让「进程崩在任务中途」这件事在历史里留得下痕迹——
 * 只在结束时写的话，那些没能跑完的任务会**彻底消失**，而它们恰恰是
 * 用户最想知道下落的。代价是需要在读取侧对账（见 `readTaskHistory`）。
 *
 * 主键冲突走 `DO UPDATE`：同一个 taskId 写几次都是覆盖，不是追加。
 */
export function archiveTask(record: TaskRecord): void {
  let db;
  try {
    db = openArchive(record.root);
    if (!db) return;

    const full = {
      events: record.events,
      text: record.text,
      result: record.result,
      failure: record.failure,
    };
    let payload = JSON.stringify(full);
    let resultOmitted = 0;
    if (payload.length > MAX_PAYLOAD_BYTES) {
      resultOmitted = 1;
      payload = JSON.stringify({ ...full, result: undefined });
    }

    db.prepare(
      `INSERT INTO tasks
         (task_id, kind, root, dedupe_key, trace_id, status, started_at, finished_at,
          current_step, label, error, cancel_reason, result_omitted, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         status = excluded.status,
         finished_at = excluded.finished_at,
         current_step = excluded.current_step,
         error = excluded.error,
         cancel_reason = excluded.cancel_reason,
         result_omitted = excluded.result_omitted,
         payload = excluded.payload`,
    ).run(
      record.taskId,
      record.kind,
      record.root,
      // 存它不是为了现在用，而是因为**归档该忠实记录这个任务是什么**。
      // 「什么算同一件事」是任务身份的一部分，丢掉它，归档里就只剩
      // 「跑过一次 ask」，答不上「跑的是哪一次 ask」
      record.dedupeKey,
      record.traceId,
      record.status,
      record.startedAt,
      record.finishedAt ?? null,
      record.currentStep,
      taskLabel(record),
      record.error ?? null,
      record.cancelReason ?? null,
      resultOmitted,
      payload,
    );

    db.prepare(
      `DELETE FROM tasks WHERE task_id IN (
         SELECT task_id FROM tasks ORDER BY started_at DESC LIMIT -1 OFFSET ?
       )`,
    ).run(MAX_ARCHIVED);
  } catch (error) {
    // **归档失败绝不能影响任务。** 只读文件系统、磁盘满、库被别的进程锁住，
    // 都不该让一次已经跑完的分析变成「失败」
    if (!warned) {
      warned = true;
      const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
      // 带上 traceId：归档失败也要能和那一次任务的其他日志串起来
      log("task.archive.failed", { traceId: record.traceId, taskId: record.taskId, reason });
    }
  } finally {
    db?.close();
  }
}

export interface ArchivedTask {
  taskId: string;
  kind: TaskKind;
  root: string;
  traceId: string;
  status: TaskStatus | "interrupted";
  startedAt: string;
  finishedAt?: string;
  currentStep?: string;
  label?: string;
  error?: string;
  cancelReason?: string;
  resultOmitted: boolean;
}

interface TaskRow {
  taskId: string;
  kind: TaskKind;
  root: string;
  traceId: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt: string | null;
  currentStep: string | null;
  label: string | null;
  error: string | null;
  cancelReason: string | null;
  resultOmitted: number;
}

const SELECT_COLUMNS = `
  task_id AS taskId, kind, root, trace_id AS traceId, status,
  started_at AS startedAt, finished_at AS finishedAt,
  current_step AS currentStep, label, error,
  cancel_reason AS cancelReason, result_omitted AS resultOmitted
`;

/**
 * 读某个仓库的任务历史。
 *
 * ## `liveIds` 这个参数是这里最关键的一件事
 *
 * 归档在任务**开始**时就写了一行 `status = "running"`。如果进程在任务
 * 中途挂掉，那一行就永远停在 running 上——**库里的 running 是一句谎话**，
 * 照直渲染的话，用户会看到一个永远转圈、点进去还会去连一条不存在的流的
 * 幽灵任务。
 *
 * 判据只能由调用方给：**只有内存知道现在真的有哪些任务在跑。**
 * 归档里写着 running、而内存里没有的，一律翻译成 `interrupted`——
 * 这是一个诚实的第四种状态：不是完成、不是失败、也不是被谁取消的，
 * 是「没能跑到有结论」。
 */
export function readTaskHistory(
  root: string,
  liveIds: ReadonlySet<string>,
  limit = 20,
): ArchivedTask[] {
  let db;
  try {
    db = openArchive(root, true);
    if (!db) return [];

    const rows = db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM tasks ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as TaskRow[];

    return rows.map((row) => toArchived(row, liveIds));
  } catch {
    // 库是旧版本写的、表还不存在、文件损坏——历史读不出来不该让接口 500
    return [];
  } finally {
    db?.close();
  }
}

/** 读一条归档的全量内容，供内存里已经淘汰掉的任务回看 */
export function readArchivedTask(
  root: string,
  taskId: string,
  liveIds: ReadonlySet<string>,
):
  | (ArchivedTask & { events: unknown[]; text?: string; result?: unknown; failure?: unknown })
  | undefined {
  let db;
  try {
    db = openArchive(root, true);
    if (!db) return undefined;

    const row = db
      .prepare(`SELECT ${SELECT_COLUMNS}, payload FROM tasks WHERE task_id = ?`)
      .get(taskId) as (TaskRow & { payload: string }) | undefined;
    if (!row) return undefined;

    const payload = JSON.parse(row.payload) as {
      events?: unknown[];
      text?: string;
      result?: unknown;
      failure?: unknown;
    };
    return {
      ...toArchived(row, liveIds),
      events: payload.events ?? [],
      text: payload.text,
      result: payload.result,
      failure: payload.failure,
    };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function toArchived(row: TaskRow, liveIds: ReadonlySet<string>): ArchivedTask {
  const orphaned = row.status === "running" && !liveIds.has(row.taskId);
  return {
    taskId: row.taskId,
    kind: row.kind,
    root: row.root,
    traceId: row.traceId,
    status: orphaned ? "interrupted" : row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    currentStep: row.currentStep ?? undefined,
    label: row.label ?? undefined,
    error: row.error ?? undefined,
    cancelReason: row.cancelReason ?? undefined,
    resultOmitted: row.resultOmitted === 1,
  };
}
