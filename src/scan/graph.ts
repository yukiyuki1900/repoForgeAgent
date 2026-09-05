import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { parse as ParseSfc } from "@vue/compiler-sfc";
import {
  Node,
  Project,
  SyntaxKind,
  ts,
  type ClassDeclaration,
  type ImportDeclaration,
  type SourceFile,
} from "ts-morph";
import { loadBuildConfigAliases, matchAlias, type AliasEntry } from "./alias.js";
import type { FileNode, RelationEdge, RelationKind, SymbolNode } from "../core/analysis.js";

/**
 * 基于 TypeScript AST 提取符号与关系边。
 *
 * 相比正则实现补齐的能力：
 * - 走 TypeScript 模块解析，支持 tsconfig paths alias、baseUrl 与 index 解析
 * - 识别动态 import() 与 re-export 产生的依赖边
 * - 识别箭头函数组件、memo / forwardRef 包裹的组件、React 类组件
 * - 提取 JSX / Vue template 的 render 关系边
 * - .vue 经 @vue/compiler-sfc 抽出 script 块后同样走 AST 路径
 *
 * 已知限制：
 * - 尚未提取函数调用边与 Hook 使用边
 * - 全量解析，未做基于 contentHash 的增量复用
 */
/**
 * 模块解析的诊断输出。
 *
 * 静默丢边会让循环依赖漏检、耦合度虚低，比直接报错更危险；
 * 而 alias「读到了」不等于「用上了」，命中与落空必须分开报，
 * 否则无从判断配置识别与依赖图补全之间的差距。
 */
function reportResolveDiagnostics(context: ResolveContext): void {
  if (context.outsideRepo.size > 0) {
    console.warn(
      `[graph] ${context.outsideRepo.size} 个模块解析到了仓库之外，未纳入依赖图` +
        `（monorepo 兄弟包需要单独分析）`,
    );
  }

  for (const entry of context.aliases) {
    const hits = context.aliasHits.get(entry.find) ?? 0;
    const misses = context.aliasMisses.get(entry.find) ?? 0;
    if (hits === 0 && misses === 0) continue;

    const detail = misses > 0 ? `，另有 ${misses} 处命中前缀但目标文件不存在` : "";
    console.log(`[graph] alias ${entry.find} 解析成功 ${hits} 处${detail}`);
  }

  if (context.unresolvedAliases.size > 0) {
    const top = [...context.unresolvedAliases]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([prefix, count]) => `${prefix}… × ${count}`)
      .join("、");
    console.warn(
      `[graph] 有 alias 导入无法解析（${top}）。` +
        `已尝试 tsconfig 的 paths / baseUrl 与 vite / webpack 配置里的 resolve.alias，` +
        `若 alias 由插件动态注入或写在被 import 的独立文件里，请在 tsconfig 中补上同样的映射`,
    );
  }
}

export interface ParsedFile {
  file: FileNode;
  source: SourceFile;
  /** Vue SFC 的 template 原文，用于提取 render 边 */
  template?: string;
}

/**
 * 已装载的语义项目。
 *
 * 抽出来是为了让改造流程复用同一套装载与模块解析逻辑——
 * tsconfig、构建配置 alias、Vue SFC 抽取这些规则如果两边各写一份，
 * 迟早会出现「分析认为有这条边、改造却找不到」的错位。
 */
export interface SemanticProject {
  project: Project;
  parsed: ParsedFile[];
  /** 把 import 说明符解析成仓库内的文件 */
  resolve: (specifier: string, fromFilePath: string) => FileNode | undefined;
  compilerOptions: ts.CompilerOptions;
  /** 打印 alias 命中与未解析统计 */
  reportDiagnostics: () => void;
}

export function openSemanticProject(
  root: string,
  files: FileNode[],
  contents: Map<string, string>,
): SemanticProject {
  const project = createProject(root);
  const compilerOptions = project.getCompilerOptions();
  const parsed: ParsedFile[] = [];

  for (const file of files) {
    const absolute = path.join(root, file.path);

    if (file.language === "vue") {
      const sfc = loadVueSource(project, absolute, contents.get(file.path) ?? "");
      if (sfc) parsed.push({ file, source: sfc.source, template: sfc.template });
      continue;
    }

    const source = project.addSourceFileAtPathIfExists(absolute);
    if (source) parsed.push({ file, source });
  }

  const context: ResolveContext = {
    root,
    byPath: new Map(files.map((file) => [file.path, file])),
    byLowerPath: new Map(files.map((file) => [file.path.toLowerCase(), file])),
    compilerOptions,
    aliases: loadBuildConfigAliases(root),
    outsideRepo: new Set(),
    unresolvedAliases: new Map(),
    aliasHits: new Map(),
    aliasMisses: new Map(),
  };

  for (const entry of context.aliases) {
    const target = path.relative(root, entry.replacement) || ".";
    const exists = fs.existsSync(entry.replacement) ? "" : "（目标目录不存在）";
    console.log(`[graph] alias ${entry.find} → ${target}  来自 ${entry.source}${exists}`);
  }

  return {
    project,
    parsed,
    compilerOptions,
    resolve: (specifier, fromFilePath) => resolveModule(specifier, fromFilePath, context),
    reportDiagnostics: () => reportResolveDiagnostics(context),
  };
}

export function extractGraph(
  root: string,
  files: FileNode[],
  contents: Map<string, string>,
): { symbols: SymbolNode[]; edges: RelationEdge[] } {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const symbols: SymbolNode[] = [];
  const edges: RelationEdge[] = [];

  const semantic = openSemanticProject(root, files, contents);
  const { parsed } = semantic;
  const context: ResolveContext = {
    root,
    byPath,
    byLowerPath: new Map(files.map((file) => [file.path.toLowerCase(), file])),
    compilerOptions: semantic.compilerOptions,
    aliases: loadBuildConfigAliases(root),
    outsideRepo: new Set(),
    unresolvedAliases: new Map(),
    aliasHits: new Map(),
    aliasMisses: new Map(),
  };

  for (const { file, source, template } of parsed) {
    symbols.push(...extractSymbols(file, source));
    if (file.language === "vue") symbols.push(vueComponentSymbol(file, source));
    edges.push(...extractDependencyEdges(file, source, context));
    edges.push(...extractRenderEdges(file, source, context, template));
  }

  reportResolveDiagnostics(context);

  // SFC 解析失败的 .vue 退回正则，至少保住相对路径 import
  const parsedPaths = new Set(parsed.map((item) => item.file.path));
  for (const file of files) {
    if (file.language !== "vue" || parsedPaths.has(file.path)) continue;
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
  /** 从 vite.config / webpack.config 静态提取的 alias */
  aliases: AliasEntry[];
  /** 解析成功但落在仓库之外（monorepo 兄弟包、软链外部路径）的模块 */
  outsideRepo: Set<string>;
  /** 疑似 alias 但解析不了的说明符，用于提示 alias 配置缺失 */
  unresolvedAliases: Map<string, number>;
  /** 每条 alias 实际解析成功的次数 */
  aliasHits: Map<string, number>;
  /** 命中 alias 但目标文件不存在的次数，通常说明 replacement 提取错了 */
  aliasMisses: Map<string, number>;
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

const requireFrom = createRequire(import.meta.url);
/** undefined 表示还没尝试加载，null 表示加载失败且已经提示过 */
let sfcParser: typeof ParseSfc | null | undefined;

/**
 * 按需加载 Vue SFC 编译器。
 *
 * 它只在仓库里真的存在 .vue 文件时才有用，因此做成可选依赖：
 * 缺失时退回正则解析并给出可操作的提示，而不是让整个工具起不来
 * （只分析 React 项目的人不该被 Vue 编译器卡住）。
 */
function getSfcParser(): typeof ParseSfc | null {
  if (sfcParser !== undefined) return sfcParser;

  try {
    sfcParser = requireFrom("@vue/compiler-sfc").parse as typeof ParseSfc;
  } catch {
    sfcParser = null;
    console.warn(
      "[graph] 未找到 @vue/compiler-sfc，.vue 文件退回正则解析" +
        "（alias 导入与 template 组件引用会缺失）。执行 pnpm install 可启用完整解析",
    );
  }

  return sfcParser;
}

/**
 * 把 .vue 的 script 块抽成一个虚拟 TS 文件交给 ts-morph。
 *
 * 关键在于虚拟路径与真实 .vue 同目录（仅追加 .ts 后缀），
 * 这样相对路径、tsconfig alias 的解析结果与真实文件完全一致——
 * Vue 项目大量使用 @/ alias，正则回退会把这些 import 整条丢掉。
 */
function loadVueSource(
  project: Project,
  absolutePath: string,
  content: string,
): { source: SourceFile; template?: string } | undefined {
  const parse = getSfcParser();
  if (!parse) return undefined;

  try {
    const { descriptor, errors } = parse(content, { filename: absolutePath });
    if (errors.length > 0 && !descriptor.script && !descriptor.scriptSetup) return undefined;

    // script setup 与普通 script 可以并存，都要纳入
    const script = [descriptor.script?.content ?? "", descriptor.scriptSetup?.content ?? ""]
      .filter(Boolean)
      .join("\n");

    const source = project.createSourceFile(`${absolutePath}.ts`, script, { overwrite: true });
    return { source, template: descriptor.template?.content };
  } catch {
    return undefined;
  }
}

/** .vue 文件本身就是一个组件，用文件名作为组件名 */
function vueComponentSymbol(file: FileNode, source: SourceFile): SymbolNode {
  const name = toPascalCase(path.basename(file.path, ".vue"));
  return {
    id: `${file.id}:${name}`,
    fileId: file.id,
    name,
    kind: "component",
    exported: true,
    startLine: 1,
    endLine: source.getEndLineNumber(),
  };
}

function toPascalCase(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
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
  const resolved = ts.resolveModuleName(specifier, fromFilePath, context.compilerOptions, ts.sys);
  const resolvedFileName = resolved.resolvedModule?.resolvedFileName;
  if (!resolvedFileName) {
    // TypeScript 不认识 .vue 这类扩展名，模块解析会直接失败，
    // 但 Vue 项目里 `import X from "@/components/X.vue"` 恰恰是最常见的写法
    return resolveByHand(specifier, fromFilePath, context);
  }

  const found = lookupByAbsolute(resolvedFileName, context);
  if (found) return found;

  const relative = path.relative(context.root, resolvedFileName).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    context.outsideRepo.add(relative);
  }
  return undefined;
}

/** 看起来是项目内 alias 而不是 npm 包 */
const ALIAS_LIKE = /^(@\/|~\/|~[^/]|#\/|src\/)/;

/** 手工解析：相对路径 + tsconfig paths alias，用于 TS 解析不了的扩展名 */
function resolveByHand(
  specifier: string,
  fromFilePath: string,
  context: ResolveContext,
): FileNode | undefined {
  if (specifier.startsWith(".")) {
    return lookupByAbsolute(path.resolve(path.dirname(fromFilePath), specifier), context);
  }

  // 构建工具配置里的 alias
  for (const entry of context.aliases) {
    const mapped = matchAlias(specifier, entry);
    if (!mapped) continue;

    const found = lookupByAbsolute(mapped, context);
    if (found) {
      context.aliasHits.set(entry.find, (context.aliasHits.get(entry.find) ?? 0) + 1);
      return found;
    }
    // 命中了 alias 却找不到文件，通常是 replacement 指错了目录
    context.aliasMisses.set(entry.find, (context.aliasMisses.get(entry.find) ?? 0) + 1);
  }

  const paths = context.compilerOptions.paths ?? {};
  const baseUrl = context.compilerOptions.baseUrl ?? context.root;

  for (const [pattern, targets] of Object.entries(paths)) {
    const wildcard = pattern.endsWith("*");
    const prefix = wildcard ? pattern.slice(0, -1) : pattern;
    if (wildcard ? !specifier.startsWith(prefix) : specifier !== pattern) continue;

    const rest = wildcard ? specifier.slice(prefix.length) : "";
    for (const target of targets) {
      const mapped = path.resolve(
        baseUrl,
        target.endsWith("*") ? target.slice(0, -1) + rest : target,
      );
      const found = lookupByAbsolute(mapped, context);
      if (found) return found;
    }
  }

  if (ALIAS_LIKE.test(specifier)) {
    const key = specifier.split("/").slice(0, 2).join("/");
    context.unresolvedAliases.set(key, (context.unresolvedAliases.get(key) ?? 0) + 1);
  }

  return undefined;
}

/** 把绝对路径映射回扫描到的文件，补全扩展名与 index 文件 */
function lookupByAbsolute(absolute: string, context: ResolveContext): FileNode | undefined {
  const relative = path.relative(context.root, absolute).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;

  const candidates = [
    relative,
    ...MODULE_EXTENSIONS.map((extension) => `${relative}${extension}`),
    ...INDEX_FILES.map((name) => `${relative}/${name}`),
  ];

  for (const candidate of candidates) {
    // 大小写不敏感的文件系统上，说明符里的大小写未必与真实路径一致
    const hit = context.byPath.get(candidate) ?? context.byLowerPath.get(candidate.toLowerCase());
    if (hit) return hit;
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
 *
 * 纯类型导入记为 `type-reference` 而不是 `import`。
 * 这不是分类洁癖：`import type` 在编译期被整条擦除，运行时根本不存在这个依赖，
 * 把它算进 import 边会让循环依赖检测虚报——报出来的「环」实际上一行运行时代码都没有。
 */
function extractDependencyEdges(
  file: FileNode,
  source: SourceFile,
  context: ResolveContext,
): RelationEdge[] {
  const edges: RelationEdge[] = [];
  const filePath = source.getFilePath();
  const verbatim = context.compilerOptions.verbatimModuleSyntax === true;

  const record = (specifier: string, node: Node, kind: RelationKind = "import"): void => {
    const target = resolveModule(specifier, filePath, context);
    if (!target || target.id === file.id) return;
    edges.push({
      from: file.id,
      to: target.id,
      kind,
      location: { file: file.path, line: node.getStartLineNumber() },
    });
  };

  for (const declaration of source.getImportDeclarations()) {
    record(
      declaration.getModuleSpecifierValue(),
      declaration,
      erasedAtRuntime(declaration, verbatim) ? "type-reference" : "import",
    );
  }

  for (const declaration of source.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier) continue;
    record(specifier, declaration, declaration.isTypeOnly() ? "type-reference" : "import");
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
 * 这条 import 编译后是否完全消失。
 *
 * 两种写法要区别对待：
 * - `import type { A } from "m"`：声明级，任何配置下都整条擦除
 * - `import { type A } from "m"`：内联级，默认同样擦除；但开了
 *   `verbatimModuleSyntax` 后会保留成 `import {} from "m"`，
 *   变成一条真实的副作用导入，运行时依赖仍然成立
 */
export function erasedAtRuntime(declaration: ImportDeclaration, verbatim: boolean): boolean {
  if (declaration.isTypeOnly()) return true;
  if (verbatim) return false;
  if (declaration.getDefaultImport() || declaration.getNamespaceImport()) return false;

  const named = declaration.getNamedImports();
  // 没有具名导入即副作用导入，必须保留
  if (named.length === 0) return false;

  return named.every((specifier) => specifier.isTypeOnly());
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
  template?: string,
): RelationEdge[] {
  const importedFrom = collectImportedNames(source, context);
  if (!importedFrom.size) return [];

  const usages = template
    ? extractTemplateTags(template)
    : source
        .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
        .concat(source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement) as never[])
        .map((element) => ({
          name: element.getTagNameNode().getText(),
          line: element.getStartLineNumber(),
        }));

  const edges: RelationEdge[] = [];
  const seen = new Set<string>();

  for (const usage of usages) {
    // <Foo.Bar /> 取命名空间根部
    const rootName = usage.name.split(".")[0];
    // Vue 模板里 <my-comp /> 对应 import 进来的 MyComp
    const target =
      importedFrom.get(rootName) ?? importedFrom.get(toPascalCase(rootName)) ?? undefined;
    if (!target || target.id === file.id || seen.has(target.id)) continue;

    seen.add(target.id);
    edges.push({
      from: file.id,
      to: target.id,
      kind: "render",
      location: { file: file.path, line: usage.line },
    });
  }

  return edges;
}

/** 从 Vue template 里取出用到的标签名与行号 */
function extractTemplateTags(template: string): Array<{ name: string; line: number }> {
  const tags: Array<{ name: string; line: number }> = [];

  for (const match of template.matchAll(/<([A-Za-z][\w.-]*)/g)) {
    const name = match[1];
    // 原生 HTML 标签一律小写且不含连字符，组件至少满足其一
    if (!/[A-Z]/.test(name) && !name.includes("-")) continue;
    tags.push({ name, line: lineOf(template, match.index) });
  }

  return tags;
}

/** 建立「本地标识符 → 来源文件」映射，覆盖默认导入、具名导入（含 as 重命名）与命名空间导入 */
function collectImportedNames(source: SourceFile, context: ResolveContext): Map<string, FileNode> {
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
