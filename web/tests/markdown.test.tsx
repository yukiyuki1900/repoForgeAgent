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

/**
 * 剥掉标签只看文字。
 *
 * 断言"内容在不在"时必须用它：语法高亮会把 `const a = 1` 切成
 * 三个 span，用整串正则去匹配原始 HTML 一定不中——**那是断言写错了，
 * 不是实现坏了**。断言"结构对不对"时才直接看 HTML。
 */
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

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

/**
 * 代码围栏。
 *
 * 这块的难点不在解析，在**流式**：代码块内部允许空行，而分块边界
 * 原本就是按空行切的。切在围栏中间会留下半截未闭合的围栏，
 * 它会把后面所有内容一路吃到结尾——**表格写到一半是局部重排，
 * 围栏写到一半是全局污染。**
 */
describe("代码围栏", () => {
  it("渲染成 pre + code，语言写进 data-lang", () => {
    const output = html("```ts\nconst a = 1;\n```");

    assert.match(output, /<pre class="code-block" data-lang="ts">/);
    assert.match(output, /<code>/);
  });

  it("围栏内的内容是字面文本，不当 Markdown 解析", () => {
    // 这三行在正文里分别是表格、标题、列表，在代码块里全是代码
    const output = html("```\n| a | b |\n|---|---|\n# 不是标题\n- 不是列表\n```");

    assert.equal(output.includes("<table>"), false);
    assert.equal(output.includes("<h3>"), false);
    assert.equal(output.includes("<li>"), false);
    assert.match(output, /# 不是标题/);
  });

  it("代码里的 HTML 照样转义", () => {
    const output = html('```tsx\nconst x = <script>alert(1)</script>;\n```');

    assert.equal(output.includes("<script>"), false);
    assert.match(output, /&lt;script&gt;/);
  });

  it("认得的语言才高亮，不认得的原样输出", () => {
    const highlighted = html("```ts\nconst a = 1; // 注释\n```");
    assert.match(highlighted, /tok-keyword/);
    assert.match(highlighted, /tok-comment/);

    // 猜错语言比不高亮更糟，所以只认白名单里的
    const plain = html("```rust\nlet a = 1; // 注释\n```");
    assert.equal(plain.includes("tok-keyword"), false);
    assert.match(plain, /let a = 1/);
  });

  it("未闭合的围栏不吞掉整篇——写到一半也要能看", () => {
    const output = html("```ts\nconst a = 1;");

    assert.match(output, /<pre class="code-block"/);
    assert.match(text(output), /const a = 1/);
  });
});

describe("流式下的代码围栏", () => {
  const stream = (text: string, done = false) =>
    renderToStaticMarkup(<StreamingMarkdown text={text} done={done} />);

  it("代码块内部的空行不会被当成安全切点", () => {
    // 这是加围栏之后 lastIndexOf("\n\n") 立刻失效的场景：
    // 从最后一个空行切开，settled 里会留下一个没闭合的 ```
    const output = stream("前言。\n\n```ts\nconst a = 1;\n\nconst b = 2;");

    assert.match(output, /<p>前言。<\/p>/, "围栏之前的内容照常成块");
    // 整个未闭合的代码块留在 pending 里，而且已经长得像代码块
    assert.match(output, /streaming-code/);
    assert.match(text(output), /const b = 2/);
    // 关键：settled 部分不该出现被截断的代码块
    assert.equal(
      (output.match(/<pre class="code-block"/g) ?? []).length,
      1,
      "只该有一个代码块，不能被空行切成两个",
    );
  });

  it("正在写的代码块就用代码块的样子显示", () => {
    const output = stream("说明。\n\n```ts\nconst a = 1;");

    // 拿 <p> 渲染再在闭合那一刻换成 <pre>，等于把「不中途重排」
    // 的努力在最后一帧全还回去
    assert.match(output, /streaming-code/);
    assert.equal(output.includes("streaming-pending"), false);
    assert.match(output, /streaming-cursor/);
  });

  it("围栏闭合并跟上空行后，代码块进入已成块部分", () => {
    const output = stream("```ts\nconst a = 1;\n```\n\n接下来");

    assert.match(output, /<pre class="code-block" data-lang="ts">/);
    assert.match(output, /streaming-pending/);
    assert.match(output, /接下来/);
  });

  it("围栏里出现空行时不会误判成两个块", () => {
    const output = stream("```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n收尾");

    assert.equal((output.match(/<pre class="code-block"/g) ?? []).length, 1);
    assert.match(text(output), /const a = 1/);
    assert.match(text(output), /const b = 2/);
  });
});
