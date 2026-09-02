/**
 * 极简语法高亮。
 *
 * **为什么不用 shiki / prism / highlight.js**，三条理由，第二条最硬：
 *
 * 1. 保持和 Markdown 渲染同一个立场：输出 React 元素而不是 HTML 字符串。
 *    这里高亮的是 LLM 输出的仓库内容，`dangerouslySetInnerHTML` 那条路
 *    要么引 DOMPurify，要么开一个 XSS 口子。
 * 2. **shiki 的 API 是异步的，而流式渲染每帧都在重渲染。** 每帧 await 一次
 *    高亮器，要么闪、要么得自己做一层缓存——为了四类 token 不值得。
 * 3. 体积。highlight.js 全量几百 KB，这个界面总共才两千行。
 *
 * 代价写在明面上：**只认 TS/JS 系和 JSON，其它语言原样输出不高亮。**
 * 四类 token（注释 / 字符串 / 数字 / 关键字）覆盖绝大部分视觉收益，
 * 类型名、函数名、JSX 标签一律不管。
 */

export type TokenKind = "comment" | "string" | "number" | "keyword";

export interface Token {
  text: string;
  kind?: TokenKind;
}

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "declare", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof", "let",
  "new", "null", "of", "private", "protected", "public", "readonly", "return",
  "satisfies", "set", "static", "super", "switch", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "var", "void", "while", "yield",
]);

/** 认得的语言。其余的原样输出——**猜错语言比不高亮更糟** */
const SUPPORTED = new Set([
  "ts", "tsx", "js", "jsx", "javascript", "typescript", "mjs", "cjs", "json",
]);

export function isHighlightable(language?: string): boolean {
  return Boolean(language && SUPPORTED.has(language.toLowerCase()));
}

/**
 * 扫描规则，**顺序即优先级**。
 *
 * 全部用 sticky（`y`）标志，从当前位置精确匹配，不做全局搜索。
 */
const RULES: Array<[RegExp, TokenKind | undefined]> = [
  [/\/\/[^\n]*/y, "comment"],
  [/\/\*[\s\S]*?(?:\*\/|$)/y, "comment"],
  [/"(?:[^"\\\n]|\\.)*"?/y, "string"],
  [/'(?:[^'\\\n]|\\.)*'?/y, "string"],
  [/`(?:[^`\\]|\\.)*`?/y, "string"],
  [/\b\d[\w.]*/y, "number"],
  // 标识符先整体吃掉，再查是不是关键字。不这么做的话
  // `constant` 里的 `const` 会被当成关键字
  [/[A-Za-z_$][\w$]*/y, undefined],
];

/**
 * 一次左到右扫描。
 *
 * **关键是单次扫描，不是对同一段文本做多次 replace。** 多次 replace 会让
 * 字符串里的 `//` 被当成注释、注释里的引号被当成字符串开头——
 * 每一类都"对"，合起来就错。左到右一次过，先匹配到的先占住，
 * 后面的规则再没机会插进它中间。
 *
 * 正则里几处 `?` 和 `|$` 是给流式准备的：一个**还没写完**的字符串或注释
 * （右引号还没到）也要能被识别，否则代码块会在每次收到新字符时改变颜色。
 */
export function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let plain = "";
  let index = 0;

  const flush = (): void => {
    if (plain) {
      tokens.push({ text: plain });
      plain = "";
    }
  };

  while (index < code.length) {
    let matched = false;

    for (const [pattern, kind] of RULES) {
      pattern.lastIndex = index;
      const result = pattern.exec(code);
      if (!result || result[0].length === 0) continue;

      const text = result[0];
      const resolved = kind ?? (KEYWORDS.has(text) ? "keyword" : undefined);

      if (resolved) {
        flush();
        tokens.push({ text, kind: resolved });
      } else {
        // 普通标识符并进相邻的纯文本，少产生一堆单字 span
        plain += text;
      }

      index += text.length;
      matched = true;
      break;
    }

    if (!matched) {
      plain += code[index];
      index += 1;
    }
  }

  flush();
  return tokens;
}
