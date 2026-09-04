import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { planExecution } from "../src/plan.js";
import { createAnalysisGraph } from "../src/workflow.js";

/**
 * 执行计划与条件路由。
 *
 * 分两层：`planExecution` 是纯函数，直接断言决策表；
 * 而条件边到底能不能跑，只有真的 invoke 一次图才知道——
 * 这个项目在图的拓扑上翻过三次车（节点名与通道名冲突、并行写通道无 reducer），
 * 每一次都是「代码写完了但从没运行过」。所以这里必须有端到端。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".tmp-plan-test");

let current: string | undefined;

function sandboxFrom(fixture: string): string {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  current = dir;
  fs.cpSync(path.join(ROOT, "fixtures", fixture, "src"), path.join(dir, "src"), {
    recursive: true,
  });
  return dir;
}

/**
 * 跑一次真实的图。
 *
 * planner 与 narrator 都注入桩：前者绕开「本机有没有配 API key」这个
 * 环境变量，后者避免真的发起网络请求。被测的是**路由**，不是模型。
 */
async function run(root: string, options: { query?: string; full?: boolean; hasModel?: boolean }) {
  const executed: string[] = [];
  const graph = createAnalysisGraph({
    planner: (input) => planExecution({ ...input, hasModel: options.hasModel ?? true }),
    narrator: async () => ({ summary: "stub", layering: [], risks: [] }),
    onProgress: (event) => {
      if (event.phase === "end") executed.push(event.node);
    },
  });

  const state = await graph.invoke(
    { root, query: options.query, full: options.full, currentStep: "start" },
    { configurable: { thread_id: `plan-${executed.length}` } },
  );

  return { state, executed };
}

afterEach(() => {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
});

/**
 * 取消信号必须递到发请求的地方。
 *
 * LangGraph 自己能在**节点边界**中止，但那救不了正在进行的模型调用——
 * 这条链路以前是断的：用户点停止，界面停了、状态写成 cancelled 了，
 * 而 narrate 那 18 秒照样跑完，token 照烧。
 */
describe("取消信号", () => {
  it("narrator 拿得到 signal，而不只是图在节点边界停", async () => {
    const root = sandboxFrom("09-src-layout");
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let calls = 0;

    const graph = createAnalysisGraph({
      planner: (input) => planExecution({ ...input, hasModel: true }),
      narrator: async (_context, signal) => {
        calls += 1;
        received = signal;
        return { summary: "stub", layering: [], risks: [] };
      },
      signal: controller.signal,
    });

    await graph.invoke(
      { root, currentStep: "start" },
      { configurable: { thread_id: "signal-1" }, signal: controller.signal },
    );

    assert.equal(calls, 1, "narrate 应该跑到");
    assert.ok(received, "signal 没传到发请求的那一层，「停止」在 analyze 下就是半残的");
    assert.equal(received?.aborted, false);
  });

  it("外部一取消，narrator 手上那个 signal 立刻是中止态", async () => {
    const root = sandboxFrom("09-src-layout");
    const controller = new AbortController();
    let seen: AbortSignal | undefined;

    const graph = createAnalysisGraph({
      planner: (input) => planExecution({ ...input, hasModel: true }),
      narrator: async (_context, signal) => {
        seen = signal;
        // 模型调用正在飞的那一刻，用户点了停止
        controller.abort();
        return { summary: "stub", layering: [], risks: [] };
      },
      signal: controller.signal,
    });

    await graph
      .invoke({ root, currentStep: "start" }, { configurable: { thread_id: "signal-2" } })
      .catch(() => undefined);

    assert.equal(seen?.aborted, true, "取消必须能穿透到正在进行的那次调用");
  });
});

describe("planExecution", () => {
  it("没有问题时按全量审计排布", () => {
    const plan = planExecution({ hasModel: true });
    assert.equal(plan.intent, "full-audit");
    assert.deepEqual(plan.run.sort(), ["analyzeArchitecture", "deadExports", "narrate"]);
  });

  it("问循环依赖时只保留与答案相关的节点", () => {
    const plan = planExecution({ query: "这个仓库有循环依赖吗", hasModel: true });
    assert.equal(plan.intent, "dependency");
    assert.deepEqual(plan.run, []);
  });

  it("「架构里有没有循环依赖」判成依赖，而不是因为出现「架构」就去写叙述", () => {
    const plan = planExecution({ query: "架构里有没有循环依赖", hasModel: true });
    assert.equal(plan.intent, "dependency");
    assert.ok(!plan.run.includes("narrate"));
  });

  it("问架构时保留架构图与解读", () => {
    const plan = planExecution({ query: "这个项目是怎么分层的", hasModel: true });
    assert.equal(plan.intent, "architecture");
    assert.deepEqual(plan.run.sort(), ["analyzeArchitecture", "narrate"]);
  });

  it("找组件属于检索，不需要一段架构散文", () => {
    const plan = planExecution({ query: "找所有处理用户登录的组件", hasModel: true });
    assert.equal(plan.intent, "search");
    assert.deepEqual(plan.run, []);
  });

  it("没有模型时直接不走 narrate 这条边", () => {
    const plan = planExecution({ hasModel: false });
    assert.ok(!plan.run.includes("narrate"));
    const decision = plan.decisions.find((item) => item.node === "narrate")!;
    assert.match(decision.why, /未配置模型/);
  });

  it("--full 覆盖一切裁剪", () => {
    const plan = planExecution({ query: "有循环依赖吗", hasModel: true, full: true });
    assert.equal(plan.intent, "full-audit");
    assert.deepEqual(plan.run.sort(), ["analyzeArchitecture", "deadExports", "narrate"]);
  });

  it("每一个被跳过的节点都要有理由", () => {
    const plan = planExecution({ query: "有循环依赖吗", hasModel: true });
    for (const decision of plan.decisions.filter((item) => !item.run)) {
      assert.ok(decision.why.length > 0, `${decision.node} 缺少跳过理由`);
    }
  });
});

describe("条件路由（端到端）", () => {
  it("全量：所有节点都执行", async () => {
    const { state, executed } = await run(sandboxFrom("09-src-layout"), {});

    for (const node of ["analyzeArchitecture", "dependency", "quality", "deadExports", "narrate"]) {
      assert.ok(executed.includes(node), `${node} 应当执行`);
    }
    assert.ok(state.report, "报告必须产出");
  });

  it("定向提问：跳过无关分支，但报告依然完整", async () => {
    const { state, executed } = await run(sandboxFrom("08-nested-cycles"), {
      query: "这个仓库有循环依赖吗",
    });

    // 跳掉的
    assert.ok(!executed.includes("narrate"), "narrate 应当被跳过");
    assert.ok(!executed.includes("analyzeArchitecture"), "analyzeArchitecture 应当被跳过");
    assert.ok(!executed.includes("deadExports"), "deadExports 应当被跳过");

    // 留下的：答案本身，以及报告的必填内容
    assert.ok(executed.includes("dependency"));
    assert.ok(executed.includes("quality"));
    assert.ok(executed.includes("render"));
    // 有检索问题，所以这一个确实该跑
    assert.ok(executed.includes("retrieveContext"));

    // 跳过分支后报告仍然是完整的，而不是缺字段
    assert.ok(state.report?.metrics, "metrics 是报告必填项，不能因为裁剪而缺失");
    assert.ok(state.report?.mermaid, "跳过 analyzeArchitecture 后仍要有兜底架构图");
    assert.ok(
      state.findings.some((item) => item.rule === "import-cycle"),
      "环必须被检出",
    );
  });

  it("裁剪要留痕：报告里写清楚跳过了什么、为什么", async () => {
    const dir = sandboxFrom("08-nested-cycles");
    await run(dir, { query: "这个仓库有循环依赖吗" });

    const markdown = fs.readFileSync(
      path.join(dir, ".reposurgeon", "reports", "report.md"),
      "utf8",
    );
    assert.match(markdown, /## 执行计划/);
    assert.match(markdown, /本次\*\*跳过\*\*了以下节点/);
    assert.match(markdown, /narrate/);
    // 缺席原因必须区分「主动跳过」与「没配模型」
    assert.match(markdown, /本次按执行计划跳过/);
  });

  it("--full 时不做任何裁剪", async () => {
    const { executed } = await run(sandboxFrom("09-src-layout"), {
      query: "有循环依赖吗",
      full: true,
    });

    for (const node of ["analyzeArchitecture", "deadExports", "narrate"]) {
      assert.ok(executed.includes(node), `--full 下 ${node} 仍应执行`);
    }
  });

  it("没有模型时不进入 narrate 节点", async () => {
    const { executed } = await run(sandboxFrom("09-src-layout"), { hasModel: false });
    assert.ok(!executed.includes("narrate"));
    assert.ok(executed.includes("render"), "跳过 narrate 后仍要走到 render");
  });

  it("「跳过」必须是真的没执行，不能是空转一趟", async () => {
    const { state, executed } = await run(sandboxFrom("09-src-layout"), {});

    // 没有检索问题 → 计划说跳过 retrieveContext → 进度事件里就不该有它
    const decision = state.executionPlan?.decisions.find((item) => item.node === "retrieveContext");
    assert.equal(decision?.run, false, "无 query 时计划应标记为跳过");
    assert.ok(!executed.includes("retrieveContext"), "计划说跳过，节点就不能出现在执行记录里");

    // 汇聚点只走一次，render 不能被四个分析器各触发一遍
    assert.equal(executed.filter((node) => node === "render").length, 1);
  });
});
