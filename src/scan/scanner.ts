import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { FileNode, Language } from "../core/analysis.js";

const EXTENSIONS: Record<string, Language> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".vue": "vue",
};

const IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/.turbo/**",
  "**/storybook-static/**",
  "**/coverage/**",
  // 本工具自己的产物目录，避免重复分析时把上一轮结果读进来
  "**/.reposurgeon/**",
  "**/*.min.js",
  "**/*.bundle.js",
];

export async function scanFiles(
  root: string,
): Promise<{ files: FileNode[]; contents: Map<string, string> }> {
  const names = await fg(["**/*"], { cwd: root, onlyFiles: true, ignore: IGNORED, dot: false });
  const files: FileNode[] = [];
  const contents = new Map<string, string>();

  for (const relative of names) {
    const language = EXTENSIONS[path.extname(relative).toLowerCase()];
    if (!language) continue;

    const absolute = path.join(root, relative);
    const [content, info] = await Promise.all([readFile(absolute, "utf8"), stat(absolute)]);
    const normalized = relative.split(path.sep).join("/");

    files.push({
      id: createHash("sha1").update(normalized).digest("hex"),
      path: normalized,
      language,
      typed: isTyped(language, content),
      size: info.size,
      contentHash: createHash("sha256").update(content).digest("hex"),
      lineCount: content.split(/\r?\n/).length,
      complexity: cyclomaticComplexity(content),
    });
    contents.set(normalized, content);
  }

  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), contents };
}

/**
 * 这个文件带不带类型信息。
 *
 * ## 为什么不能只看扩展名
 *
 * 原本的判定是 `file.language.startsWith("ts")`，而 `.vue` 的 language 就是
 * `"vue"`——**于是一个 100% 用 `<script setup lang="ts">` 写的 Vue3 项目，
 * 每一个 SFC 都被算成「没有类型」**，typing 维度只能拿到 `.ts` 文件的占比。
 * 实测一个 201 个 `.vue` + 108 个 `.ts` 的仓库，这一项从应得的接近满分
 * 掉到 34，把总分整整拉低二十多分。
 *
 * 这类错误最难被发现：**分数仍然是个合理的数字**，只是偏低，没有任何
 * 异常信号提示你口径错了。
 *
 * ## 为什么不把 `.vue` 的 language 直接改成 `"ts"`
 *
 * 因为 `language === "vue"` 是**承重的**：SFC 要走 `<script>` 块抽取
 * （`graph.ts`）、不参与死导出判定（`deadexports.ts`）、`defineProps` 泛型
 * 有特判（`refactor.ts`）、apply 阶段直接拒绝改写（虚拟脚本与源文件行号
 * 不对齐）。改 `language` 会静默地把 SFC 当普通 TS 文件解析——
 * **修一个分数偏低，换来一堆解析错误。**
 *
 * ## 两个 script 块时怎么算
 *
 * 只要有一个带 `lang="ts"` 就算。这个维度衡量的是「有没有类型信息」，
 * 不是「是不是全量类型化」——`<script>` + `<script setup lang="ts">` 混用时，
 * 逻辑主体在后者，判成「没类型」比判成「有类型」错得更离谱。
 */
export function isTyped(language: Language, content: string): boolean {
  if (language === "ts" || language === "tsx") return true;
  if (language !== "vue") return false;

  // 属性顺序不定（`<script setup lang="ts">` / `<script lang='ts' setup>`），
  // 用 `[^>]*` 把匹配限制在 script 开标签内部——否则模板或字符串里出现的
  // `lang="ts"` 字样也会被算进来
  return /<script[^>]*\blang=["']ts["']/.test(content);
}

/**
 * 粗略的圈复杂度估算：统计分支关键字与逻辑运算符出现次数。
 *
 * 已知限制：基于正则，会把字符串与注释里的关键字一并计入，
 * 后续应改为基于 AST 的节点计数。
 */
function cyclomaticComplexity(content: string): number {
  const matches = content.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g);
  return 1 + (matches?.length ?? 0);
}
