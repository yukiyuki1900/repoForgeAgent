import path from "node:path";
import { Node, SyntaxKind, ts, type ImportDeclaration, type SourceFile } from "ts-morph";
import { analyzeCycles } from "../analyze/analyzers.js";
import {
  erasedAtRuntime,
  openSemanticProject,
  type ParsedFile,
  type SemanticProject,
} from "../scan/graph.js";
import type { FileNode, Finding, RelationEdge } from "../core/analysis.js";

/**
 * 用 `import type` 打破循环依赖。
 *
 * 为什么选这个场景：循环依赖的一般性修复（提取共享模块、依赖倒置）本质是
 * 架构决策，要决定「把代码搬到哪里」，只能靠模型生成代码，既有幻觉风险，
 * 也无法用编译器证明行为不变。
 *
 * 而「仅用于类型的导入改成 import type」是**语义等价的机械变换**：
 * 判定靠 TypeScript 的引用分析，改造是 ts-morph 的一个 API，
 * 效果可以用「重跑 Tarjan，环是否消失」直接验证。
 *
 * 判定一律从严：只要有一处引用落在值位置，就不改。宁可漏改，不能误改。
 */
export interface ImportCandidate {
  /** 发起 import 的文件（仓库相对路径） */
  file: string;
  line: number;
  /** 被导入的文件 */
  target: string;
  specifier: string;
  names: string[];
}

export interface BlockedImport extends ImportCandidate {
  /** 为什么不能改 */
  reason: string;
}

export interface CyclePlan {
  files: string[];
  /** 真实回路，来自 analyzeCycles 的 evidence */
  loop?: string;
  candidates: ImportCandidate[];
  blocked: BlockedImport[];
  /** 把候选全部改掉之后，这个环是否消失 */
  breakable: boolean;
}

export interface RefactorPlan {
  cyclesBefore: number;
  cyclesAfter: number;
  cycles: CyclePlan[];
  filesAffected: number;
  /** 全局性的阻断原因，例如开启了 emitDecoratorMetadata */
  blockers: string[];
}

export function planTypeOnlyRefactor(input: {
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
  edges: RelationEdge[];
  cycles: Finding[];
  /**
   * 复用已装载的语义项目。
   *
   * `--apply` 需要在**同一份 AST** 上先判定、再改写：如果这里另开一个 Project，
   * 计划里的行号来自 A、改写落在 B，中间任何一处解析差异都会改错位置。
   */
  semantic?: SemanticProject;
}): RefactorPlan {
  const { root, files, contents, edges, cycles } = input;

  const semantic = input.semantic ?? openSemanticProject(root, files, contents);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const parsedByPath = new Map(semantic.parsed.map((item) => [item.file.path, item]));

  // emitDecoratorMetadata 只在真的用了装饰器的地方才有影响。
  // 很多项目从模板继承了这个选项却从不使用装饰器（Vue / React 生态尤其常见），
  // 一刀切否决会让整个改造能力失效——实测一个 Vue 项目因此 0 条可拆边。
  const metadataRisk =
    semantic.compilerOptions.emitDecoratorMetadata === true && usesDecorators(semantic.parsed);
  const blockers = metadataRisk
    ? ["项目开启了 emitDecoratorMetadata 且确实使用了装饰器，涉及装饰器的文件不做改造"]
    : [];

  // verbatimModuleSyntax 下内联的 `import { type A }` 会保留成 `import {} from`，
  // 依然是一条运行时边，判定标准要跟着变
  const verbatim = semantic.compilerOptions.verbatimModuleSyntax === true;

  const plans: CyclePlan[] = [];
  /** 所有可改的 import 声明，用于全局模拟 */
  const removable = new Set<string>();

  for (const cycle of cycles) {
    const members = new Set(cycle.files);
    const candidates: ImportCandidate[] = [];
    const blocked: BlockedImport[] = [];

    for (const filePath of cycle.files) {
      const parsed = parsedByPath.get(filePath);
      if (!parsed) continue;

      for (const decl of parsed.source.getImportDeclarations()) {
        // 已经被擦除的导入不构成运行时依赖，也就不在这个环上，列出来只会误导
        if (erasedAtRuntime(decl, verbatim)) continue;

        const target = resolveTarget(decl, parsed, semantic, root);
        // 只关心环内部的边
        if (!target || !members.has(target.path)) continue;

        const entry: ImportCandidate = {
          file: filePath,
          line: decl.getStartLineNumber(),
          target: target.path,
          specifier: decl.getModuleSpecifierValue(),
          names: importedNames(decl),
        };

        const verdict = judge(decl, parsed, metadataRisk);
        if (verdict.typeOnly) {
          candidates.push(entry);
          removable.add(edgeKey(filePath, target.path, decl.getStartLineNumber()));
        } else {
          blocked.push({ ...entry, reason: verdict.reason });
        }
      }
    }

    plans.push({
      files: cycle.files,
      loop: cycle.evidence?.[0],
      candidates,
      blocked,
      // 单独把这个环的候选去掉后是否还成环
      breakable:
        candidates.length > 0 &&
        !stillCyclic(
          cycle.files,
          edges,
          byPath,
          new Set(candidates.map((item) => edgeKey(item.file, item.target, item.line))),
        ),
    });
  }

  const remaining = analyzeCycles(files, filterEdges(edges, byPath, removable));
  const affected = new Set(plans.flatMap((plan) => plan.candidates.map((item) => item.file)));

  return {
    cyclesBefore: cycles.length,
    cyclesAfter: remaining.length,
    cycles: plans,
    filesAffected: affected.size,
    blockers,
  };
}

/** 边的身份：同一对文件之间可能有多条 import，用行号区分 */
function edgeKey(from: string, to: string, line: number): string {
  return `${from}→${to}@${line}`;
}

function filterEdges(
  edges: RelationEdge[],
  byPath: Map<string, FileNode>,
  removable: Set<string>,
): RelationEdge[] {
  const pathById = new Map([...byPath.values()].map((file) => [file.id, file.path]));

  return edges.filter((edge) => {
    if (edge.kind !== "import" || !edge.location) return true;
    const from = pathById.get(edge.from);
    const to = pathById.get(edge.to);
    if (!from || !to) return true;
    return !removable.has(edgeKey(from, to, edge.location.line));
  });
}

/** 只看某个环内部：去掉候选边之后，这些文件是否还构成环 */
function stillCyclic(
  members: string[],
  edges: RelationEdge[],
  byPath: Map<string, FileNode>,
  removable: Set<string>,
): boolean {
  const memberSet = new Set(members);
  const subset = [...byPath.values()].filter((file) => memberSet.has(file.path));
  const remaining = filterEdges(edges, byPath, removable);
  return analyzeCycles(subset, remaining).length > 0;
}

function resolveTarget(
  decl: ImportDeclaration,
  parsed: ParsedFile,
  semantic: ReturnType<typeof openSemanticProject>,
  root: string,
): FileNode | undefined {
  const from =
    parsed.file.language === "vue"
      ? path.join(root, `${parsed.file.path}.ts`)
      : path.join(root, parsed.file.path);
  return semantic.resolve(decl.getModuleSpecifierValue(), from);
}

function importedNames(decl: ImportDeclaration): string[] {
  const names: string[] = [];
  const defaultImport = decl.getDefaultImport();
  if (defaultImport) names.push(defaultImport.getText());

  const namespaceImport = decl.getNamespaceImport();
  if (namespaceImport) names.push(`* as ${namespaceImport.getText()}`);

  for (const named of decl.getNamedImports()) names.push(named.getName());
  return names;
}

interface Verdict {
  typeOnly: boolean;
  reason: string;
}

function judge(decl: ImportDeclaration, parsed: ParsedFile, metadataRisk: boolean): Verdict {
  // 只有这个文件自己用了装饰器才有元数据风险，与项目其它文件无关
  if (metadataRisk && fileUsesDecorators(parsed.source)) {
    return {
      typeOnly: false,
      reason: "该文件使用了装饰器，emitDecoratorMetadata 下类型会进入运行时元数据",
    };
  }
  if (decl.isTypeOnly()) {
    return { typeOnly: false, reason: "已经是 import type" };
  }
  if (decl.getNamespaceImport()) {
    return { typeOnly: false, reason: "命名空间导入，无法逐符号判定" };
  }
  // `import type { type A }` 是非法写法，改之前得先把内联修饰符清掉，不在本次改造范围内
  if (decl.getNamedImports().some((specifier) => specifier.isTypeOnly())) {
    return { typeOnly: false, reason: "混用了内联 type 修饰符，需先统一写法" };
  }

  const targets: Array<{ name: string; node: Node }> = [];
  const defaultImport = decl.getDefaultImport();
  if (defaultImport) targets.push({ name: defaultImport.getText(), node: defaultImport });
  for (const named of decl.getNamedImports()) {
    targets.push({ name: named.getName(), node: named.getNameNode() });
  }

  if (targets.length === 0) {
    return { typeOnly: false, reason: "副作用导入，没有可判定的符号" };
  }

  for (const target of targets) {
    const valueUse = firstValueUsage(target.node);
    if (valueUse) {
      return { typeOnly: false, reason: `${target.name} 在 ${valueUse} 被作为值使用` };
    }
  }

  // Vue SFC 的 defineProps<T>() 泛型在编译期展开，外部类型的支持依赖 Vue 版本，
  // 改动需要额外验证，这里如实标注而不是当作可安全修改
  if (parsed.file.language === "vue" && /defineProps\s*</.test(parsed.source.getFullText())) {
    return { typeOnly: false, reason: "Vue SFC 使用了 defineProps 泛型，需人工确认" };
  }

  return { typeOnly: true, reason: "全部引用均在类型位置" };
}

/**
 * 返回第一处值位置引用的「文件:行号」，没有则返回 undefined。
 *
 * 只统计**发起 import 的那个文件内部**的引用。
 * findReferencesAsNodes 会把符号的定义处也一并返回，而定义通常是
 * `export function foo` 这样的语句节点——按值位置处理会把本可安全改造的
 * 导入judge 成不可拆。同理，该符号在其它文件里怎么用，与本条 import 无关。
 */
function firstValueUsage(nameNode: Node): string | undefined {
  const identifier = nameNode.asKind(SyntaxKind.Identifier);
  if (!identifier) return "无法解析的标识符";

  const owner = identifier.getSourceFile();

  let references: Node[];
  try {
    references = identifier.findReferencesAsNodes();
  } catch {
    // 引用分析失败时按最保守处理
    return "引用分析失败";
  }

  for (const reference of references) {
    if (reference.getSourceFile() !== owner) continue;
    // import 声明里的那个名字本身不算使用
    if (reference.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)) continue;
    if (isTypePosition(reference)) continue;

    return `${reference.getSourceFile().getBaseName()}:${reference.getStartLineNumber()}`;
  }

  return undefined;
}

/**
 * 引用是否落在类型位置。
 *
 * 向上遍历祖先，先遇到类型节点即判为类型引用；先遇到表达式或语句则判为值引用。
 * class 的 extends 是值位置（运行时要真的继承），interface 的 extends 才是类型位置。
 */
function isTypePosition(node: Node): boolean {
  let current: Node | undefined = node.getParent();

  while (current) {
    if (ts.isTypeNode(current.compilerNode)) return true;
    if (Node.isTypeAliasDeclaration(current) || Node.isInterfaceDeclaration(current)) return true;
    if (Node.isTypeParameterDeclaration(current)) return true;

    if (Node.isHeritageClause(current)) {
      return Node.isInterfaceDeclaration(current.getParent());
    }
    if (Node.isExpression(current) || Node.isStatement(current)) return false;

    current = current.getParent();
  }

  return false;
}

/**
 * 项目里是否真的出现过装饰器。
 *
 * emitDecoratorMetadata 会把类型写进运行时元数据，此时 import type 会让
 * 装饰器拿不到类型——编译能过、运行时才炸。但这个风险只存在于真正使用
 * 装饰器的文件；仅仅在 tsconfig 里开了选项而从不使用，是完全安全的。
 */
function usesDecorators(parsed: ParsedFile[]): boolean {
  return parsed.some((item) => fileUsesDecorators(item.source));
}

function fileUsesDecorators(source: SourceFile): boolean {
  return source.getDescendantsOfKind(SyntaxKind.Decorator).length > 0;
}

/** 供 CLI 直接打印的文本报告 */
export function formatPlan(plan: RefactorPlan, options: { dryRun?: boolean } = {}): string {
  const dryRun = options.dryRun ?? true;
  const lines: string[] = [];

  if (plan.blockers.length > 0) {
    lines.push(`⚠ 无法自动修复：${plan.blockers.join("；")}`, "");
  }

  plan.cycles.forEach((cycle, index) => {
    lines.push(`环 #${index + 1}  ${cycle.loop ?? cycle.files.join(" → ")}`);

    for (const item of cycle.candidates) {
      lines.push(
        `  ✓ 可拆  ${item.file}:${item.line}`,
        `          import { ${item.names.join(", ")} } from "${item.specifier}"`,
        `          全部引用均在类型位置`,
      );
    }
    for (const item of cycle.blocked) {
      lines.push(
        `  ✗ 不可拆 ${item.file}:${item.line}`,
        `          import { ${item.names.join(", ")} } from "${item.specifier}"`,
        `          ${item.reason}`,
      );
    }

    if (cycle.candidates.length === 0) {
      lines.push("  → 无可拆边，需要结构性重构");
    } else {
      lines.push(
        cycle.breakable
          ? `  → 改 ${cycle.candidates.length} 条边即可打破此环`
          : `  → 改 ${cycle.candidates.length} 条边仍无法打破此环`,
      );
    }
    lines.push("");
  });

  lines.push(
    "─".repeat(60),
    `模拟结果：${plan.cyclesBefore} 个环 → ${plan.cyclesAfter} 个环`,
    `待改动：${plan.filesAffected} 个文件、${plan.cycles.reduce((sum, c) => sum + c.candidates.length, 0)} 条 import`,
  );
  if (dryRun) lines.push("未写入任何文件");

  return lines.join("\n");
}
