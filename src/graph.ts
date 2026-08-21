import fs from "node:fs";
import path from "node:path";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ClassDeclaration,
  type SourceFile,
} from "ts-morph";
import type { FileNode, RelationEdge, SymbolNode } from "./model.js";

/**
 * 基于 TypeScript AST 提取符号与关系边。
 *
 * 相比正则实现补齐的能力：
 * - 走 TypeScript 模块解析，支持 tsconfig paths alias、baseUrl 与 index 解析
 * - 识别动态 import() 与 re-export 产生的依赖边
 * - 识别箭头函数组件、memo / forwardRef 包裹的组件、React 类组件
 * - 提取 JSX render 关系边
 *
 * 已知限制：
 * - .vue 文件仍走正则回退，需要接入 @vue/compiler-sfc
 * - 尚未提取函数调用边与 Hook 使用边
 * - 全量解析，未做基于 contentHash 的增量复用
 */
export function extractGraph(
  root: string,
  files: FileNode[],
  contents: Map<string, string>,
): { symbols: SymbolNode[]; edges: RelationEdge[] } {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const symbols: SymbolNode[] = [];
  const edges: RelationEdge[] = [];

  const project = createProject(root);
  const compilerOptions = project.getCompilerOptions();
  const parsed: Array<{ file: FileNode; source: SourceFile }> = [];

  for (const file of files) {
    // .vue 无法交给 TypeScript 直接解析，走正则回退
    if (file.language === "vue") continue;
    const source = project.addSourceFileAtPathIfExists(path.join(root, file.path));
    if (source) parsed.push({ file, source });
  }

  const context: ResolveContext = {
    root,
    byPath,
    byLowerPath: new Map(files.map((file) => [file.path.toLowerCase(), file])),
    compilerOptions,
    outsideRepo: new Set(),
  };

  for (const { file, source } of parsed) {
    symbols.push(...extractSymbols(file, source));
    edges.push(...extractDependencyEdges(file, source, context));
    edges.push(...extractRenderEdges(file, source, context));
  }

  // 静默丢边会让循环依赖漏检、耦合度虚低，比直接报错更危险，至少要让它可见
  if (context.outsideRepo.size > 0) {
    console.warn(
      `[graph] ${context.outsideRepo.size} 个模块解析到了仓库之外，未纳入依赖图` +
        `（monorepo 兄弟包需要单独分析）`,
    );
  }

  for (const file of files) {
    if (file.language !== "vue") continue;
    const content = contents.get(file.path) ?? "";
    symbols.push(...extractVueSymbols(file, content));
    edges.push(...extractVueEdges(file, content, byPath));
  }

  return { symbols, edges };
}

interface ResolveContext {
  root: string;
  byPath: Map<string, FileNode>;
  /** 大小写不敏感文件系统上，resolvedFileName 的大小写沿用 import 说明符 */
  byLowerPath: Map<string, FileNode>;
  compilerOptions: ts.CompilerOptions;
  /** 解析成功但落在仓库之外（monorepo 兄弟包、软链外部路径）的模块 */
  outsideRepo: Set<string>;
}

function createProject(root: string): Project {
  const tsConfigFilePath = findTsConfig(root);

  if (tsConfigFilePath) {
    return new Project({
      tsConfigFilePath,
      // 只解析扫描到的文件，避免把 tsconfig include 里的无关文件与依赖一并拉入
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
  }

  return new Project({
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
}

function findTsConfig(root: string): string | undefined {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 用 TypeScript 的模块解析把 import 说明符映射到仓库内的文件。
 * alias、baseUrl、扩展名补全与 index 解析都由编译器负责。
 */
function resolveModule(
  specifier: string,
  fromFilePath: string,
  context: ResolveContext,
): FileNode | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    fromFilePath,
    context.compilerOptions,
    ts.sys,
  );
  const resolvedFileName = resolved.resolvedModule?.resolvedFileName;
  if (!resolvedFileName) return undefined;

  const relative = path.relative(context.root, resolvedFileName).split(path.sep).join("/");

  const exact = context.byPath.get(relative);
  if (exact) return exact;

  // import "./Utils/x" 在大小写不敏感的文件系统上能解析成功，
  // 但 resolvedFileName 会沿用说明符里的大小写，与扫描到的真实路径对不上
  const insensitive = context.byLowerPath.get(relative.toLowerCase());
  if (insensitive) return insensitive;

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    context.outsideRepo.add(relative);
  }
  return undefined;
}

function extractSymbols(file: FileNode, source: SourceFile): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  const push = (name: string, kind: SymbolNode["kind"], exported: boolean, node: Node): void => {
    symbols.push({
      id: `${file.id}:${name}`,
      fileId: file.id,
      name,
      kind,
      exported,
      startLine: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
    });
  };

  for (const declaration of source.getFunctions()) {
    const name = declaration.getName();
    if (name) push(name, classifyCallable(name), declaration.isExported(), declaration);
  }

  for (const declaration of source.getClasses()) {
    const name = declaration.getName();
    if (name) {
      const kind = isReactClassComponent(declaration) ? "component" : "class";
      push(name, kind, declaration.isExported(), declaration);
    }
  }

  for (const declaration of source.getInterfaces()) {
    push(declaration.getName(), "interface", declaration.isExported(), declaration);
  }

  for (const declaration of source.getTypeAliases()) {
    push(declaration.getName(), "type", declaration.isExported(), declaration);
  }

  for (const statement of source.getVariableStatements()) {
    const exported = statement.isExported();
    for (const declaration of statement.getDeclarations()) {
      const name = declaration.getName();
      push(name, classifyVariable(name, declaration.getInitializer()), exported, declaration);
    }
  }

  return symbols;
}

function classifyCallable(name: string): SymbolNode["kind"] {
  if (/^use[A-Z]/.test(name)) return "hook";
  if (/^[A-Z]/.test(name)) return "component";
  return "function";
}

/** memo / forwardRef / observer 等高阶包裹后仍然是组件 */
const COMPONENT_WRAPPERS = /\b(memo|forwardRef|observer|styled)\b/;

function classifyVariable(name: string, initializer: Node | undefined): SymbolNode["kind"] {
  if (!initializer) return "variable";

  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    return classifyCallable(name);
  }

  if (Node.isCallExpression(initializer)) {
    const callee = initializer.getExpression().getText();
    if (COMPONENT_WRAPPERS.test(callee) && /^[A-Z]/.test(name)) return "component";
    if (/^use[A-Z]/.test(name)) return "hook";
  }

  return "variable";
}

function isReactClassComponent(declaration: ClassDeclaration): boolean {
  const base = declaration.getExtends()?.getText() ?? "";
  return /(^|\.)(Component|PureComponent)\b/.test(base);
}

/**
 * 依赖边：静态 import、re-export、动态 import()。
 */
function extractDependencyEdges(
  file: FileNode,
  source: SourceFile,
  context: ResolveContext,
): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const filePath = source.getFilePath();

  const record = (specifier: string, node: Node): void => {
    const target = resolveModule(specifier, filePath, context);
    if (!target || target.id === file.id) return;
    edges.push({
      from: file.id,
      to: target.id,
      kind: "import",
      location: { file: file.path, line: node.getStartLineNumber() },
    });
  };

  for (const declaration of source.getImportDeclarations()) {
    record(declaration.getModuleSpecifierValue(), declaration);
  }

  for (const declaration of source.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier) record(specifier, declaration);
  }

  for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const [argument] = call.getArguments();
    if (argument && Node.isStringLiteral(argument)) {
      record(argument.getLiteralValue(), call);
    }
  }

  return edges;
}

/**
 * render 边：JSX 中实际渲染了来自其他文件的组件。
 *
 * 这是组件拓扑区别于文件依赖图的关键——
 * import 只说明「引用了」，render 才说明「渲染了」。
 */
function extractRenderEdges(
  file: FileNode,
  source: SourceFile,
  context: ResolveContext,
): RelationEdge[] {
  const importedFrom = collectImportedNames(source, context);
  if (!importedFrom.size) return [];

  const edges: RelationEdge[] = [];
  const seen = new Set<string>();

  const elements = [
    ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const element of elements) {
    const tagName = element.getTagNameNode().getText();
    // <Foo.Bar /> 取命名空间根部
    const rootName = tagName.split(".")[0];
    if (!/^[A-Z]/.test(rootName)) continue;

    const target = importedFrom.get(rootName);
    if (!target || target.id === file.id || seen.has(target.id)) continue;

    seen.add(target.id);
    edges.push({
      from: file.id,
      to: target.id,
      kind: "render",
      location: { file: file.path, line: element.getStartLineNumber() },
    });
  }

  return edges;
}

/** 建立「本地标识符 → 来源文件」映射，覆盖默认导入、具名导入（含 as 重命名）与命名空间导入 */
function collectImportedNames(
  source: SourceFile,
  context: ResolveContext,
): Map<string, FileNode> {
  const importedFrom = new Map<string, FileNode>();
  const filePath = source.getFilePath();

  for (const declaration of source.getImportDeclarations()) {
    const target = resolveModule(declaration.getModuleSpecifierValue(), filePath, context);
    if (!target) continue;

    const defaultImport = declaration.getDefaultImport();
    if (defaultImport) importedFrom.set(defaultImport.getText(), target);

    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport) importedFrom.set(namespaceImport.getText(), target);

    for (const named of declaration.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      importedFrom.set(localName, target);
    }
  }

  return importedFrom;
}

// ---------------------------------------------------------------------------
// Vue 回退：.vue 无法交给 TypeScript 解析，暂时保留正则实现
// TODO: 接入 @vue/compiler-sfc，解析 script setup 与 template 中的组件引用
// ---------------------------------------------------------------------------

const VUE_IMPORT_PATTERN =
  /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+)['"]([^'"]+)['"]/g;
const VUE_SYMBOL_PATTERN =
  /\b(export\s+)?(?:async\s+)?(function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".vue"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.vue"];

function extractVueSymbols(file: FileNode, content: string): SymbolNode[] {
  const symbols: SymbolNode[] = [];

  for (const match of content.matchAll(VUE_SYMBOL_PATTERN)) {
    const [, exported, rawKind, name] = match;
    const line = lineOf(content, match.index);
    symbols.push({
      id: `${file.id}:${name}`,
      fileId: file.id,
      name,
      kind: rawKind === "function" ? "component" : "variable",
      exported: Boolean(exported),
      startLine: line,
      endLine: line,
    });
  }

  return symbols;
}

function extractVueEdges(
  file: FileNode,
  content: string,
  byPath: Map<string, FileNode>,
): RelationEdge[] {
  const edges: RelationEdge[] = [];

  for (const match of content.matchAll(VUE_IMPORT_PATTERN)) {
    const target = resolveRelativeImport(file.path, match[1], byPath);
    if (!target || target.id === file.id) continue;
    edges.push({
      from: file.id,
      to: target.id,
      kind: "import",
      location: { file: file.path, line: lineOf(content, match.index) },
    });
  }

  return edges;
}

function resolveRelativeImport(
  from: string,
  request: string,
  byPath: Map<string, FileNode>,
): FileNode | undefined {
  if (!request.startsWith(".")) return undefined;

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), request));
  const candidates = [
    base,
    ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...INDEX_FILES.map((name) => path.posix.join(base, name)),
  ];

  for (const candidate of candidates) {
    const found = byPath.get(candidate.replace(/^\.\//, ""));
    if (found) return found;
  }

  return undefined;
}

function lineOf(content: string, index: number | undefined): number {
  return content.slice(0, index ?? 0).split(/\r?\n/).length;
}

export function graphToMermaid(files: FileNode[], edges: RelationEdge[]): string {
  const labels = new Map(files.map((file) => [file.id, toMermaidId(file.path)]));
  const lines = ["graph TD"];

  for (const file of files) {
    // 路径里的方括号、圆括号会破坏 Mermaid 语法（Next.js 的 app/[id]/page.tsx 很常见），
    // label 用引号包裹并转义内部引号
    lines.push(`  ${labels.get(file.id)}["${file.path.replaceAll('"', "'")}"]`);
  }
  for (const edge of edges) {
    if (edge.kind !== "import") continue;
    lines.push(`  ${labels.get(edge.from)} --> ${labels.get(edge.to)}`);
  }

  return lines.join("\n");
}

function toMermaidId(filePath: string): string {
  // 只保留标识符安全字符，其余一律折成下划线
  return filePath.replace(/[^A-Za-z0-9_]/g, "_");
}
