import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classify, TaskError } from "../src/core/failure.js";
import { captureLogs } from "../src/core/log.js";
import { cancelTask, startTask } from "../src/task/tasks.js";

/**
 * 失败分类与排障日志。
 *
 * 这两件事一起测，因为它们服务的是同一条链：
 * **用户报一个编号 → 日志里搜得到 → 搜到的记录说得清是哪一类失败。**
 * 少任何一环，「排障」都只是个说法。
 */
describe("失败分类", () => {
  it("已打标的错误直接认领，不去猜文案", () => {
    const failure = classify(new TaskError("git", "git status 失败：not a repository"));
    assert.equal(failure.code, "git");
    assert.equal(failure.message, "git status 失败：not a repository");
  });

  it("retriable 由类型决定，不是每处各写一遍", () => {
    // 同一类失败在不同地方给出不同的可重试判断，界面就会自相矛盾
    assert.equal(classify(new TaskError("timeout", "慢")).retriable, true);
    assert.equal(classify(new TaskError("model", "429")).retriable, true);
    assert.equal(classify(new TaskError("git", "脏")).retriable, false);
    assert.equal(classify(new TaskError("input", "没源码")).retriable, false);
  });

  it("AbortSignal.timeout 抛的是平台标准错误名，认它而不是认文案", async () => {
    // `TimeoutError` 是平台定义的名字。认它意味着**改任何一句提示语
    // 都不会让分类失效**——而正则匹配中文错误信息会
    const signal = AbortSignal.timeout(1);
    const error = await new Promise<unknown>((resolve) => {
      signal.addEventListener("abort", () => resolve(signal.reason), { once: true });
    });

    assert.equal(classify(error).code, "timeout");
    assert.equal(classify(error).retriable, true);
  });

  it("子进程超时的 ETIMEDOUT 也算超时", () => {
    // execFileSync 撞上 timeout 选项时给的是这个码
    assert.equal(
      classify(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })).code,
      "timeout",
    );
  });

  it("没打标的一律 internal，且不承诺可重试", () => {
    // 兜底类型**必须是不可重试的**：不知道是什么，就别让用户白点一次
    const failure = classify(new Error("谁知道呢"));
    assert.equal(failure.code, "internal");
    assert.equal(failure.retriable, false);
    assert.equal(failure.message, "谁知道呢");
  });

  it("非 Error 抛出物也要能归类，不能自己再崩一次", () => {
    // `throw "字符串"` 是野生代码里的常见写法，分类器不该被它放倒
    for (const thrown of ["炸了", 42, null, undefined]) {
      assert.equal(classify(thrown).code, "internal");
    }
  });
});

describe("任务失败时的记录", () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  it("失败会写进 record.failure，而不只是一句话", async () => {
    const record = startTask({
      kind: "analyze",
      root: "/tmp",
      run: async () => {
        throw new TaskError("input", "在 /tmp 下没有找到可分析的源码文件");
      },
    });

    await settle();

    assert.equal(record.status, "failed");
    assert.equal(record.failure?.code, "input");
    assert.equal(record.failure?.retriable, false, "路径下没源码，再点一次也一样");
    // 老字段要保持一致，否则已有调用方会看到两套说法
    assert.equal(record.error, record.failure?.message);
  });

  it("被取消的任务不算失败，也不该有 failure", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      timeoutMs: 60_000,
    });

    await settle();
    cancelTask(record.taskId);
    await settle();

    assert.equal(record.status, "cancelled");
    assert.equal(record.failure, undefined, "用户停的不是故障");
  });
});

describe("排障日志", () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

  it("每条日志都带 traceId——不带的话在排障时等于不存在", async (t) => {
    const { records, restore } = captureLogs();
    t.after(restore);

    const record = startTask({
      kind: "analyze",
      root: "/tmp",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      run: async () => ({ ok: true }),
    });

    await settle();

    assert.ok(records.length >= 2, "至少要有开始和结束两条");
    for (const line of records) {
      assert.equal(line.traceId, record.traceId, `${String(line.event)} 少了编号`);
    }
  });

  it("收尾那条记下状态、耗时和失败类型", async (t) => {
    // 这是排障时最常看的一条：一次任务到底怎么结束的
    const { records, restore } = captureLogs();
    t.after(restore);

    startTask({
      kind: "ask",
      root: "/tmp",
      run: async () => {
        throw new TaskError("model", "模型调用失败：429");
      },
    });

    await settle();

    const finish = records.find((line) => line.event === "task.finish");
    assert.ok(finish, "必须有收尾日志");
    assert.equal(finish.status, "failed");
    assert.equal(finish.failureCode, "model");
    assert.equal(typeof finish.durationMs, "number");
  });

  it("取消也要留痕，否则「任务凭空消失」查不出所以然", async (t) => {
    const { records, restore } = captureLogs();
    t.after(restore);

    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: () => new Promise(() => {}),
      timeoutMs: 60_000,
    });
    cancelTask(record.taskId);
    await settle();

    const cancelled = records.find((line) => line.event === "task.cancel");
    assert.equal(cancelled?.reason, "user");
  });
});
