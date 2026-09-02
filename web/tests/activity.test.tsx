import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityLog, ActivityRow, formatElapsed, ToolDetail } from "../src/ActivityLog";
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

/**
 * 剥掉标签、还原实体，只看纯文本。
 *
 * 工具参数是 JSON，里面的引号会被 React 转义成 `&quot;`——**那正是我们要的**，
 * 这些内容来自模型输出，转义是安全边界。但断言「内容对不对」时盯着转义后的
 * HTML，等于把渲染细节焊进测试：断言内容看纯文本，断言结构才看 HTML。
 */
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");

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

/**
 * 展开后的第二层：这次调用传了什么、看到了什么。
 *
 * 只有工具名和一句摘要的时候，「已查看 3 个文件」是可信的，
 * 但「它读的是不是我关心的那三个文件」无从核对——
 * 而核对，正是展开这个面板的唯一理由。
 */
describe("ToolDetail", () => {
  it("同时给出参数与返回值", () => {
    const output = html(
      <ToolDetail tool={{ args: '{"path":"src/a.ts"}', result: '{"total":3}' }} />,
    );
    assert.match(text(output), /"path":"src\/a\.ts"/);
    assert.match(text(output), /"total":3/);
  });

  it("截断过的返回值必须说出省略了多少", () => {
    const output = html(<ToolDetail tool={{ result: "前 600 字", resultOmitted: 1840 }} />);
    // 静默截断会让人以为看到了全部，然后基于半份数据下判断
    assert.match(output, /1840/);
  });

  it("没被截断时不出现省略提示", () => {
    const output = html(<ToolDetail tool={{ result: "短结果" }} />);
    assert.equal(output.includes("未显示"), false);
  });

  it("两样都没有时整块不渲染，而不是留一个空框", () => {
    assert.equal(html(<ToolDetail tool={{}} />), "");
  });

  it("事件带 tool 字段时，明细真的接到了行上", () => {
    // 组件写对了但没接上去，是这一层最容易漏的失败——
    // 两边各自的单测都绿，中间那根线没人测
    const output = html(
      <ActivityRow
        event={{ at: "", channel: "tool", label: "readSource", tool: { args: '{"x":1}' } }}
      />,
    );
    assert.match(text(output), /"x":1/);
  });

  it("非工具事件不渲染明细块", () => {
    const output = html(<ActivityRow event={step("扫描仓库", "319 个文件")} />);
    assert.equal(output.includes("activity-tool"), false);
  });
});
