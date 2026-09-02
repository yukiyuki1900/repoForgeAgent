#!/usr/bin/env node
/**
 * Fixture 回归评估。
 *
 * 设计原则：不看主观描述，只校验分析器在固定输入上产出的事实
 * （依赖环、组件清单、关系边），因此每一条能力都是可回归、可量化的。
 *
 * 每个 fixture 用 expected.json 声明自己的期望与状态：
 * - expected-pass  ：当前必须通过，跑挂了就是回归
 * - known-failure  ：当前已知做不到，why 字段写明原因；
 *                    能力补齐后这里会变成 FIXED，提示更新状态
 *
 * 直接调用分析函数而不走 LangGraph 工作流，
 * 避免产生 .reposurgeon 目录等副作用。
 */
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeCycles, calculateMetrics } from "../src/analyzers.js";
import { planTypeOnlyRefactor } from "../src/refactor.js";
import { analyzeArchitecture } from "../src/architecture.js";
import {
  analyzeDeadExports,
  planDeadExportRemoval,
  toDeadExportFindings,
} from "../src/deadexports.js";
import { extractGraph } from "../src/graph.js";
import { buildNarrationContext, estimateContextTokens } from "../src/narrate.js";
import { scanFiles } from "../src/scanner.js";
import { detectStack } from "../src/stack.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures");

type FixtureStatus = "expected-pass" | "known-failure";
type Outcome = "PASS" | "KNOWN-FAIL" | "REGRESSION" | "FIXED" | "SKIPPED";

const requireFrom = createRequire(import.meta.url);

/** 依赖装没装是环境问题，不该和能力回归混为一谈 */
function isInstalled(packageName: string): boolean {
  try {
    requireFrom.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

interface Expectation {
  title: string;
  status: FixtureStatus;
  why: string;
  /** 该用例依赖的可选包，缺失时跳过而不是判为回归 */
  requires?: string[];
  expect: {
    cycles?: string[][];
    components?: string[];
    /** 环的**总数**。用于断言「不该有环」——只列 cycles 的话，空数组等于零条断言 */
    cycleCount?: number;
    edges?: Array<{ from: string; to: string; kind: string }>;
    metrics?: { score?: number; dimensionCount?: number };
    refactor?: {
      candidates?: Array<{ file: string; target: string }>;
      blocked?: Array<{ file: string; reasonContains: string }>;
      cyclesAfter?: number;
    };
    deadExports?: {
      /** 必须检出的死导出，`usedInFile` 决定 A2 用哪种改法 */
      dead?: Array<{ file: string; symbol: string; usedInFile?: boolean }>;
      /** 必须进 testOnly 列表的符号名 */
      testOnly?: string[];
      /**
       * **绝不能**出现在死导出列表里的符号。
       *
       * 这是本用例最重要的一组断言：这个检测的风险全在误报，
       * 「少报一个」只是没清干净，「多报一个」会让人删掉还在用的代码。
       */
      notDead?: string[];
      /** 死导出总数，精确匹配——只写 dead 列表的话，多报不会被发现 */
      deadCount?: number;
      /** 清理计划：检测之后「敢不敢动、怎么动」 */
      removal?: {
        exportsBefore?: number;
        /** 写盘后要被对账的那个预测值 */
        exportsAfter?: number;
        edits?: Array<{ file: string; symbol: string; action: string }>;
        blocked?: Array<{ symbol: string; reasonContains: string }>;
      };
    };
    architecture?: {
      sourceRoot?: string;
      modules?: string[];
      minMermaidLines?: number;
    };
    narration?: {
      maxEstimatedTokens?: number;
      modules?: string[];
      cycleCuts?: Array<{ from: string; to: string; references?: number }>;
    };
  };
}

interface Check {
  label: string;
  ok: boolean;
}

interface FixtureResult {
  name: string;
  expectation: Expectation;
  checks: Check[];
  outcome: Outcome;
  missing?: string[];
  stats: { files: number; symbols: number; edges: number; cycles: number };
}

async function evaluateFixture(dir: string): Promise<FixtureResult> {
  const expectation: Expectation = JSON.parse(
    await readFile(path.join(dir, "expected.json"), "utf8"),
  );

  const missing = (expectation.requires ?? []).filter((name) => !isInstalled(name));
  if (missing.length > 0) {
    return {
      name: path.basename(dir),
      expectation,
      checks: [],
      outcome: "SKIPPED",
      missing,
      stats: { files: 0, symbols: 0, edges: 0, cycles: 0 },
    };
  }

  const { files, contents } = await scanFiles(dir);
  const { symbols, edges } = extractGraph(dir, files, contents);
  const cycles = analyzeCycles(files, edges);
  const pathById = new Map(files.map((file) => [file.id, file.path]));

  const checks: Check[] = [];

  if (expectation.expect.cycleCount !== undefined) {
    checks.push({
      label: `环数 ${cycles.length} = ${expectation.expect.cycleCount}`,
      ok: cycles.length === expectation.expect.cycleCount,
    });
  }

  for (const expected of expectation.expect.cycles ?? []) {
    const fingerprint = fingerprintOf(expected);
    checks.push({
      label: `环 [${expected.join(" ↔ ")}]`,
      ok: cycles.some(
        (finding) =>
          finding.rule === "import-cycle" && fingerprintOf(finding.files) === fingerprint,
      ),
    });
  }

  for (const name of expectation.expect.components ?? []) {
    checks.push({
      label: `组件 ${name}`,
      ok: symbols.some((symbol) => symbol.kind === "component" && symbol.name === name),
    });
  }

  for (const expected of expectation.expect.edges ?? []) {
    checks.push({
      label: `${expected.kind} 边 ${expected.from} → ${expected.to}`,
      ok: edges.some(
        (edge) =>
          edge.kind === expected.kind &&
          pathById.get(edge.from) === expected.from &&
          pathById.get(edge.to) === expected.to,
      ),
    });
  }

  if (expectation.expect.metrics) {
    const expected = expectation.expect.metrics;
    const metrics = calculateMetrics(files, edges);

    if (expected.score !== undefined) {
      checks.push({
        label: `维护性评分 ${metrics.score} = ${expected.score}`,
        ok: metrics.score === expected.score,
      });
    }
    if (expected.dimensionCount !== undefined) {
      const count = Object.keys(metrics.dimensions).length;
      checks.push({
        label: `评分维度数 ${count} = ${expected.dimensionCount}`,
        ok: count === expected.dimensionCount,
      });
    }
  }

  if (expectation.expect.refactor) {
    const expected = expectation.expect.refactor;
    const plan = planTypeOnlyRefactor({ root: dir, files, contents, edges, cycles });
    const candidates = plan.cycles.flatMap((cycle) => cycle.candidates);
    const blocked = plan.cycles.flatMap((cycle) => cycle.blocked);

    // 候选数量必须精确匹配：多报一条就是潜在的误改
    if (expected.candidates) {
      checks.push({
        label: `可拆边数量 ${candidates.length} = ${expected.candidates.length}`,
        ok: candidates.length === expected.candidates.length,
      });
      for (const item of expected.candidates) {
        checks.push({
          label: `可拆 ${item.file} → ${item.target}`,
          ok: candidates.some((c) => c.file === item.file && c.target === item.target),
        });
      }
    }

    for (const item of expected.blocked ?? []) {
      checks.push({
        label: `不可拆 ${item.file}（${item.reasonContains}）`,
        ok: blocked.some((b) => b.file === item.file && b.reason.includes(item.reasonContains)),
      });
    }

    if (expected.cyclesAfter !== undefined) {
      checks.push({
        label: `改造后剩余环 ${plan.cyclesAfter} = ${expected.cyclesAfter}`,
        ok: plan.cyclesAfter === expected.cyclesAfter,
      });
    }
  }

  if (expectation.expect.deadExports) {
    const expected = expectation.expect.deadExports;
    const result = analyzeDeadExports({ root: dir, files, contents });

    if (expected.deadCount !== undefined) {
      checks.push({
        label: `死导出数量 ${result.dead.length} = ${expected.deadCount}`,
        ok: result.dead.length === expected.deadCount,
      });
    }

    for (const item of expected.dead ?? []) {
      const hit = result.dead.find((d) => d.file === item.file && d.symbol === item.symbol);
      checks.push({ label: `死导出 ${item.file}#${item.symbol}`, ok: Boolean(hit) });

      if (hit && item.usedInFile !== undefined) {
        checks.push({
          label: `${item.symbol} 文件内使用 ${hit.usedInFile} = ${item.usedInFile}`,
          ok: hit.usedInFile === item.usedInFile,
        });
      }
    }

    for (const symbol of expected.testOnly ?? []) {
      checks.push({
        label: `仅测试引用 ${symbol}`,
        ok: result.testOnly.some((d) => d.symbol === symbol),
      });
    }

    // 误报断言：这些符号出现在死导出里就是能删掉活代码的 bug
    for (const symbol of expected.notDead ?? []) {
      checks.push({
        label: `未误报 ${symbol}`,
        ok: !result.dead.some((d) => d.symbol === symbol),
      });
    }

    if (expected.removal) {
      const wanted = expected.removal;
      const plan = planDeadExportRemoval({ root: dir, files, contents });

      if (wanted.exportsBefore !== undefined) {
        checks.push({
          label: `导出总数 ${plan.exportsBefore} = ${wanted.exportsBefore}`,
          ok: plan.exportsBefore === wanted.exportsBefore,
        });
      }
      if (wanted.exportsAfter !== undefined) {
        checks.push({
          label: `预测改后导出数 ${plan.exportsAfter} = ${wanted.exportsAfter}`,
          ok: plan.exportsAfter === wanted.exportsAfter,
        });
      }

      // 改动数量必须精确匹配：多一条就是一次没人要的改写
      if (wanted.edits) {
        checks.push({
          label: `清理条数 ${plan.edits.length} = ${wanted.edits.length}`,
          ok: plan.edits.length === wanted.edits.length,
        });
        for (const item of wanted.edits) {
          checks.push({
            label: `${item.symbol} 改法为 ${item.action}`,
            ok: plan.edits.some(
              (e) => e.file === item.file && e.symbol === item.symbol && e.action === item.action,
            ),
          });
        }
      }

      for (const item of wanted.blocked ?? []) {
        checks.push({
          label: `拒绝清理 ${item.symbol}（${item.reasonContains}）`,
          ok: plan.blocked.some(
            (b) => b.symbol === item.symbol && b.reason.includes(item.reasonContains),
          ),
        });
      }
    }
  }

  if (expectation.expect.architecture) {
    const expected = expectation.expect.architecture;
    const architecture = analyzeArchitecture(files, symbols, edges);

    if (expected.sourceRoot !== undefined) {
      checks.push({
        label: `源码根目录 "${architecture.sourceRoot}" = "${expected.sourceRoot}"`,
        ok: architecture.sourceRoot === expected.sourceRoot,
      });
    }
    for (const module of expected.modules ?? []) {
      checks.push({
        label: `模块聚合包含 ${module}`,
        ok: architecture.directories.some((item) => item.path === module),
      });
    }
    if (expected.minMermaidLines !== undefined) {
      const lines = architecture.mermaid.split("\n").length;
      checks.push({
        label: `Mermaid ${lines} 行 ≥ ${expected.minMermaidLines}`,
        ok: lines >= expected.minMermaidLines,
      });
    }
  }

  if (expectation.expect.narration) {
    checks.push(
      ...(await checkNarration(dir, expectation.expect.narration, {
        files,
        contents,
        symbols,
        edges,
        cycles,
      })),
    );
  }

  const passed = checks.length > 0 && checks.every((check) => check.ok);

  return {
    name: path.basename(dir),
    expectation,
    checks,
    outcome: resolveOutcome(expectation.status, passed),
    stats: {
      files: files.length,
      symbols: symbols.length,
      edges: edges.length,
      cycles: cycles.length,
    },
  };
}

function fingerprintOf(paths: string[]): string {
  return [...paths].sort().join(" | ");
}

/**
 * 校验送给 LLM 之前的上下文摘要：规模是否受控、关键结构是否保留、
 * 环上建议切点是否算对（这一项是纯计算，不允许交给模型猜）。
 */
async function checkNarration(
  dir: string,
  expected: NonNullable<Expectation["expect"]["narration"]>,
  input: {
    files: Awaited<ReturnType<typeof scanFiles>>["files"];
    contents: Map<string, string>;
    symbols: ReturnType<typeof extractGraph>["symbols"];
    edges: ReturnType<typeof extractGraph>["edges"];
    cycles: ReturnType<typeof analyzeCycles>;
  },
): Promise<Check[]> {
  const { files, contents, symbols, edges, cycles } = input;
  const findings = [
    ...cycles,
    ...toDeadExportFindings(analyzeDeadExports({ root: dir, files, contents })),
  ];

  const context = buildNarrationContext({
    stack: await detectStack(dir, contents),
    files,
    symbols,
    edges,
    findings,
    metrics: calculateMetrics(files, edges),
    architecture: analyzeArchitecture(files, symbols, edges),
  });

  const checks: Check[] = [];
  const estimated = estimateContextTokens(context);

  if (expected.maxEstimatedTokens !== undefined) {
    checks.push({
      label: `上下文规模 ${estimated} tokens ≤ ${expected.maxEstimatedTokens}`,
      ok: estimated <= expected.maxEstimatedTokens,
    });
  }

  for (const module of expected.modules ?? []) {
    checks.push({
      label: `模块聚合包含 ${module}`,
      ok: context.modules.some((item) => item.path === module),
    });
  }

  for (const cut of expected.cycleCuts ?? []) {
    const matched = context.cycles.some(
      (cycle) =>
        cycle.suggestedCut?.from === cut.from &&
        cycle.suggestedCut?.to === cut.to &&
        (cut.references === undefined || cycle.suggestedCut?.references === cut.references),
    );
    checks.push({ label: `环建议切点 ${cut.from} → ${cut.to}`, ok: matched });
  }

  return checks;
}

function resolveOutcome(status: FixtureStatus, passed: boolean): Outcome {
  if (status === "expected-pass") return passed ? "PASS" : "REGRESSION";
  return passed ? "FIXED" : "KNOWN-FAIL";
}

const OUTCOME_MARK: Record<Outcome, string> = {
  PASS: "✓ PASS",
  "KNOWN-FAIL": "· KNOWN-FAIL",
  REGRESSION: "✗ REGRESSION",
  FIXED: "★ FIXED",
  SKIPPED: "○ SKIPPED",
};

function printResult(result: FixtureResult): void {
  const passedCount = result.checks.filter((check) => check.ok).length;
  const ratio = result.outcome === "SKIPPED" ? "—" : `${passedCount}/${result.checks.length}`;

  console.log(
    `${OUTCOME_MARK[result.outcome].padEnd(16)}${result.name.padEnd(26)}${ratio.padEnd(8)}${result.expectation.title}`,
  );

  if (result.outcome === "SKIPPED") {
    console.log(
      `                  缺少可选依赖：${result.missing?.join("、")}（执行 pnpm install 后可运行）`,
    );
    console.log("");
    return;
  }
  console.log(
    `                  扫描 ${result.stats.files} 文件 · ${result.stats.symbols} 符号 · ${result.stats.edges} 依赖边 · ${result.stats.cycles} 个环`,
  );

  for (const check of result.checks) {
    if (check.ok) continue;
    console.log(`                  未命中：${check.label}`);
  }

  if (result.outcome === "KNOWN-FAIL") {
    console.log(`                  原因：${result.expectation.why}`);
  }
  if (result.outcome === "FIXED") {
    console.log(`                  该用例已通过，请把 expected.json 的 status 改为 expected-pass`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(FIXTURES_DIR, entry.name))
    .sort();

  console.log("\nRepo Surgeon · Fixture Eval\n");

  const results: FixtureResult[] = [];
  for (const dir of dirs) {
    const result = await evaluateFixture(dir);
    results.push(result);
    printResult(result);
  }

  const tally = (outcome: Outcome) => results.filter((item) => item.outcome === outcome).length;
  const passed = tally("PASS");
  const regressions = tally("REGRESSION");

  const skipped = tally("SKIPPED");
  const evaluated = results.length - skipped;

  console.log("─".repeat(72));
  console.log(
    `汇总：${passed} PASS · ${tally("KNOWN-FAIL")} KNOWN-FAIL · ${regressions} REGRESSION · ${tally("FIXED")} FIXED` +
      (skipped > 0 ? ` · ${skipped} SKIPPED` : ""),
  );
  console.log(
    `真实通过率：${passed}/${evaluated}（${evaluated ? Math.round((passed / evaluated) * 100) : 0}%）` +
      (skipped > 0 ? `，另有 ${skipped} 个用例因缺少可选依赖被跳过` : "") +
      "\n",
  );

  if (regressions > 0) {
    console.error(`存在 ${regressions} 个回归用例，请修复后再提交。`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
