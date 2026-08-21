import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { FileNode, Language } from "./model.js";

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
 * 粗略的圈复杂度估算：统计分支关键字与逻辑运算符出现次数。
 *
 * 已知限制：基于正则，会把字符串与注释里的关键字一并计入，
 * 后续应改为基于 AST 的节点计数。
 */
function cyclomaticComplexity(content: string): number {
  const matches = content.match(/\b(if|for|while|case|catch)\b|&&|\|\||\?/g);
  return 1 + (matches?.length ?? 0);
}
