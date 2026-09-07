import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { archiveTask, readArchivedTask, readTaskHistory } from "../src/task/history.js";
import type { TaskRecord } from "../src/task/tasks.js";

/**
 * 任务归档。
 *
 * 这一组用例的重点**不是「写进去能读出来」**，那是 SQLite 的事。
 * 真正要守住的是三件在设计上做过取舍、错了却不报错的事：
 *
 * 1. **进程崩在半路留下的 `running` 记录，读出来必须变成 `interrupted`。**
 *    照直渲染的话，用户会看到一个永远转圈的幽灵任务。
 * 2. **超大的 result 丢掉、事件留着**，并且要留下 `resultOmitted` 让界面
 *    能解释「为什么点进去没有结果」。
 * 3. **归档失败绝不能把任务带下水**——它是旁路，不在主链路上。
 */

/**
 * better-sqlite3 是**原生模块**，换过 Node 大版本、没有构建工具链的镜像里
 * 都会装不上——归档模块本身就是按「拿不到就整体降级成 no-op」设计的。
 *
 * 所以这里必须先探一次驱动：驱动没有的时候，下面每一条都会「通过」，
 * 因为读出来的确实是空数组。**一组在依赖缺失时全绿的用例，比没有用例
 * 更危险**——它会让人以为归档被验证过了。宁可整组跳过并说明原因。
 */
const DRIVER = (() => {
  try {
    const Database = createRequire(import.meta.url)("better-sqlite3");
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "history-test-"));

after(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function repo(name: string): string {
  const dir = path.join(SANDBOX, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function record(root: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: "task-1",
    kind: "ask",
    root,
    traceId: "trace-1",
    status: "running",
    startedAt: new Date().toISOString(),
    currentStep: "start",
    events: [],
    subscribers: new Set(),
    controller: new AbortController(),
    ...overrides,
  } as TaskRecord;
}

const NONE: ReadonlySet<string> = new Set();

describe(
  "任务归档",
  { skip: DRIVER ? false : "better-sqlite3 原生绑定不可用：pnpm rebuild better-sqlite3" },
  () => {
    it("开始时写一行，结束时覆盖同一行而不是追加", () => {
      const root = repo("upsert");
      const started = record(root);
      archiveTask(started);
      archiveTask({ ...started, status: "completed", finishedAt: new Date().toISOString() });

      const rows = readTaskHistory(root, NONE);
      assert.equal(rows.length, 1, "同一个 taskId 写两次应该是覆盖");
      assert.equal(rows[0].status, "completed");
    });

    it("库里停在 running、内存里却没有的，读出来是 interrupted", () => {
      const root = repo("orphan");
      archiveTask(record(root, { taskId: "ghost" }));

      // 内存里没有它 —— 这正是「服务端重启过」的样子
      const [orphan] = readTaskHistory(root, NONE);
      assert.equal(orphan.status, "interrupted");

      // 内存里还有它 —— 那它是真的在跑，不能篡改成中断
      const [live] = readTaskHistory(root, new Set(["ghost"]));
      assert.equal(live.status, "running");
    });

    it("result 过大时丢结果保事件，并标记 resultOmitted", () => {
      const root = repo("oversize");
      archiveTask(
        record(root, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          events: [{ at: new Date().toISOString(), channel: "tool", label: "readSource" }],
          // 超过 1MB 上限
          result: { blob: "x".repeat(1_200_000) },
        }),
      );

      const [row] = readTaskHistory(root, NONE);
      assert.equal(row.resultOmitted, true);

      const full = readArchivedTask(root, "task-1", NONE);
      assert.equal(full?.result, undefined, "超限时结果不该被存下来");
      assert.equal(full?.events.length, 1, "但过程记录必须留着——它是这次任务的骨架");
    });

    it("列表按开始时间倒序，最近的排最前", () => {
      const root = repo("order");
      archiveTask(record(root, { taskId: "old", startedAt: "2026-01-01T00:00:00.000Z" }));
      archiveTask(record(root, { taskId: "new", startedAt: "2026-06-01T00:00:00.000Z" }));

      const rows = readTaskHistory(root, NONE);
      assert.deepEqual(
        rows.map((row) => row.taskId),
        ["new", "old"],
      );
    });

    it("三种模式各自显示成一句认得出来的话", () => {
      const root = repo("labels");
      archiveTask(
        record(root, { taskId: "a", kind: "ask", question: "循环依赖怎么形成的" } as never),
      );
      archiveTask(record(root, { taskId: "b", kind: "refactor", apply: true } as never));
      archiveTask(record(root, { taskId: "c", kind: "analyze" }));

      const labels = new Map(readTaskHistory(root, NONE).map((row) => [row.taskId, row.label]));
      assert.equal(labels.get("a"), "循环依赖怎么形成的");
      assert.equal(labels.get("b"), "改造（写入）");
      assert.equal(labels.get("c"), "分析");
    });
  },
);

/**
 * 这两条**不跳过**：它们要守的正是「归档这条路走不通」时的行为，
 * 而那和驱动装没装上无关——驱动缺失本身就是其中一种走不通。
 */
describe("归档是旁路，坏了不能把任务带下水", () => {
  it("目标目录不可写时不抛", () => {
    // 一个不存在也建不出来的路径：写不进去是必然的
    const bogus = path.join(SANDBOX, "not-a-dir", "\0invalid");
    assert.doesNotThrow(() => archiveTask(record(bogus)));
  });

  it("从没归档过的仓库读历史，是空数组而不是报错", () => {
    assert.deepEqual(readTaskHistory(repo("empty"), NONE), []);
    assert.equal(readArchivedTask(repo("empty"), "whatever", NONE), undefined);
  });
});
