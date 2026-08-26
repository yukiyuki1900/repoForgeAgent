import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runRefactorJob } from "../src/jobs.js";
import { startTask, type TaskEvent } from "../src/tasks.js";

/**
 * 前后端契约。
 *
 * 前端的 TypeScript 接口是**手写**的：后端把 `outcome.cycles` 改成
 * `outcome.cycleReport`，两边都能编译通过，页面上只会静静地显示成空白。
 * 编译器管不到跨进程的字段名，所以这层只能靠断言守住。
 *
 * 这里对着 `web/src/RefactorPanel.tsx` 里读到的每一个字段做检查——
 * 改了后端却忘了改前端时，跑测试就会红。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".tmp-jobs-test");

let current: string | undefined;

function sandboxFrom(fixture: string): string {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  current = dir;

  fs.cpSync(path.join(ROOT, "fixtures", fixture, "src"), path.join(dir, "src"), {
    recursive: true,
  });

  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git([
    "-c",
    "user.email=eval@reposurgeon.local",
    "-c",
    "user.name=eval",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);

  return dir;
}

afterEach(() => {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
});

describe("改造任务的返回契约", () => {
  it("dry-run 的字段与前端读取的一致", async () => {
    const events: TaskEvent[] = [];
    const result = await runRefactorJob(sandboxFrom("13-type-only-cycle"), false, (event) =>
      events.push({ ...event, at: "" }),
    );

    assert.equal(result.applied, false);
    assert.equal(result.outcome, undefined, "未应用时不该有 outcome");
    assert.ok(result.text.length > 0);

    // RefactorPanel 读的是这些字段
    const plan = result.plan!;
    assert.equal(typeof plan.cyclesBefore, "number");
    assert.equal(typeof plan.cyclesAfter, "number");
    assert.equal(typeof plan.filesAffected, "number");
    assert.ok(Array.isArray(plan.blockers));
    assert.ok(Array.isArray(plan.cycles));

    const cycle = plan.cycles[0];
    assert.ok(Array.isArray(cycle.files));
    assert.ok(Array.isArray(cycle.candidates));
    assert.ok(Array.isArray(cycle.blocked));
    assert.equal(typeof cycle.breakable, "boolean");

    const candidate = cycle.candidates[0];
    assert.equal(typeof candidate.file, "string");
    assert.equal(typeof candidate.line, "number");
    assert.equal(typeof candidate.specifier, "string");
    assert.ok(Array.isArray(candidate.names));

    // 进度事件的形状同样是契约的一部分
    assert.ok(events.every((event) => event.channel === "step"));
    assert.ok(events.some((event) => event.detail?.includes("个文件")));
  });

  it("apply 的 outcome 字段与前端读取的一致", async () => {
    const result = await runRefactorJob(sandboxFrom("13-type-only-cycle"), true, () => {});

    assert.equal(result.applied, true);
    const outcome = result.outcome!;

    assert.equal(outcome.status, "applied");
    assert.ok(Array.isArray(outcome.edits));
    assert.ok(Array.isArray(outcome.skipped));
    assert.equal(typeof outcome.outputDir, "string");
    assert.ok(typeof outcome.diff === "string" && outcome.diff.includes("import type"));

    const typecheck = outcome.typecheck as { baselineErrors: number; introduced: unknown[] };
    assert.equal(typeof typecheck.baselineErrors, "number");
    assert.ok(Array.isArray(typecheck.introduced));

    const cycles = outcome.cycles as { before: number; predicted: number; actual: number };
    assert.deepEqual(cycles, { before: 1, predicted: 0, actual: 0 });
  });

  it("没有循环依赖时给出明确文案，而不是空计划", async () => {
    const result = await runRefactorJob(sandboxFrom("09-src-layout"), false, () => {});

    assert.equal(result.plan, null);
    assert.match(result.text, /没有循环依赖/);
  });
});

describe("任务状态机", () => {
  it("成功的任务留下结果与终态", async () => {
    const record = startTask({
      kind: "refactor",
      root: "/tmp",
      run: async ({ emit }) => {
        emit({ channel: "step", label: "干活" });
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.status, "completed");
    assert.deepEqual(record.result, { ok: true });
    assert.equal(record.events.length, 1);
    assert.ok(record.finishedAt);
  });

  it("流式文本累积在 record 上，不进事件数组", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ emitText }) => {
        emitText("前半段");
        emitText("后半段");
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.text, "前半段后半段");
    // 几千个 token 逐条塞进 events 会让内存与回放体积一起失控
    assert.equal(record.events.length, 0);
  });

  it("失败的任务把原因写进事件流，而不是只留一个空状态", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async () => {
        throw new Error("模型不可用");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.status, "failed");
    assert.equal(record.error, "模型不可用");
    // 前端的时间线要能看到失败，否则界面上只是「转圈然后什么都没有」
    assert.ok(record.events.some((event) => event.phase === "error"));
  });
});
