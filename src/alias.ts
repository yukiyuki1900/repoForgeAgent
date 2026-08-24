import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * 从构建工具配置里静态提取路径 alias。
 *
 * 前端项目普遍把 alias 配在 vite.config / webpack.config 里而不写进 tsconfig
 * 的 paths，此时纯靠 TypeScript 模块解析会大面积缺边——实测一个 319 文件的
 * Vue 仓库因此丢掉 84 条依赖，而且全部集中在 pages / components / layouts
 * 这些最关键的位置。
 *
 * 这里只做静态 AST 提取，不执行配置文件：配置是别人的代码，跑它既不安全也不可靠。
 */
export interface AliasEntry {
  /** 导入说明符前缀，如 @ 或 ~ */
  find: string;
  /** 映射到的绝对目录 */
  replacement: string;
  source: string;
}

const CONFIG_FILES = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mts",
  "vite.config.mjs",
  "vitest.config.ts",
  "webpack.config.js",
  "webpack.config.ts",
  "rspack.config.js",
  "rspack.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
];

/** 不是路径的字符串字面量，出现在 new URL(..., import.meta.url) 这类表达式里 */
const NON_PATH_LITERAL = /^(file:|https?:|\.\/?$)/;

export function loadBuildConfigAliases(root: string): AliasEntry[] {
  const entries: AliasEntry[] = [];

  for (const name of CONFIG_FILES) {
    const configPath = path.join(root, name);
    if (!fs.existsSync(configPath)) continue;

    try {
      entries.push(...extractAliases(configPath));
    } catch {
      // 配置文件语法特殊时跳过，不影响主流程
    }
  }

  // 长前缀优先，避免 @ 抢在 @assets 前面命中
  return dedupe(entries).sort((a, b) => b.find.length - a.find.length);
}

/** 变量引用的最大回溯层数，避免自引用造成死循环 */
const MAX_DEREF_DEPTH = 4;

function extractAliases(configPath: string): AliasEntry[] {
  const content = fs.readFileSync(configPath, "utf8");
  const source = ts.createSourceFile(configPath, content, ts.ScriptTarget.Latest, true);
  const configDir = path.dirname(configPath);
  const fileName = path.basename(configPath);
  const variables = collectVariables(source);
  const entries: AliasEntry[] = [];

  const visit = (node: ts.Node): void => {
    // resolve: { alias: {...} } 或 resolve: { alias: someVariable }
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === "alias") {
      entries.push(...readAliasValue(deref(node.initializer, variables), configDir, fileName, variables));
    }

    // resolve: { alias } —— 简写属性，真正的值在同名变量里。
    // 这是实际项目里非常常见的写法，漏掉它等于完全读不到 alias。
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "alias") {
      const target = variables.get("alias");
      if (target) {
        entries.push(...readAliasValue(deref(target, variables), configDir, fileName, variables));
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return entries;
}

/** 收集文件内所有变量声明，供标识符回溯使用 */
function collectVariables(source: ts.SourceFile): Map<string, ts.Expression> {
  const variables = new Map<string, ts.Expression>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (!variables.has(node.name.text)) variables.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return variables;
}

/** 把标识符解引用成它的初始化表达式 */
function deref(node: ts.Node, variables: Map<string, ts.Expression>, depth = 0): ts.Node {
  if (depth >= MAX_DEREF_DEPTH || !ts.isIdentifier(node)) return node;
  const target = variables.get(node.text);
  return target ? deref(target, variables, depth + 1) : node;
}

function readAliasValue(
  node: ts.Node,
  configDir: string,
  source: string,
  variables: Map<string, ts.Expression>,
): AliasEntry[] {
  const entries: AliasEntry[] = [];

  // { "@": path.resolve(__dirname, "src") }
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const find = propertyName(property.name);
      const replacement = resolveLiteralPath(deref(property.initializer, variables), configDir);
      if (find && replacement) entries.push({ find, replacement, source });
    }
    return entries;
  }

  // [{ find: "@", replacement: path.resolve(__dirname, "src") }]
  if (ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      const resolved = deref(element, variables);
      if (!ts.isObjectLiteralExpression(resolved)) continue;

      let find: string | undefined;
      let replacement: string | undefined;
      for (const property of resolved.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyName(property.name);
        if (key === "find" && ts.isStringLiteralLike(property.initializer)) {
          find = property.initializer.text;
        }
        if (key === "replacement") {
          replacement = resolveLiteralPath(deref(property.initializer, variables), configDir);
        }
      }
      if (find && replacement) entries.push({ find, replacement, source });
    }
  }

  return entries;
}

/**
 * 从表达式里捞出路径。
 *
 * 常见写法都是包了一层函数调用：
 *   path.resolve(__dirname, "src")
 *   fileURLToPath(new URL("./src", import.meta.url))
 *   path.join(__dirname, "src", "components")
 * 静态执行这些调用不现实，但它们的路径信息都在字符串字面量里，
 * 按出现顺序拼接即可覆盖绝大多数情况。
 */
function resolveLiteralPath(node: ts.Node, configDir: string): string | undefined {
  const literals: string[] = [];

  const walk = (current: ts.Node): void => {
    if (ts.isStringLiteralLike(current) && !NON_PATH_LITERAL.test(current.text)) {
      literals.push(current.text);
    }
    ts.forEachChild(current, walk);
  };
  walk(node);

  if (literals.length === 0) return undefined;
  return path.resolve(configDir, ...literals);
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function dedupe(entries: AliasEntry[]): AliasEntry[] {
  const seen = new Map<string, AliasEntry>();
  for (const entry of entries) {
    if (!seen.has(entry.find)) seen.set(entry.find, entry);
  }
  return [...seen.values()];
}

/**
 * 是否命中该 alias。
 *
 * 与 @rollup/plugin-alias 的字符串匹配规则一致：必须整体相等或落在路径边界上，
 * 否则 alias "@" 会把 "@vue/compiler-sfc" 这类 npm 包一并吃掉。
 */
export function matchAlias(specifier: string, entry: AliasEntry): string | undefined {
  if (specifier === entry.find) return entry.replacement;
  if (!specifier.startsWith(`${entry.find}/`)) return undefined;
  return path.join(entry.replacement, specifier.slice(entry.find.length + 1));
}
