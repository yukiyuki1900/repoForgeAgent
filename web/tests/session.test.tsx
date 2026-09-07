import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { forget, recall, remember } from "../src/session.js";

/**
 * 「记住上次那个任务」。
 *
 * 存的东西极少，但**它是用户输入到达不了、却完全不可控的一块存储**：
 * 用户能手改、上个版本可能留下别的格式、隐私模式下压根写不进去。
 *
 * 所以这一组用例几乎全在测**坏情况**——正常情况只有一条。
 * 判断标准始终是：**宁可当作没有，也不能让页面出问题。**
 */

/** 一个够用的 localStorage 替身；`fail` 打开后所有操作都抛，模拟隐私模式 */
function fakeStorage(fail = false) {
  const map = new Map<string, string>();
  return {
    fail,
    getItem(key: string): string | null {
      if (this.fail) throw new Error("SecurityError");
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (this.fail) throw new Error("QuotaExceededError");
      map.set(key, value);
    },
    removeItem(key: string): void {
      if (this.fail) throw new Error("SecurityError");
      map.delete(key);
    },
    raw: map,
  };
}

const ROOT = "/repo/a";
let storage: ReturnType<typeof fakeStorage>;

describe("任务恢复的记忆", () => {
  beforeEach(() => {
    storage = fakeStorage();
    (globalThis as { localStorage?: unknown }).localStorage = storage;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("存了就能取回来", () => {
    remember("ask", { taskId: "t-1", root: ROOT, startedAt: Date.now() });
    assert.equal(recall("ask", ROOT)?.taskId, "t-1");
  });

  it("三种任务各存各的，不互相覆盖", () => {
    // 用一个 key 存所有的话，分析跑着的时候提个问就会把分析那条冲掉——
    // 而它们在界面上是三块独立的区域
    remember("ask", { taskId: "ask-1", root: ROOT, startedAt: Date.now() });
    remember("analyze", { taskId: "ana-1", root: ROOT, startedAt: Date.now() });

    assert.equal(recall("ask", ROOT)?.taskId, "ask-1");
    assert.equal(recall("analyze", ROOT)?.taskId, "ana-1");
  });

  it("换了仓库就不认——这种错比没有恢复功能更糟", () => {
    // 接回上一个仓库的任务，界面会显示成「正在分析当前仓库」，
    // 而实际跑的是另一个。用户没有任何办法看出这件事
    remember("ask", { taskId: "t-1", root: ROOT, startedAt: Date.now() });
    assert.equal(recall("ask", "/repo/b"), undefined);
  });

  it("过期的记录直接丢掉，并且顺手清干净", () => {
    // 任务最长十分钟，半小时前的必然早就结束了。
    // 留着只会让用户看到一个早就没了的东西
    remember("ask", { taskId: "t-1", root: ROOT, startedAt: Date.now() - 31 * 60_000 });

    assert.equal(recall("ask", ROOT), undefined);
    assert.equal(storage.raw.size, 0, "过期的不该留在存储里占位");
  });

  it("坏掉的内容一律当作没有，不半信半疑地用一半", () => {
    const broken = [
      "{ 不是 json",
      "null",
      '"就一个字符串"',
      "{}", // 字段全缺
      '{"taskId":"","root":"/repo/a","startedAt":1}', // 空 id
      '{"taskId":"t","root":"/repo/a"}', // 少了时间
      '{"taskId":"t","root":"/repo/a","startedAt":"昨天"}', // 时间不是数字
      '{"taskId":"t","root":"/repo/a","startedAt":null}',
    ];

    for (const raw of broken) {
      storage.raw.set("reposurgeon:task:ask", raw);
      assert.equal(recall("ask", ROOT), undefined, `应当丢弃：${raw}`);
      assert.equal(storage.raw.size, 0, `丢弃之后要清掉：${raw}`);
    }
  });

  it("localStorage 完全不可用时，三个函数都不能抛", () => {
    // 隐私模式、被策略禁用、配额满——**一个便利功能不该让页面打不开**
    storage.fail = true;

    assert.doesNotThrow(() => remember("ask", { taskId: "t", root: ROOT, startedAt: Date.now() }));
    assert.doesNotThrow(() => forget("ask"));
    let recalled: unknown = "没跑到";
    assert.doesNotThrow(() => {
      recalled = recall("ask", ROOT);
    });
    assert.equal(recalled, undefined, "取不到就是没有，不是报错");
  });

  it("忘掉之后就真的没了", () => {
    remember("ask", { taskId: "t-1", root: ROOT, startedAt: Date.now() });
    forget("ask");
    assert.equal(recall("ask", ROOT), undefined);
  });
});
