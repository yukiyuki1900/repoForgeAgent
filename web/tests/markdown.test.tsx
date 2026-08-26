import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, StreamingMarkdown } from "../src/Markdown";

/**
 * Markdown 渲染器的输入是**模型的自由输出**，不是我们能控制的字符串。
 * 表格少一列、标题后面直接跟列表、路径里带下划线——这些都会真实发生，
 * 所以解析逻辑必须有测试兜底，否则一个边界情况就是整块回答变成乱码。
 */

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown 渲染", () => {
  it("表格渲染成 table，而不是一堆竖线", () => {
    const output = html(
      "| 子模块 | 功能 |\n|---|---|\n| `route` | 路由相关 |\n| `is` | 类型判断 |",
    );

    assert.match(output, /<table>/);
    assert.match(output, /<th>子模块<\/th>/);
    assert.match(output, /<code>route<\/code>/);
    assert.equal(output.includes("|---|"), false, "分隔行不能出现在正文里");
  });

  it("标题、列表、加粗与行内代码", () => {
    const output = html("## 结论\n\n- **最高**是 `src/utils/index.ts`\n- 次高是 request");

    assert.match(output, /<h4>结论<\/h4>/);
    assert.match(output, /<li><b>最高<\/b>是 <code>src\/utils\/index\.ts<\/code><\/li>/);
  });

  it("HTML 特殊字符被转义——回答里出现组件名是常态", () => {
    const output = html("渲染了 <Foo /> 与 <script>alert(1)</script>");

    assert.match(output, /&lt;Foo \/&gt;/);
    assert.equal(output.includes("<script>"), false, "绝不能把模型输出当 HTML 执行");
  });

  it("普通多行文本合成段落，不会每行一个 p", () => {
    const output = html("第一行\n第二行\n\n另一段");
    assert.equal((output.match(/<p>/g) ?? []).length, 2);
  });

  it("空输入不炸", () => {
    assert.equal(html(""), '<div class="markdown"></div>');
  });
});

describe("流式渲染", () => {
  const stream = (text: string, done = false) =>
    renderToStaticMarkup(<StreamingMarkdown text={text} done={done} />);

  it("写到一半的表格保持纯文本，不会中途重排", () => {
    // 分隔行还没到，此时若直接解析会先渲染成段落、下一帧再变表格
    const output = stream("## 结论\n\n| 模块 | 职责 |\n| `route`");

    assert.match(output, /<h4>结论<\/h4>/, "已成块的标题应当正常渲染");
    assert.equal(output.includes("<table>"), false, "半张表不该被渲染成表格");
    assert.match(output, /streaming-pending/);
  });

  it("空行之前的内容已成块，正常渲染", () => {
    const output = stream("第一段结论。\n\n正在写的第二段");

    assert.match(output, /<p>第一段结论。<\/p>/);
    assert.match(output, /streaming-pending/);
  });

  it("还没出现空行时，整段都算未完成", () => {
    const output = stream("刚开始写");
    assert.equal(output.includes("<p>刚开始写</p>"), false);
    assert.match(output, /streaming-pending/);
  });

  it("done 之后走完整渲染，光标消失", () => {
    const output = stream("| 模块 | 职责 |\n|---|---|\n| `route` | 路由 |", true);

    assert.match(output, /<table>/);
    assert.equal(output.includes("streaming-cursor"), false);
  });

  it("流式期间同样转义 HTML", () => {
    const output = stream("正在写 <script>alert(1)</script>");
    assert.equal(output.includes("<script>"), false);
  });
});
