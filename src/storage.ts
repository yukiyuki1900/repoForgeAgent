import Database from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AnalysisResult } from "./model.js";

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
  const dir = path.join(root, ".reposurgeon");
  await mkdir(dir, { recursive: true });
  const dbPath = path.join(dir, "index.db");
  return { db: new Database(dbPath), dbPath };
}

export async function saveIndex(root: string, result: AnalysisResult): Promise<string> {
  const { db, dbPath } = await openDatabase(root);
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
): Promise<string> {
  const { db, dbPath } = await openDatabase(root);
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
