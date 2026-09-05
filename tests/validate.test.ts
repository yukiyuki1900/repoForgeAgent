import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { collectProposalFacts, type ProposalFacts } from "../src/analyze/facts.js";
import type { FileNode } from "../src/core/analysis.js";
import type { Proposal } from "../src/refactor/propose.js";
import { scanFiles } from "../src/scan/scanner.js";
import { validateProposals } from "../src/refactor/validate.js";

/**
 * 幻觉防线。
 *
 * 每一条拒绝规则都配一个对应的幻觉样本——**规则写了但没有样本，
 * 等于没人知道它到底会不会触发**。
 *
 * 这一层的立场是不采信模型说的任何一个事实：符号存不存在、引用有几处、
 * 文件有没有人 import，全部重新查一遍。模型贡献的只有「该不该动、怎么动」。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let ctx: {
  facts: ProposalFacts;
  root: string;
  files: FileNode[];
  contents: Map<string, string>;
};

before(async () => {
  const root = path.join(ROOT, "fixtures", "18-dead-exports");
  const { files, contents } = await scanFiles(root);
  ctx = { facts: collectProposalFacts({ root, files, contents }), root, files, contents };
});

const run = (proposals: Proposal[]) => validateProposals({ ...ctx, proposals });

const temporary: string[] = [];

after(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * 就地搭一个最小仓库。
 *
 * C3 是纯静态校验，不写盘也不需要 git，所以不必像 `prune.test.ts` 那样
 * 复制 fixture 再初始化仓库。用临时目录还有一层好处：**只为测试存在的
 * 边界样本不必塞进 eval fixture**——那些 fixture 的每个导出都挂着
 * `expected.json` 里的精确断言，为一条校验规则去改它们得不偿失。
 */
async function repo(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rfa-validate-"));
  temporary.push(dir);

  for (const [name, source] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }

  const { files: scanned, contents } = await scanFiles(dir);
  return {
    root: dir,
    files: scanned,
    contents,
    facts: collectProposalFacts({ root: dir, files: scanned, contents }),
  };
}

/** src/dead.ts 两个导出全死、无人 import、顶层无副作用——合法的 delete-file 目标 */
const deleteDeadFile: Proposal = {
  kind: "delete-file",
  targetFile: "src/dead.ts",
  targetSymbol: "unusedHelper",
  rationale: "整个文件的导出都没人用，也没有任何文件 import 它",
  operations: [{ op: "delete-file", file: "src/dead.ts", symbol: "" }],
  prediction: { exportsRemoved: 2, filesRemoved: 1 },
  risk: "low",
};

describe("方案的静态校验", () => {
  it("合法方案通过", () => {
    const result = run([structuredClone(deleteDeadFile)]);

    assert.equal(result.accepted.length, 1, JSON.stringify(result.rejected));
    assert.equal(result.rejected.length, 0);
  });

  it("拦下不存在的符号——模型编符号名是常态", () => {
    const result = run([
      { ...structuredClone(deleteDeadFile), targetSymbol: "totallyMadeUpSymbol" },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /不在候选清单/);
  });

  it("拦下模型自己「发现」的死导出——那些没经过引用分析", () => {
    // formatName 确实存在，而且被 index.ts 引用着，但它不在候选清单里
    const result = run([
      {
        ...structuredClone(deleteDeadFile),
        kind: "unexport-symbol",
        targetFile: "src/used.ts",
        targetSymbol: "formatName",
        operations: [{ op: "delete-declaration", file: "src/used.ts", symbol: "formatName" }],
        prediction: { exportsRemoved: 1, filesRemoved: 0 },
      },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /不在候选清单/);
  });

  it("拦下 operation 里编造的符号名——目标选对了不代表指令写对了", () => {
    // 这是比「整个目标都是编的」更常见的幻觉：模型确实从候选清单里
    // 挑了一条，但落到指令时把符号名拼错了。
    // 第 1 关（候选清单）看的是 targetSymbol，拦不住这种
    const result = run([
      {
        ...structuredClone(deleteDeadFile),
        kind: "unexport-symbol",
        operations: [{ op: "unexport", file: "src/dead.ts", symbol: "unusedHelpr" }],
        prediction: { exportsRemoved: 1, filesRemoved: 0 },
      },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /找不到符号 unusedHelpr/);
  });

  it("拦下 operation 里编造的文件路径", () => {
    const result = run([
      {
        ...structuredClone(deleteDeadFile),
        kind: "unexport-symbol",
        operations: [{ op: "unexport", file: "src/nowhere.ts", symbol: "unusedHelper" }],
        prediction: { exportsRemoved: 1, filesRemoved: 0 },
      },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /src\/nowhere\.ts 不在本次扫描结果里/);
  });

  it("拦下预测与静态推算不符的方案", () => {
    // 方案本身合法，只是模型说会少 5 个导出，实际只会少 2 个。
    // 预测不是用来告诉我们答案的，是用来检测模型有没有真正理解自己的方案
    const result = run([
      {
        ...structuredClone(deleteDeadFile),
        prediction: { exportsRemoved: 5, filesRemoved: 1 },
      },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /静态推算应为 2 个/);
  });

  it("拦下不满足前提的 delete-file", () => {
    // helper.ts 被 helper.test.ts import，入边不为 0
    const result = run([
      {
        ...structuredClone(deleteDeadFile),
        targetFile: "src/helper.ts",
        targetSymbol: "parseFlag",
        operations: [{ op: "delete-file", file: "src/helper.ts", symbol: "" }],
        prediction: { exportsRemoved: 1, filesRemoved: 1 },
      },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /import/);
  });

  it("拦下 operations 与 kind 对不上的方案", () => {
    const result = run([
      {
        ...structuredClone(deleteDeadFile),
        operations: [
          { op: "delete-file", file: "src/dead.ts", symbol: "" },
          { op: "unexport", file: "src/dead.ts", symbol: "UnusedOptions" },
        ],
      },
    ]);

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /只能包含一条/);
  });

  it("拦下两条方案抢同一个符号", () => {
    const single: Proposal = {
      kind: "unexport-symbol",
      targetFile: "src/dead.ts",
      targetSymbol: "unusedHelper",
      rationale: "没人用",
      operations: [{ op: "unexport", file: "src/dead.ts", symbol: "unusedHelper" }],
      prediction: { exportsRemoved: 1, filesRemoved: 0 },
      risk: "low",
    };

    const result = run([structuredClone(single), structuredClone(single)]);

    assert.equal(result.accepted.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /已被前一条方案占用/);
  });

  it("强制改写连带删除的风险等级，并留痕", async () => {
    const root = path.join(ROOT, "fixtures", "19-dead-export-removal");
    const { files, contents } = await scanFiles(root);
    const facts = collectProposalFacts({ root, files, contents });

    const proposal: Proposal = {
      kind: "delete-with-dependencies",
      targetFile: "src/effects.ts",
      targetSymbol: "registered",
      rationale: "register 只往一个从没被读过的计数器里写",
      operations: [
        { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
        { op: "delete-declaration", file: "src/effects.ts", symbol: "register" },
      ],
      prediction: { exportsRemoved: 1, filesRemoved: 0 },
      // 模型说 low，但「这个副作用不重要」不是编译器能判定的事
      risk: "low",
    };

    const result = validateProposals({ root, files, contents, facts, proposals: [proposal] });

    assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
    assert.equal(result.accepted[0].risk, "high");
    assert.equal(result.adjusted.length, 1);
    assert.equal(result.adjusted[0].field, "risk");
    assert.equal(result.adjusted[0].from, "low");
  });

  it("拦下连带删除一个还被别处使用的符号", async () => {
    const root = path.join(ROOT, "fixtures", "19-dead-export-removal");
    const { files, contents } = await scanFiles(root);
    const facts = collectProposalFacts({ root, files, contents });

    const result = validateProposals({
      root,
      files,
      contents,
      facts,
      proposals: [
        {
          kind: "delete-with-dependencies",
          targetFile: "src/effects.ts",
          targetSymbol: "registered",
          rationale: "顺手把 counter 也删了",
          operations: [
            { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
            // counter 被 register() 读写两处，不是只被目标符号使用
            { op: "delete-declaration", file: "src/effects.ts", symbol: "counter" },
          ],
          prediction: { exportsRemoved: 1, filesRemoved: 0 },
          risk: "high",
        },
      ],
    });

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /不是只被目标符号使用/);
  });

  it("拦下唯一引用不在目标声明内部的连带删除", async () => {
    // 「引用数恰为 1」单独一条是不够的：一个在别处被用了一次的符号
    // 同样能凑出 1。AUDIT_TAG 就是这种——它确实只被引用一次，
    // 但那一次在 auditLabel 里，跟要删的 registered 毫无关系
    const context = await repo({
      "src/effects.ts": [
        "const AUDIT_TAG = 'audit';",
        "",
        "function register(): number {",
        "  return 1;",
        "}",
        "",
        "export const registered = register();",
        "",
        "export function auditLabel(): string {",
        "  return AUDIT_TAG;",
        "}",
        "",
      ].join("\n"),
      "src/index.ts": [
        "import { auditLabel } from './effects';",
        "",
        "export function main(): string {",
        "  return auditLabel();",
        "}",
        "",
      ].join("\n"),
    });

    const base = {
      kind: "delete-with-dependencies" as const,
      targetFile: "src/effects.ts",
      targetSymbol: "registered",
      rationale: "顺手清掉一个看起来没人用的私有常量",
      prediction: { exportsRemoved: 1, filesRemoved: 0 },
      risk: "high" as const,
    };

    const bad = validateProposals({
      ...context,
      proposals: [
        {
          ...base,
          operations: [
            { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
            { op: "delete-declaration", file: "src/effects.ts", symbol: "AUDIT_TAG" },
          ],
        },
      ],
    });

    assert.equal(bad.accepted.length, 0);
    assert.match(bad.rejected[0].reason, /不在 registered 的声明内部/);

    // 同一个仓库里换成真正的私有依赖 register 就该放行——
    // 否则上面那条断言可能只是因为整条链路都在拒绝
    const good = validateProposals({
      ...context,
      proposals: [
        {
          ...base,
          operations: [
            { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
            { op: "delete-declaration", file: "src/effects.ts", symbol: "register" },
          ],
        },
      ],
    });

    assert.equal(good.rejected.length, 0, JSON.stringify(good.rejected));
  });

  it("拦下把导出符号当私有依赖连带删除", async () => {
    const context = await repo({
      "src/effects.ts": [
        "export function register(): number {",
        "  return 1;",
        "}",
        "",
        "export const registered = register();",
        "",
      ].join("\n"),
      "src/index.ts": "export const main = 1;\n",
    });

    const result = validateProposals({
      ...context,
      proposals: [
        {
          kind: "delete-with-dependencies",
          targetFile: "src/effects.ts",
          targetSymbol: "registered",
          rationale: "register 也一起删",
          operations: [
            { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
            // register 是导出的，删掉它就不只是内部重排了
            { op: "delete-declaration", file: "src/effects.ts", symbol: "register" },
          ],
          prediction: { exportsRemoved: 2, filesRemoved: 0 },
          risk: "high",
        },
      ],
    });

    assert.equal(result.accepted.length, 0);
    assert.match(result.rejected[0].reason, /是导出符号/);
  });
});
