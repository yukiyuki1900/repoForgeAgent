import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV1, simulateReadableStream } from "ai/test";
import { askCodebase } from "../src/ask.js";
import { buildIndex, createTools, type CodebaseIndex } from "../src/tools.js";

/**
 * Agent 的评估分两层，混在一起就什么都测不了：
 *
 * - **工具层**是确定性的：给定仓库，每个工具的返回值应当完全可预期。
 *   这部分能像普通函数一样测死，包括边界（路径写错、行号越界、结果截断）。
 * - **循环层**依赖模型，用桩模型测**控制流**：轮次上限有没有生效、
 *   工具报错后循环是否还能继续、撞上限时有没有如实标注。
 *
 * 真实模型的回答质量不在这里测——那需要 API key，且结果不可复现。
 * 但「工具是否给了模型正确的事实」和「循环是否受控」这两件事，
 * 恰恰是出问题最多、也最该被回归的部分。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let index: CodebaseIndex;

before(async () => {
  index = await buildIndex(path.join(ROOT, "fixtures", "09-src-layout"));
});

/** execute 的第二个参数是 SDK 注入的调用上下文，单测里用不到 */
const CTX = {} as never;

describe("工具层", () => {
  it("searchFiles 按路径关键词命中", async () => {
    const { tools } = createTools(index);
    const result = (await tools.searchFiles.execute({ keyword: "src/" }, CTX)) as {
      total: number;
      rows: Array<{ path: string }>;
    };

    assert.ok(result.total > 0);
    assert.ok(result.rows.every((row) => row.path.startsWith("src/")));
  });

  it("getFileSummary 给出入边与出边数量", async () => {
    const { tools } = createTools(index);
    const target = index.files[0].path;
    const result = (await tools.getFileSummary.execute({ path: target }, CTX)) as {
      path: string;
      dependentCount: number;
      dependencyCount: number;
    };

    assert.equal(result.path, target);
    assert.equal(typeof result.dependentCount, "number");
    assert.equal(typeof result.dependencyCount, "number");
  });

  it("getDependents 与 getDependencies 是同一条边的两侧", async () => {
    const { tools } = createTools(index);

    // 找一条真实的 import 边
    const edge = index.edges.find((item) => item.kind === "import")!;
    const from = index.pathById.get(edge.from)!;
    const to = index.pathById.get(edge.to)!;

    const dependents = (await tools.getDependents.execute({ path: to }, CTX)) as {
      rows: Array<{ from: string }>;
    };
    const dependencies = (await tools.getDependencies.execute({ path: from }, CTX)) as {
      rows: Array<{ to: string }>;
    };

    assert.ok(
      dependents.rows.some((row) => row.from === from),
      `${to} 的入边应包含 ${from}`,
    );
    assert.ok(
      dependencies.rows.some((row) => row.to === to),
      `${from} 的出边应包含 ${to}`,
    );
  });

  it("路径写错时给出候选，而不是空结果", async () => {
    const { tools } = createTools(index);
    // 模型经常写这种「差不多但不对」的路径
    const result = (await tools.getFileSummary.execute({ path: "totally/wrong.ts" }, CTX)) as {
      error?: string;
      suggestions?: string[];
      hint?: string;
    };

    assert.ok(result.error, "应当报错");
    assert.ok(result.hint, "应当给出下一步提示");
    assert.ok(Array.isArray(result.suggestions));
  });

  it("路径少写前缀时能自动补全", async () => {
    const { tools } = createTools(index);
    const full = index.files[0].path; // 形如 src/pages/home.ts
    const partial = full.split("/").slice(1).join("/");

    const result = (await tools.getFileSummary.execute({ path: partial }, CTX)) as {
      path?: string;
      error?: string;
    };

    assert.equal(result.error, undefined, `"${partial}" 应当被解析为 "${full}"`);
    assert.equal(result.path, full);
  });

  it("readSource 行号越界时夹紧，并说明截断", async () => {
    const { tools } = createTools(index);
    const target = index.files[0].path;

    const result = (await tools.readSource.execute(
      { path: target, startLine: 1, endLine: 9999 },
      CTX,
    )) as { endLine: number; totalLines: number; truncated?: string; source: string };

    assert.equal(result.endLine, result.totalLines, "应夹紧到文件末尾");
    assert.ok(result.truncated, "截断必须如实说明，否则模型会把片段当成全文");
    assert.equal(result.source.split("\n").length, result.endLine);
  });

  it("每次调用都留下可展示的记录", async () => {
    const seen: string[] = [];
    const { tools, calls } = createTools(index, { onCall: (call) => seen.push(call.name) });

    await tools.searchFiles.execute({ keyword: "src" }, CTX);
    await tools.findSymbol.execute({ name: "a" }, CTX);

    assert.deepEqual(seen, ["searchFiles", "findSymbol"]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.summary.length > 0));
  });

  it("工具全部只读：不提供任何写入或执行能力", () => {
    const { tools } = createTools(index);
    const names = Object.keys(tools);

    assert.deepEqual(names.sort(), [
      "findSymbol",
      "getDependencies",
      "getDependents",
      "getFileSummary",
      "listCycles",
      "listHotspots",
      "readSource",
      "searchFiles",
    ]);
  });

  it("listHotspots 按入边数降序，一次给出排名", async () => {
    const { tools } = createTools(index);
    const result = (await tools.listHotspots.execute({ limit: 5 }, CTX)) as {
      rows: Array<{ path: string; dependentCount: number }>;
    };

    assert.ok(result.rows.length > 0, "fixture 里应当有被依赖的文件");
    for (let i = 1; i < result.rows.length; i += 1) {
      assert.ok(
        result.rows[i - 1].dependentCount >= result.rows[i].dependentCount,
        "必须按被依赖次数降序",
      );
    }
    // 排名与逐个查 getDependents 的结果必须一致，否则模型会拿到互相矛盾的事实
    const top = result.rows[0];
    const dependents = (await tools.getDependents.execute({ path: top.path }, CTX)) as {
      total: number;
    };
    assert.equal(dependents.total, top.dependentCount);
  });

  it("依赖类工具的摘要必须带上目标路径", async () => {
    const calls: string[] = [];
    const { tools } = createTools(index, { onCall: (call) => calls.push(call.summary) });
    const target = index.files.find((file) =>
      index.edges.some((edge) => edge.to === file.id && edge.kind === "import"),
    )!;

    await tools.getDependents.execute({ path: target.path }, CTX);
    await tools.getDependencies.execute({ path: target.path }, CTX);

    // 只写「69 个文件依赖它」的话，界面上连着三行看不出查的是谁
    assert.ok(
      calls.every((summary) => summary.includes(target.path)),
      `摘要缺少路径：${calls.join(" / ")}`,
    );
  });
});

/**
 * 造一个按脚本行事的模型：第 n 轮返回 script[n]。
 *
 * 实现的是 `doStream` 而不是 `doGenerate`——`askCodebase` 改用 streamText
 * 之后走的是流式路径，桩模型也必须跟着走同一条，否则测的就不是线上代码。
 */
function scriptedModel(
  script: Array<{ tool?: { name: string; args: unknown }; text?: string }>,
): MockLanguageModelV1 {
  let step = 0;

  return new MockLanguageModelV1({
    doStream: async () => {
      const current = script[Math.min(step, script.length - 1)];
      step += 1;

      const usage = { promptTokens: 10, completionTokens: 5 };
      const chunks = current.tool
        ? [
            {
              type: "tool-call" as const,
              toolCallType: "function" as const,
              toolCallId: `call-${step}`,
              toolName: current.tool.name,
              args: JSON.stringify(current.tool.args),
            },
            { type: "finish" as const, finishReason: "tool-calls" as const, usage },
          ]
        : [
            // 拆成两段推送，顺便验证增量确实是一段一段到达的
            ...splitForStream(current.text ?? "").map((textDelta) => ({
              type: "text-delta" as const,
              textDelta,
            })),
            { type: "finish" as const, finishReason: "stop" as const, usage },
          ];

      return {
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

function splitForStream(text: string): string[] {
  if (!text) return [""];
  const middle = Math.ceil(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

describe("循环层", () => {
  it("查一次工具就能回答时，只走两轮", async () => {
    const model = scriptedModel([
      { tool: { name: "listCycles", args: {} } },
      { text: "这个仓库没有循环依赖。" },
    ]);

    const result = await askCodebase({ model, index, question: "有循环依赖吗" });

    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].name, "listCycles");
    assert.equal(result.steps, 2);
    assert.equal(result.exhausted, false);
    assert.match(result.answer, /循环依赖/);
  });

  it("撞到轮次上限时如实标注，并交出已查到的线索", async () => {
    // 一个永远不给结论、只顾着查的模型
    const model = scriptedModel([{ tool: { name: "searchFiles", args: { keyword: "src" } } }]);

    const result = await askCodebase({ model, index, question: "随便问问", maxSteps: 3 });

    assert.equal(result.steps, 3);
    assert.equal(result.exhausted, true);
    assert.match(result.answer, /上限/);
    // 已经查到的东西不能白丢
    assert.match(result.answer, /searchFiles|个文件匹配/);
  });

  it("工具返回错误后循环不中断，模型可以据此重试", async () => {
    const model = scriptedModel([
      { tool: { name: "getFileSummary", args: { path: "不存在的路径.ts" } } },
      { tool: { name: "searchFiles", args: { keyword: "src" } } },
      { text: "已根据候选路径重新定位。" },
    ]);

    const result = await askCodebase({ model, index, question: "看看某个文件" });

    assert.equal(result.calls.length, 2);
    assert.equal(result.exhausted, false);
    assert.match(result.answer, /重新定位/);
  });

  it("回答以增量方式推送，而不是最后一次性给出", async () => {
    const model = scriptedModel([
      { tool: { name: "listCycles", args: {} } },
      { text: "这个仓库没有循环依赖。" },
    ]);

    const deltas: string[] = [];
    const result = await askCodebase({
      model,
      index,
      question: "有循环依赖吗",
      onTextDelta: (delta) => deltas.push(delta),
    });

    assert.ok(deltas.length >= 2, `应当分多次推送，实际 ${deltas.length} 次`);
    assert.equal(deltas.join(""), result.answer, "增量拼起来必须等于最终回答");
  });

  it("轮次上限可配置", async () => {
    const model = scriptedModel([{ tool: { name: "searchFiles", args: { keyword: "a" } } }]);

    const result = await askCodebase({ model, index, question: "x", maxSteps: 2 });
    assert.equal(result.steps, 2);
  });
});
