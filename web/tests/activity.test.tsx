import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityLog, formatElapsed } from "../src/ActivityLog";
import type { TaskEvent } from "../src/task";

/**
 * 活动日志。
 *
 * 折叠摘要是使用者判断「模型查得靠不靠谱」的第一眼信息，
 * 分类算错会直接误导——比如把 8 次依赖查询显示成 8 次搜索。
 */

const tool = (label: string): TaskEvent => ({ at: "", channel: "tool", label });
const step = (label: string, detail?: string): TaskEvent => ({
  at: "",
  channel: "step",
  label,
  detail,
});

const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("formatElapsed", () => {
  it("按量级切换单位", () => {
    assert.equal(formatElapsed(320), "320ms");
    assert.equal(formatElapsed(1500), "1.5s");
    assert.equal(formatElapsed(59_900), "59.9s");
    assert.equal(formatElapsed(60_000), "1m 0s");
    assert.equal(formatElapsed(354_000), "5m 54s");
  });

  it("走时中取整，避免每秒跳一次小数位", () => {
    assert.equal(formatElapsed(320, false), "0s");
    assert.equal(formatElapsed(1500, false), "1s");
    assert.equal(formatElapsed(59_900, false), "59s");
    // 分钟档本来就没有小数位，两种模式一致
    assert.equal(formatElapsed(354_000, false), "5m 54s");
  });
});

describe("ActivityLog", () => {
  it("工具调用按用途聚合，而不是逐条罗列工具名", () => {
    const output = html(
      <ActivityLog
        events={[
          tool("readSource"),
          tool("readSource"),
          tool("searchFiles"),
          tool("findSymbol"),
          tool("findSymbol"),
          tool("getDependents"),
        ]}
        running={false}
        startedAt={1000}
        finishedAt={4000}
      />,
    );

    assert.match(output, /已查看 2 个文件/);
    assert.match(output, /3 次搜索/);
    assert.match(output, /1 次依赖查询/);
    // 折叠态不该出现具体工具名
    assert.equal(output.includes("readSource"), false);
  });

  it("完成后定格显示总用时", () => {
    const output = html(
      <ActivityLog
        events={[tool("searchFiles")]}
        running={false}
        startedAt={0}
        finishedAt={3000}
      />,
    );
    assert.match(output, /3\.0s/);
  });

  it("运行中显示「已处理」，且不带小数位", () => {
    const output = html(
      <ActivityLog events={[tool("searchFiles")]} running startedAt={Date.now() - 12_400} />,
    );
    assert.match(output, /已处理/);
    assert.match(output, /12s/);
    assert.equal(output.includes("12.4s"), false, "走时中不该出现小数位");
  });

  it("没有工具调用时退回最近一条步骤，不显示空白", () => {
    const output = html(
      <ActivityLog
        events={[step("扫描仓库"), step("检测循环依赖", "1 处")]}
        running={false}
        startedAt={0}
        finishedAt={1000}
      />,
    );
    assert.match(output, /检测循环依赖/);
  });

  it("完全没有事件时也不炸", () => {
    const output = html(<ActivityLog events={[]} running={false} startedAt={0} finishedAt={10} />);
    assert.match(output, /无活动/);
  });
});
