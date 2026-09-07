import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { modeFromUrl, taskFromUrl, writeTaskToUrl } from "../src/deeplink.js";

/**
 * 地址栏里的任务编号。
 *
 * 它是这套恢复机制里**唯一能被复制、被收藏、被发给别人**的一环，
 * 所以它面对的输入和 `localStorage` 一样不可控：用户会手改、会截断、
 * 会把别的模式的链接粘到这个面板里。
 *
 * 用例集中在两件事：**编号和模式必须配对使用**（类型对不上的数据比
 * 没有数据更难查），以及**写地址栏失败不能影响主流程**。
 */

/** 一个够用的 window 替身；`fail` 打开后 replaceState 抛 SecurityError */
function fakeWindow(search: string, fail = false) {
  return {
    location: { search, pathname: "/", hash: "" },
    history: {
      calls: [] as string[],
      replaceState(_state: unknown, _title: string, url: string) {
        if (fail) throw new Error("SecurityError");
        this.calls.push(url);
      },
    },
  };
}

function install(win: ReturnType<typeof fakeWindow>): void {
  (globalThis as { window?: unknown }).window = win;
}

let win: ReturnType<typeof fakeWindow>;

describe("地址栏里的任务编号", () => {
  beforeEach(() => {
    win = fakeWindow("");
    install(win);
  });

  it("编号和模式都对上才认", () => {
    install(fakeWindow("?task=abc&mode=ask"));
    assert.equal(taskFromUrl("ask"), "abc");
  });

  it("模式对不上就当没有——别拿问答的任务去渲染分析报告", () => {
    install(fakeWindow("?task=abc&mode=ask"));
    assert.equal(taskFromUrl("analyze"), undefined);
  });

  it("只有编号没有模式时放行，老链接仍然能用", () => {
    install(fakeWindow("?task=abc"));
    assert.equal(taskFromUrl("ask"), "abc");
  });

  it("没有编号就是 undefined，不是空字符串", () => {
    install(fakeWindow("?mode=ask"));
    assert.equal(taskFromUrl("ask"), undefined);
  });

  it("认不出来的模式不当数——它只用来决定默认打开哪个面板", () => {
    install(fakeWindow("?mode=hack"));
    assert.equal(modeFromUrl(), undefined);
    install(fakeWindow("?mode=refactor"));
    assert.equal(modeFromUrl(), "refactor");
  });

  it("写入时编号和模式一起落，清除时一起走", () => {
    writeTaskToUrl("ask", "abc");
    assert.match(win.history.calls[0], /task=abc/);
    assert.match(win.history.calls[0], /mode=ask/);

    install((win = fakeWindow("?task=abc&mode=ask&root=%2Frepo")));
    writeTaskToUrl("ask", undefined);
    const cleared = win.history.calls[0];
    assert.doesNotMatch(cleared, /task=/);
    assert.doesNotMatch(cleared, /mode=/);
    // 别人的参数不能顺手带走
    assert.match(cleared, /root=/);
  });

  it("history 不可用时静默失败，不影响任务本身", () => {
    install(fakeWindow("", true));
    assert.doesNotThrow(() => writeTaskToUrl("ask", "abc"));
  });
});
