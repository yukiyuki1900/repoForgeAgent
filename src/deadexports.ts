import fs from "node:fs";
import path from "node:path";
import {
  Node,
  SyntaxKind,
  type ExportDeclaration,
  type Identifier,
  type SourceFile,
} from "ts-morph";
import { openSemanticProject, type SemanticProject } from "./graph.js";
import type { FileNode, Finding } from "./model.js";

/**
 * 未使用的导出检测。
 *
 * 检测本身很简单——对每个导出符号跑一次引用分析，仓库内没人引用就是候选。
 * **全部难度在排除误报**：一个导出「没有静态引用」和「可以安全删掉」是两回事。
 * 入口文件、被 `export *` 转发、框架按约定读取的名字（`getServerSideProps`），
 * 静态上都看不到引用，删掉却会直接把项目改坏。
 *
 * 因此这里的判定一律从严：**宁可漏报，不能误删**。
 * 留着一个死导出的代价是几十字节，删掉一个还在用的导出的代价是线上事故。
 *
 * 所有被规则排除的导出都记进 `excluded` 并附原因——判据可以被质疑，
 * 但不能是隐形的。看报告的人要能分辨「工具认为它活着」和「工具没看见它」。
 */

export type DeadExportKind =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type"
  | "enum";

export interface DeadExport {
  /** 仓库相对路径 */
  file: string;
  symbol: string;
  line: number;
  kind: DeadExportKind;
  /**
   * 文件内部仍在使用。
   *
   * 决定 A2 的改法：为真时只能去掉 `export` 关键字，为假才可以删整个声明。
   */
  usedInFile: boolean;
  /**
   * 仅被测试文件引用。
   *
   * 不算死导出（测试是有效引用），但单独标出来——「只有测试在用的生产代码」
   * 往往是真正该删的东西，只是删之前要连测试一起删，属于人的决策。
   */
  testOnly: boolean;
}

export interface ExcludedExport {
  file: string;
  symbol: string;
  line: number;
  kind: DeadExportKind;
  reason: string;
}

export interface DeadExportResult {
  dead: DeadExport[];
  /** 只被测试引用的导出，单独成列 */
  testOnly: DeadExport[];
  /** 被规则排除的导出及原因，用于让判据可被审查 */
  excluded: ExcludedExport[];
  /** 扫描到的具名导出总数，作为「减少了多少」的对账基数 */
  totalExports: number;
}

/**
 * 框架按约定读取的导出名。
 *
 * 这些名字由框架在构建期或运行期按字符串查找，静态引用分析永远看不到。
 * 白名单必然不全，因此它是「排除」而不是「判定」——漏掉一个只会少报一条。
 */
const CONVENTION_EXPORTS = new Set([
  // Next.js Pages Router
  "getServerSideProps",
  "getStaticProps",
  "getStaticPaths",
  "getInitialProps",
  "config",
  "reportWebVitals",
  // Next.js App Router
  "generateMetadata",
  "generateStaticParams",
  "generateViewport",
  "metadata",
  "viewport",
  "dynamic",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "middleware",
  // Next.js 约定的错误/布局边界
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  // Nuxt / Vite SSR
  "definePageMeta",
  "prerender",
  // Vite 环境
  "install",
]);

/** 文件路由目录：目录结构本身就是引用，静态上找不到调用方 */
const ROUTE_DIRECTORIES = [
  "pages/",
  "app/",
  "src/pages/",
  "src/app/",
  "app/routes/",
  "src/routes/",
];

const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?)\/|\.(test|spec)\.[jt]sx?$/;

export function analyzeDeadExports(input: {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  /**
   * 复用已装载的语义项目。
   *
   * 与 `planTypeOnlyRefactor` 同理：判定与后续改写必须落在同一份 AST 上，
   * 另开 Project 会让行号对不上。
   */
  semantic?: SemanticProject;
}): DeadExportResult {
  const { root, files, contents } = input;
  const semantic = input.semantic ?? openSemanticProject(root, files, contents);

  const entries = collectEntryPaths(root, files);
  const forwarded = collectForwardedExports(semantic, root);

  const dead: DeadExport[] = [];
  const testOnly: DeadExport[] = [];
  const excluded: ExcludedExport[] = [];
  let totalExports = 0;

  for (const parsed of semantic.parsed) {
    const filePath = parsed.file.path;

    // .d.ts 是写给外部消费者的类型声明，「没人引用」是常态而非问题
    if (filePath.endsWith(".d.ts")) continue;

    // Vue SFC 的导出几乎都是组件本身，由模板与路由按约定引用，
    // 抽成虚拟 TS 文件之后这些引用全部丢失，判定必然误报
    if (parsed.file.language === "vue") continue;

    const isEntry = entries.has(filePath);
    const isRoute = ROUTE_DIRECTORIES.some((dir) => filePath.startsWith(dir));

    for (const declared of collectNamedExports(parsed.source)) {
      totalExports += 1;

      // 位置与种类一并带上：被排除的导出是 AI 提方案的候选池，
      // 到那一步再回头找行号，就得重新解析一次文件
      const record = {
        file: filePath,
        symbol: declared.name,
        line: declared.line,
        kind: declared.kind,
      };

      if (isEntry) {
        excluded.push({ ...record, reason: "位于包入口文件，导出即对外 API" });
        continue;
      }
      if (isRoute) {
        excluded.push({ ...record, reason: "位于文件路由目录，由框架按约定加载" });
        continue;
      }
      if (CONVENTION_EXPORTS.has(declared.name)) {
        excluded.push({ ...record, reason: `\`${declared.name}\` 是框架约定导出` });
        continue;
      }
      if (forwarded.has(forwardKey(filePath, declared.name))) {
        excluded.push({ ...record, reason: "被其它模块 `export` 转发，需先判定转发链末端" });
        continue;
      }

      const usage = countReferences(declared.nameNode, parsed.source);
      if (usage === null) {
        excluded.push({ ...record, reason: "引用分析失败，按保守处理不判定" });
        continue;
      }
      if (usage.external > 0) continue;

      const entry: DeadExport = {
        file: filePath,
        symbol: declared.name,
        line: declared.line,
        kind: declared.kind,
        usedInFile: usage.internal > 0,
        testOnly: usage.test > 0,
      };

      if (usage.test > 0) testOnly.push(entry);
      else dead.push(entry);
    }
  }

  const bySite = (a: DeadExport, b: DeadExport): number =>
    a.file.localeCompare(b.file) || a.line - b.line;

  return {
    dead: dead.sort(bySite),
    testOnly: testOnly.sort(bySite),
    excluded,
    totalExports,
  };
}

interface DeclaredExport {
  name: string;
  nameNode: Identifier;
  kind: DeadExportKind;
  line: number;
}

/**
 * 收集一个文件里的具名导出。
 *
 * **默认导出整体不参与判定**。它没有稳定的名字可供引用分析，实际引用又大多
 * 来自路由表、`React.lazy(() => import(...))` 这类动态位置——静态判定必然误报，
 * 而误报在这个场景里等于误删。这条限制写进了 LIMITATIONS。
 */
function collectNamedExports(source: SourceFile): DeclaredExport[] {
  const results: DeclaredExport[] = [];

  const push = (nameNode: Node | undefined, kind: DeadExportKind): void => {
    const identifier = nameNode?.asKind(SyntaxKind.Identifier);
    if (!identifier) return;
    results.push({
      name: identifier.getText(),
      nameNode: identifier,
      kind,
      line: identifier.getStartLineNumber(),
    });
  };

  for (const statement of source.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isExported()) {
      push(statement.getNameNode(), "function");
    } else if (Node.isClassDeclaration(statement) && statement.isExported()) {
      push(statement.getNameNode(), "class");
    } else if (Node.isInterfaceDeclaration(statement) && statement.isExported()) {
      push(statement.getNameNode(), "interface");
    } else if (Node.isTypeAliasDeclaration(statement) && statement.isExported()) {
      push(statement.getNameNode(), "type");
    } else if (Node.isEnumDeclaration(statement) && statement.isExported()) {
      push(statement.getNameNode(), "enum");
    } else if (Node.isVariableStatement(statement) && statement.isExported()) {
      for (const declaration of statement.getDeclarations()) {
        // 解构导出（`export const { a, b } = obj`）的每个绑定都要单独判定，
        // 但删除其中一个会改变解构语义，超出 A2 的安全改法，这里直接不收
        push(declaration.getNameNode(), "variable");
      }
    }
  }

  return results;
}

interface ReferenceUsage {
  /** 同文件内的引用 */
  internal: number;
  /** 其它非测试文件的引用 */
  external: number;
  /** 测试文件里的引用 */
  test: number;
}

/**
 * 数一个导出符号的引用，区分同文件 / 外部 / 测试三类。
 *
 * 有三类节点必须从计数里剔除，否则每个导出看起来都「有人用」：
 *
 * 1. **声明处自身** —— `findReferencesAsNodes` 会把定义也返回
 * 2. **`export { foo }` 语句里的名字** —— 那是导出动作本身，不是使用
 * 3. **`import { foo }` 里的名字** —— 导入本身不构成使用，真正的使用是后面那处；
 *    不剔除的话，一个「导入了但从没用过」的符号会被判成活的
 */
function countReferences(nameNode: Identifier, owner: SourceFile): ReferenceUsage | null {
  let references: Node[];
  try {
    references = nameNode.findReferencesAsNodes();
  } catch {
    return null;
  }

  const usage: ReferenceUsage = { internal: 0, external: 0, test: 0 };

  for (const reference of references) {
    if (reference === nameNode) continue;

    // 导出/导入说明符只是在搬运名字，不是在使用它
    if (reference.getFirstAncestorByKind(SyntaxKind.ExportSpecifier)) continue;
    if (reference.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue;

    const file = reference.getSourceFile();
    if (file === owner) {
      usage.internal += 1;
      continue;
    }

    if (TEST_FILE.test(file.getFilePath())) usage.test += 1;
    else usage.external += 1;
  }

  return usage;
}

/**
 * 收集被 `export ... from` 转发的符号。
 *
 * 转发链上的中间环节看起来没有直接引用者，但它的末端可能是对外 API。
 * A1 不追踪整条链——**只要被转发就排除**，这是刻意的保守选择：
 * 追踪链路末端需要判定 barrel 文件本身是否被消费，那属于 A2 的范围。
 */
function collectForwardedExports(semantic: SemanticProject, root: string): Set<string> {
  const forwarded = new Set<string>();

  for (const parsed of semantic.parsed) {
    for (const declaration of parsed.source.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (!specifier) continue;

      const target = semantic.resolve(specifier, path.join(root, parsed.file.path));
      if (!target) continue;

      if (declaration.isNamespaceExport()) {
        // `export * from './x'` 转发了 x 的全部导出，逐个记不可行，
        // 直接把整个文件标成「有转发」，用通配键表示
        forwarded.add(forwardKey(target.path, "*"));
        continue;
      }

      for (const named of declaration.getNamedExports()) {
        forwarded.add(forwardKey(target.path, named.getName()));
      }
    }
  }

  return forwarded;
}

function forwardKey(filePath: string, symbol: string): string {
  return `${filePath}#${symbol}`;
}

/**
 * 判断哪些文件是「入口」——它们的导出是对外 API，没有仓库内引用是正常的。
 *
 * 三个来源：package.json 的入口字段、约定入口文件名、文件路由目录。
 * package.json 常指向 `dist/`，此时按同名源码文件回推一次。
 */
function collectEntryPaths(root: string, files: FileNode[]): Set<string> {
  const known = new Set(files.map((file) => file.path));
  const entries = new Set<string>();

  const add = (candidate: string): void => {
    const normalized = candidate.replace(/^\.\//, "").split(path.sep).join("/");
    if (known.has(normalized)) entries.add(normalized);
  };

  for (const name of ["index", "src/index", "src/main", "main"]) {
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs"]) add(`${name}${extension}`);
  }

  const manifest = readPackageJson(root);
  if (manifest) {
    for (const raw of collectManifestEntries(manifest)) {
      add(raw);
      // dist/foo.js → src/foo.ts：构建产物路径回推到源码
      const guessed = raw.replace(/^(\.\/)?(dist|lib|es|build)\//, "src/").replace(/\.js$/, "");
      for (const extension of [".ts", ".tsx", ".js", ".jsx"]) add(`${guessed}${extension}`);
    }
  }

  return entries;
}

function readPackageJson(root: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

/** 从 package.json 里把所有可能的入口路径抠出来，`exports` 是任意深度的嵌套对象 */
function collectManifestEntries(manifest: Record<string, unknown>): string[] {
  const found: string[] = [];

  for (const field of ["main", "module", "browser", "types", "typings"]) {
    const value = manifest[field];
    if (typeof value === "string") found.push(value);
  }

  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      found.push(value);
      return;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) walk(nested);
    }
  };
  walk(manifest.exports);
  walk(manifest.bin);

  return found;
}

// ── 清理计划 ───────────────────────────────────────────

export type RemovalAction =
  /** 去掉 `export` 关键字，声明本身保留——文件内还在用它 */
  | "unexport"
  /** 整条声明删除——文件内外都没人用 */
  | "delete-declaration";

export interface DeadExportEdit {
  file: string;
  symbol: string;
  line: number;
  kind: DeadExportKind;
  action: RemovalAction;
}

export interface BlockedRemoval {
  file: string;
  symbol: string;
  line: number;
  kind: DeadExportKind;
  reason: string;
}

export interface DeadExportPlan {
  /** 改动前的具名导出总数 */
  exportsBefore: number;
  /**
   * 预测改完之后的具名导出总数。
   *
   * **这是要被对账的那个断言。** 写盘后重新扫描仓库、重跑一次检测，
   * 实测的导出总数必须与它完全相等；差一个都说明 ts-morph 的改写
   * 和判定对不上，哪怕代码能编译也要整体回滚。
   */
  exportsAfter: number;
  edits: DeadExportEdit[];
  blocked: BlockedRemoval[];
  /** 只被测试引用的导出：不改，但值得让人看见 */
  testOnly: DeadExport[];
}

/**
 * 把检测结果变成可执行的清理计划。
 *
 * 两种改法的风险差着量级：
 *
 * - **去掉 `export` 关键字**是语义等价的——声明还在，文件内的行为一个字节都不变，
 *   只是模块外不再可见。
 * - **删除整条声明**会真的少执行一段代码。只有当这条声明的求值本身没有副作用时
 *   才允许，否则宁可跳过。
 *
 * 为什么不给「文件内也没人用」的声明也只做 unexport：那样会留下一个谁都不碰的
 * 局部声明，开了 `noUnusedLocals` 的项目立刻多出一条 TS6133 错误——
 * 第一层验证会因此判定改动引入了新错误，整批放弃。
 */
export function planDeadExportRemoval(input: {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  semantic?: SemanticProject;
}): DeadExportPlan {
  const semantic = input.semantic ?? openSemanticProject(input.root, input.files, input.contents);
  const detection = analyzeDeadExports({ ...input, semantic });

  const sourceByPath = new Map(semantic.parsed.map((item) => [item.file.path, item.source]));
  const edits: DeadExportEdit[] = [];
  const blocked: BlockedRemoval[] = [];

  // 一个文件里被移除的导出数，用于判断是否会把整个文件掏空
  const removedPerFile = new Map<string, number>();
  const exportsPerFile = new Map<string, number>();
  for (const parsed of semantic.parsed) {
    exportsPerFile.set(parsed.file.path, collectNamedExports(parsed.source).length);
  }

  for (const item of detection.dead) {
    const source = sourceByPath.get(item.file);
    if (!source) {
      blocked.push({ ...item, reason: "文件不在本次解析结果里" });
      continue;
    }

    const located = locateExportedStatement(source, item.symbol);
    if (!located) {
      blocked.push({ ...item, reason: "改写时未能重新定位到这条声明" });
      continue;
    }

    const action: RemovalAction = item.usedInFile ? "unexport" : "delete-declaration";
    const risk = removalRisk(located, action);
    if (risk) {
      blocked.push({ ...item, reason: risk });
      continue;
    }

    edits.push({
      file: item.file,
      symbol: item.symbol,
      line: item.line,
      kind: item.kind,
      action,
    });
    removedPerFile.set(item.file, (removedPerFile.get(item.file) ?? 0) + 1);
  }

  // 掏空一个文件的全部导出会让它不再是 ES module，顶层声明落进全局作用域，
  // 可能与别处重名。这类文件多半整个都该删，属于人的决策，不在自动化范围内
  const survivors: DeadExportEdit[] = [];
  for (const edit of edits) {
    const total = exportsPerFile.get(edit.file) ?? 0;
    const removed = removedPerFile.get(edit.file) ?? 0;
    const source = sourceByPath.get(edit.file);
    const stillAModule =
      removed < total ||
      (source?.getImportDeclarations().length ?? 0) > 0 ||
      (source?.getExportDeclarations().length ?? 0) > 0;

    if (stillAModule) survivors.push(edit);
    else {
      blocked.push({
        file: edit.file,
        symbol: edit.symbol,
        line: edit.line,
        kind: edit.kind,
        reason: "移除后文件将不再含任何 import/export，不再是 ES module，需人工确认",
      });
    }
  }

  return {
    exportsBefore: detection.totalExports,
    exportsAfter: detection.totalExports - survivors.length,
    edits: survivors,
    blocked,
    testOnly: detection.testOnly,
  };
}

/** 按符号名定位导出语句——不用行号，因为删除会让后续行号整体上移 */
export function locateExportedStatement(source: SourceFile, symbol: string): Node | undefined {
  for (const statement of source.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      if (!statement.isExported()) continue;
      const declaration = statement.getDeclarations().find((d) => d.getName() === symbol);
      if (declaration) return declaration;
      continue;
    }

    if (
      (Node.isFunctionDeclaration(statement) ||
        Node.isClassDeclaration(statement) ||
        Node.isInterfaceDeclaration(statement) ||
        Node.isTypeAliasDeclaration(statement) ||
        Node.isEnumDeclaration(statement)) &&
      statement.isExported() &&
      statement.getName() === symbol
    ) {
      return statement;
    }
  }

  return undefined;
}

/**
 * 按符号名定位任意顶层声明，**包括非导出的**。
 *
 * 死导出这条链路只关心导出，但连带删除的目标恰恰是私有声明——
 * 校验层和执行层都要找它们，所以定位原语统一放在这里，
 * 不在三个文件里各写一份略有出入的版本。
 */
export function locateAnyDeclaration(source: SourceFile, symbol: string): Node | undefined {
  for (const statement of source.getStatements()) {
    if (Node.isVariableStatement(statement)) {
      const declaration = statement.getDeclarations().find((d) => d.getName() === symbol);
      if (declaration) return declaration;
      continue;
    }

    if (
      (Node.isFunctionDeclaration(statement) ||
        Node.isClassDeclaration(statement) ||
        Node.isInterfaceDeclaration(statement) ||
        Node.isTypeAliasDeclaration(statement) ||
        Node.isEnumDeclaration(statement)) &&
      statement.getName() === symbol
    ) {
      return statement;
    }
  }

  return undefined;
}

/** 这条声明按这种改法动，有没有说不清的风险；返回原因即拒绝 */
function removalRisk(node: Node, action: RemovalAction): string | undefined {
  if (Node.isVariableDeclaration(node)) {
    const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    const siblings = statement?.getDeclarations().length ?? 1;

    // `export const a = 1, b = 2` 里去掉 export 会连带影响兄弟绑定
    if (action === "unexport" && siblings > 1) {
      return "同一条 export 语句里还有其它绑定，去掉 export 会连带影响它们";
    }
    if (action === "delete-declaration" && !isPureExpression(node.getInitializer())) {
      return "初始化表达式可能有副作用，删除会改变运行时行为";
    }
    return undefined;
  }

  if (Node.isClassDeclaration(node) && node.getDecorators().length > 0) {
    return "类带有装饰器，装饰器在求值时执行，删除会改变运行时行为";
  }

  return undefined;
}

/**
 * 表达式求值是否没有外部影响。
 *
 * 白名单式判断：**列举出来的才算安全，其余一律当作有副作用**。
 * 函数调用、`new`、属性访问（可能触发 getter）都不在名单里——
 * 判断错一次的代价是删掉一段仍在执行的初始化代码。
 */
export function isPureExpression(node: Node | undefined): boolean {
  if (!node) return true;

  if (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isBigIntLiteral(node) ||
    Node.isRegularExpressionLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node) ||
    Node.isNullLiteral(node) ||
    Node.isIdentifier(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  ) {
    return true;
  }

  // 类表达式的静态块与装饰器会在求值时执行
  if (Node.isClassExpression(node)) {
    return node.getDecorators().length === 0;
  }

  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node)) {
    return isPureExpression(node.getExpression());
  }
  if (Node.isTypeAssertion(node) || Node.isNonNullExpression(node)) {
    return isPureExpression(node.getExpression());
  }
  if (Node.isPrefixUnaryExpression(node)) {
    return isPureExpression(node.getOperand());
  }
  if (Node.isBinaryExpression(node)) {
    return isPureExpression(node.getLeft()) && isPureExpression(node.getRight());
  }
  if (Node.isArrayLiteralExpression(node)) {
    return node.getElements().every((element) => isPureExpression(element));
  }
  if (Node.isObjectLiteralExpression(node)) {
    return node.getProperties().every((property) => {
      if (Node.isPropertyAssignment(property)) return isPureExpression(property.getInitializer());
      // 简写属性只是读一个已有绑定；方法与访问器不会在构造时执行
      return (
        Node.isShorthandPropertyAssignment(property) ||
        Node.isMethodDeclaration(property) ||
        Node.isGetAccessorDeclaration(property) ||
        Node.isSetAccessorDeclaration(property)
      );
    });
  }

  return false;
}

/**
 * 转成报告用的 Finding。
 *
 * 每个文件合成一条，而不是每个导出一条——一个文件里有 12 个死导出时，
 * 12 条同样的告警会把报告淹掉，而它们本来就是同一次清理。
 */
export function toDeadExportFindings(result: DeadExportResult): Finding[] {
  const byFile = new Map<string, DeadExport[]>();
  for (const item of result.dead) {
    const list = byFile.get(item.file) ?? [];
    list.push(item);
    byFile.set(item.file, list);
  }

  const findings: Finding[] = [];
  for (const [file, items] of byFile) {
    findings.push({
      rule: "dead-export",
      severity: "warning",
      message: `${items.length} 个导出在仓库内没有任何引用`,
      files: [file],
      evidence: items.map(
        (item) =>
          `${file}:${item.line} ${item.symbol}` +
          (item.usedInFile ? "（文件内仍在使用，只能去掉 export）" : ""),
      ),
    });
  }

  return findings.sort((a, b) => a.files[0].localeCompare(b.files[0]));
}
