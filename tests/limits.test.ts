import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV1 } from "ai/test";
import { stepSignal, TIMEOUTS } from "../src/core/limits.js";
import type { NarrationContext } from "../src/agent/narrate.js";
import { narrateWithModel } from "../src/agent/narrate.js";

/**
 * 超时阈值。
 *
 * 这些数字本身不值得断言——真正要守住的是**分层**：
 * 单步定得紧、总时长定得宽，而且三种模式不共用一个值。
 * 原来那个全局 5 分钟的病根不是「长」，是它同时承担了两种职责。
 */

describe("超时阈值", () => {
  it("单步远小于总时长，否则单步超时形同虚设", () => {
    for (const [mode, total] of Object.entries(TIMEOUTS.task)) {
      assert.ok(
        TIMEOUTS.modelCall < total,
        `${mode}: 单次模型调用上限不该逼近总时长，否则单步这一层没有意义`,
      );
    }
  });

  it("ask 的总时长要放得下轮次上限乘以单轮上限", () => {
    // 8 轮 × 60 秒 = 8 分钟。这正是原来那个全局 5 分钟「偏短」的实证：
    // 一个合法跑满轮次的 ask 会被误杀
    const MAX_STEPS = 8;
    assert.ok(
      TIMEOUTS.task.ask >= MAX_STEPS * TIMEOUTS.modelCall,
      "撞满轮次上限的 ask 不该被总时长误杀",
    );
  });

  it("三种模式不共用一个值", () => {
    const values = new Set(Object.values(TIMEOUTS.task));
    assert.ok(values.size > 1, "共用一个值就回到了老问题：合理上限差一个数量级");
  });
});

describe("stepSignal", () => {
  it("到点自己中止，不需要外部信号", async () => {
    const signal = stepSignal(undefined, 10);
    assert.equal(signal.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signal.aborted, true, "单步超时必须能独立生效");
  });

  it("外部取消能立刻穿透，不用等超时", () => {
    const controller = new AbortController();
    // 给一个长到不可能到期的超时，确保中止只可能来自外部
    const signal = stepSignal(controller.signal, 60_000);

    controller.abort();
    assert.equal(signal.aborted, true, "用户点停止不该等这一步自己超时");
  });

  it("有外部信号时，单步超时依然生效", async () => {
    // 变异测试抓到的漏洞：原来两条用例一条不传外部信号、一条只验外部取消，
    // 于是「有外部信号就直接返回它、丢掉超时」这个实现照样全绿
    const controller = new AbortController(); // 永远不 abort
    const signal = stepSignal(controller.signal, 10);

    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(signal.aborted, true, "外部没动静时，也该被单步超时叫停");
  });

  it("外部信号已经中止时，合成结果立刻就是中止的", () => {
    // 任务已经被取消之后才开始的那一步，不该先跑起来再被叫停
    const controller = new AbortController();
    controller.abort();
    assert.equal(stepSignal(controller.signal, 60_000).aborted, true);
  });
});

describe("模型调用的单步超时", () => {
  it("narrate 用的是合成信号，不是裸的任务级 signal", async () => {
    // 这是整条流水线里唯一的 LLM 节点，也是最慢的一步（实测 18 秒）。
    // 裸传任务级 signal 的话，这一步就没有自己的上限——模型不返回也不报错时，
    // 只能等到任务总时长才被叫停
    const controller = new AbortController();
    let seen: AbortSignal | undefined;

    const model = new MockLanguageModelV1({
      defaultObjectGenerationMode: "json",
      doGenerate: async (options) => {
        seen = options.abortSignal;
        throw new Error("stop here");
      },
    });

    await narrateWithModel(model, {} as NarrationContext, controller.signal).catch(() => undefined);

    assert.ok(seen, "模型调用必须带 signal");
    assert.notEqual(seen, controller.signal, "必须是合成信号：任务级取消 + 单步超时");
  });
});
