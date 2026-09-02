import type { ReactNode } from "react";
import { isHighlightable, tokenize } from "./highlight";

/**
 * 极简 Markdown 渲染。
 *
 * 只支持标题、表格、列表、代码围栏、加粗与行内代码——模型回答里实际会用到的就这些。
 *
 * **刻意不用 `marked` + `dangerouslySetInnerHTML`。** 这里渲染的是 LLM 的
 * 输出，而 LLM 的输出来自代码库内容，等于把仓库里的任意文本喂给 innerHTML。
 * 走 React 元素这条路，转义由框架保证，XSS 这个问题根本不存在——
 * 不需要再引一个 DOMPurify 去堵。
 *
 * 代价是覆盖面窄：嵌套列表、引用块不支持，遇到就按普通段落显示。
 * 对「先给结论再给证据」的回答来说够用了。
 */

export function Markdown({ text }: { text: string }) {
  return <div className="markdown">{renderBlocks(text)}</div>;
}

/** ```lang 或 ``` */
function fenceOf(line?: string): { lang?: string } | undefined {
  const matched = line !== undefined && /^\s*```(\w*)\s*$/.exec(line);
  if (!matched) return undefined;
  return { lang: matched[1] || undefined };
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  return (
    <pre className="code-block" data-lang={lang}>
      <code>
        {isHighlightable(lang)
          ? tokenize(code).map((token, index) =>
              token.kind ? (
                <span key={index} className={`tok-${token.kind}`}>
                  {token.text}
                </span>
              ) : (
                token.text
              ),
            )
          : code}
      </code>
    </pre>
  );
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // 代码围栏。必须排在所有其它块之前——围栏里的内容是**字面文本**，
    // 一行 `| a | b |` 在代码块里就是代码，不是表格
    const fence = fenceOf(line);
    if (fence) {
      const body: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length && !fenceOf(lines[cursor])) {
        body.push(lines[cursor]);
        cursor += 1;
      }

      blocks.push(<CodeBlock key={blocks.length} code={body.join("\n")} lang={fence.lang} />);
      // 越过结尾的 ```；没有结尾（流式写到一半）时 cursor 已经是末尾
      index = cursor + 1;
      continue;
    }

    // 表格：当前行有竖线，下一行是 |---|---| 分隔行
    if (line.includes("|") && isDivider(lines[index + 1])) {
      const rows: string[] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].includes("|")) {
        if (lines[cursor].trim()) rows.push(lines[cursor]);
        cursor += 1;
      }

      blocks.push(
        <table key={blocks.length}>
          <thead>
            <tr>
              {splitRow(line).map((cell, i) => (
                <th key={i}>{inline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {splitRow(row).map((cell, j) => (
                  <td key={j}>{inline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      index = cursor;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = (["h3", "h4", "h5", "h5"] as const)[level - 1];
      blocks.push(<Tag key={blocks.length}>{inline(heading[2])}</Tag>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={blocks.length}>
          {items.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // 普通段落：连续的非空行合成一段
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={blocks.length}>{inline(paragraph.join(" "))}</p>);
  }

  return blocks;
}

function isDivider(line?: string): boolean {
  return Boolean(line && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-"));
}

function isBlockStart(line: string): boolean {
  return /^#{1,4}\s/.test(line) || /^\s*[-*]\s+/.test(line) || line.includes("|");
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * 行内标记：`code` 与 **bold**。
 *
 * 先按反引号切分，代码片段内部不再解析加粗——路径里出现星号的情况虽然少见，
 * 但真出现时把它当成加粗标记会把路径切断。
 */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).flatMap((chunk, index) => {
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 1) {
      return [<code key={`c${index}`}>{chunk.slice(1, -1)}</code>];
    }

    return chunk
      .split(/(\*\*[^*]+\*\*)/g)
      .map((part, inner) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 3 ? (
          <b key={`b${index}-${inner}`}>{part.slice(2, -2)}</b>
        ) : (
          part
        ),
      );
  });
}

/**
 * 找一个「已经写完的部分」和「正在写的部分」之间的安全切点。
 *
 * 原本是一句 `text.lastIndexOf("\n\n")`，**加了代码围栏之后这句就错了**：
 *
 * ```
 * ```ts
 * const a = 1;
 *                 ← 代码块内部完全可以有空行
 * const b = 2;
 * ```
 * ```
 *
 * 从最后一个空行切开，settled 里就会留下一个**没有闭合的围栏**。
 * 那半截围栏会把它后面的所有内容一路吃到结尾——
 * **表格写到一半是局部重排，围栏写到一半是全局污染。**
 *
 * 所以切点必须是「不在围栏内的空行」。扫一遍行，进出围栏时翻转状态，
 * 只在围栏外记录候选切点。围栏一直没闭合的话，它开始之后的空行
 * 全都不算数——整个未闭合的代码块留在 pending 里，正是我们要的。
 */
function splitAtSafeBoundary(text: string): { settled: string; pending: string } {
  const lines = text.split("\n");
  let inFence = false;
  /** 最后一个安全空行的行号 */
  let boundary = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (fenceOf(lines[index])) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && !lines[index].trim()) boundary = index;
  }

  if (boundary < 0) return { settled: "", pending: text };
  return {
    settled: lines.slice(0, boundary).join("\n"),
    pending: lines.slice(boundary + 1).join("\n"),
  };
}

/**
 * 流式渲染。
 *
 * 直接对增量文本反复调用 Markdown 会闪：一张表格写到一半时，
 * `|---|---|` 分隔行还没到，解析器只能把它当普通段落；下一帧分隔行来了，
 * 又重排成表格。几百毫秒内整块内容反复跳。
 *
 * 解法是按**空行**切分：最后一个空行之前的内容已经成块，正常渲染；
 * 之后的是正在写的那一段，用纯文本显示。
 *
 * 这条边界恰好对表格友好——表格行之间没有空行，所以整张表在写完并跟上
 * 一个空行之前，都会被当作「正在写」保持纯文本，不会中途重排。
 * 代码围栏则要额外处理，见 `splitAtSafeBoundary`。
 */
export function StreamingMarkdown({ text, done }: { text: string; done: boolean }) {
  if (done) return <Markdown text={text} />;

  const { settled, pending } = splitAtSafeBoundary(text);
  const openFence = fenceOf(pending.split("\n")[0]);

  return (
    <div className="streaming">
      {settled && <Markdown text={settled} />}
      {openFence ? (
        // 正在写的如果是代码块，就用代码块的样子显示。
        // 拿 <p> 渲染再在闭合那一刻换成 <pre>，等于把「不中途重排」
        // 的努力在最后一帧全还回去——**等宽字体和换行本身就是信息**
        <div className="streaming-code">
          <CodeBlock code={pending.split("\n").slice(1).join("\n")} lang={openFence.lang} />
          <span className="streaming-cursor" />
        </div>
      ) : (
        <p className="streaming-pending">
          {pending}
          <span className="streaming-cursor" />
        </p>
      )}
    </div>
  );
}
