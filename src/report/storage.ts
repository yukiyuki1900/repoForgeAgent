import type DatabaseConstructor from "better-sqlite3";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "../core/analysis.js";

/**
 * SQLite 索引是**加分项，不是主产物**。
 *
 * 分析真正要交付的是 `.reposurgeon/reports/` 下的 md / html / json；
 * 索引只用来让 Web 看板加载命令行跑出的历史结果。
 *
 * better-sqlite3 是原生模块，会在这些场景下不可用：换了 Node 大版本没重新
 * 编译、CI 镜像里没有构建工具链、在只读文件系统上跑。此前它是顶层静态导入，
 * 一旦加载失败整条分析流水线跟着崩——用户明明只想要一份 Markdown 报告，
 * 却因为一个可选的加速索引拿不到任何东西。
 *
 * 所以改成惰性加载 + 一次性告警：拿不到就不写索引，分析照常完成。
 */
const requireFrom = createRequire(import.meta.url);

/** undefined 表示还没尝试加载，null 表示加载失败且已经提示过 */
let sqlite: typeof DatabaseConstructor | null | undefined;

function getSqlite(): typeof DatabaseConstructor | null {
  if (sqlite !== undefined) return sqlite;

  try {
    const loaded = requireFrom("better-sqlite3") as typeof DatabaseConstructor;
    // require 成功不代表能用：原生绑定是在第一次构造时才去 dlopen 的。
    // 这里用一个内存库做探针，把失败收敛到这一处，而不是散落在每个调用点。
    new loaded(":memory:").close();
    sqlite = loaded;
  } catch (error) {
    sqlite = null;
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(
      `[storage] better-sqlite3 不可用（${reason}），本次跳过 SQLite 索引。\n` +
        "          报告仍会写入 .reposurgeon/reports/；Web 看板将无法加载历史结果。\n" +
        "          修复：pnpm rebuild better-sqlite3（换过 Node 版本后通常需要）",
    );
  }

  return sqlite;
}

const RUNS_TABLE = `
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    generated_at TEXT NOT NULL,
    payload TEXT NOT NULL
  )
`;

// 注意：files_fts 已建表，但检索主流程（retrieval.ts）目前尚未查询它
const FILES_FTS_TABLE = `
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path, contentHash)
`;

const CHECKPOINTS_TABLE = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    run_id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    state TEXT NOT NULL
  )
`;

async function openDatabase(root: string) {
  const Database = getSqlite();
  if (!Database) return undefined;

  const dir = path.join(root, ".reposurgeon");
  await mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, "index.db");
  return { db: new Database(dbPath), dbPath };
}

export async function saveIndex(root: string, result: AnalysisResult): Promise<string | undefined> {
  const opened = await openDatabase(root);
  if (!opened) return undefined;

  const { db, dbPath } = opened;
  db.pragma("journal_mode = WAL");
  db.exec(RUNS_TABLE);
  db.exec(FILES_FTS_TABLE);

  db.prepare("INSERT INTO runs (generated_at, payload) VALUES (?, ?)").run(
    result.generatedAt,
    JSON.stringify(result),
  );

  db.prepare("DELETE FROM files_fts").run();
  const insert = db.prepare("INSERT INTO files_fts (path, contentHash) VALUES (?, ?)");
  const insertAll = db.transaction(() => {
    for (const file of result.files) insert.run(file.path, file.contentHash);
  });
  insertAll();

  db.close();
  return dbPath;
}

/**
 * 持久化一次节点执行后的状态快照。
 *
 * 注意：当前快照只用于事后排查，尚未实现基于它的断点恢复；
 * LangGraph 自身使用的是进程内的 MemorySaver（见 workflow.ts）。
 */
export async function saveCheckpoint(
  root: string,
  runId: string,
  state: unknown,
): Promise<string | undefined> {
  const opened = await openDatabase(root);
  if (!opened) return undefined;

  const { db, dbPath } = opened;
  db.exec(CHECKPOINTS_TABLE);

  db.prepare(
    `INSERT INTO checkpoints (run_id, updated_at, state) VALUES (?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at, state = excluded.state`,
  ).run(runId, new Date().toISOString(), serializeState(state));

  db.close();
  return dbPath;
}

function serializeState(state: unknown): string {
  return JSON.stringify(state, (_key, value) =>
    value instanceof Map ? Object.fromEntries(value) : value,
  );
}

export interface RunSummary {
  id: number;
  generatedAt: string;
  files: number;
  findings: number;
  score: number | null;
  framework: string | null;
}

function indexPath(root: string): string {
  return path.join(root, ".reposurgeon", "index.db");
}

/**
 * 读取某个仓库过往的分析记录。
 *
 * CLI 与 API 是两个进程，内存不共享，但产物都落在目标仓库的
 * .reposurgeon/index.db 里——读它就能让 Web 端看到命令行跑过的结果。
 *
 * 摘要字段用 SQL 的 json_extract 取，避免把每条几 MB 的 payload
 * 全部反序列化到 Node 侧。
 */
export function readRunSummaries(root: string, limit = 10): RunSummary[] {
  const Database = getSqlite();
  const dbPath = indexPath(root);
  if (!Database || !existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT id,
                generated_at AS generatedAt,
                json_array_length(payload, '$.files')    AS files,
                json_array_length(payload, '$.findings') AS findings,
                json_extract(payload, '$.metrics.score') AS score,
                json_extract(payload, '$.stack.framework') AS framework
         FROM runs
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as RunSummary[];
  } catch {
    // 索引可能是旧版本写的，或表还不存在
    return [];
  } finally {
    db.close();
  }
}

/** 读取最近一次分析的完整报告 */
export function readLatestRun(root: string): AnalysisResult | undefined {
  const Database = getSqlite();
  const dbPath = indexPath(root);
  if (!Database || !existsSync(dbPath)) return undefined;

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT payload FROM runs ORDER BY id DESC LIMIT 1").get() as
      { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AnalysisResult) : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}
