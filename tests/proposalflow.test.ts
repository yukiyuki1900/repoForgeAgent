import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV1 } from "ai/test";
import type { FileNode } from "../src/core/analysis.js";
import { formatProposalFlow, proposeAndValidate } from "../src/refactor/proposalflow.js";
import { scanFiles } from "../src/scan/scanner.js";

/**
 * 提方案这条链路的编排。
 *
 * `propose.test.ts` 测 schema 约束，`validate.test.ts` 测幻觉拦截，
 * `execute.test.ts` 测执行与对账——这里测的是**它们串起来之后是否还成立**。
 *
 * 真实模型的方案质量不在这里测：那需要 key，且不可复现。
 * 但「幻觉会不会被拦下」和「没有可提的方案时会不会崩」这两件事必须能回归，
 * 它们才是这个功能可信的全部理由。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let ctx: { root: string; files: FileNode[]; contents: Map<string, string> };

before(async () => {
  const root = path.join(ROOT, "fixtures", "18-dead-exports");
  const { files, contents } = await scanFiles(root);
  ctx = { root, files, contents };
});

/** 桩模型：把给定对象当作结构化输出返回，并记下它被调用了几次 */
function stubModel(payload: unknown): { model: MockLanguageModelV1; calls: () => number } {
  let calls = 0;

  const model = new MockLanguageModelV1({
    // 漏掉这行会先撞上「模型没有默认对象生成模式」——那个与被测逻辑
    // 毫无关系的错误会让 assert.rejects 假绿。这个坑踩过一次了
    defaultObjectGenerationMode: "json",
    doGenerate: async () => {
      calls += 1;
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        usage: { promptTokens: 100, completionTokens: 50 },
        text: JSON.stringify(payload),
      };
    },
  });

  return { model, calls: () => calls };
}

const good = {
  kind: "delete-file",
  targetFile: "src/dead.ts",
  targetSymbol: "unusedHelper",
  rationale: "整个文件的导出都没人用，也没有任何文件 import 它",
  operations: [{ op: "delete-file", file: "src/dead.ts", symbol: "" }],
  prediction: { exportsRemoved: 2, filesRemoved: 1 },
  risk: "low",
};

describe("提方案的完整流程", () => {
  it("合法方案走到列表里，序号可用于执行", async () => {
    const { model } = stubModel({ proposals: [good] });

    const flow = await proposeAndValidate({ ...ctx, model });

    assert.equal(flow.skipped, false);
    assert.equal(flow.validation.accepted.length, 1);
    assert.equal(flow.validation.rejected.length, 0);

    const text = formatProposalFlow(flow);
    assert.match(text, /\[1\] delete-file/);
    assert.match(text, /--execute <序号>/);
    // 不提供「全部执行」是设计，不是没来得及做——所以它得被说出来。
    // 初版这里写的是 doesNotMatch(/全部执行/)，那是个坏断言：
    // 用「输出不含某词」去断言一个设计决策本来就脆，而这四个字
    // 恰恰出现在声明不提供它的那句话里
    assert.match(text, /没有「全部执行」/);
  });

  it("模型编的符号被拦下，且拦下的原因可查", async () => {
    // 模型编一个不存在的符号名是常态，不是异常
    const { model } = stubModel({
      proposals: [{ ...good, targetSymbol: "thisSymbolNeverExisted" }],
    });

    const flow = await proposeAndValidate({ ...ctx, model });

    assert.equal(flow.validation.accepted.length, 0);
    assert.equal(flow.raw.length, 1, "模型的原始输出要留着");
    assert.match(flow.validation.rejected[0].reason, /不在候选清单/);

    // 判据可以被质疑，但不能是隐形的——被拦下的必须能在输出里看到
    const text = formatProposalFlow(flow);
    assert.match(text, /未通过静态校验/);
    assert.match(text, /thisSymbolNeverExisted/);
  });

  it("预测数字不对的方案进不了列表", async () => {
    const { model } = stubModel({
      proposals: [{ ...good, prediction: { exportsRemoved: 7, filesRemoved: 1 } }],
    });

    const flow = await proposeAndValidate({ ...ctx, model });

    assert.equal(flow.validation.accepted.length, 0);
    assert.match(flow.validation.rejected[0].reason, /静态推算应为 2 个/);
  });

  it("连带删除的风险等级被强制改写，且改写留痕", async () => {
    const root = path.join(ROOT, "fixtures", "19-dead-export-removal");
    const { files, contents } = await scanFiles(root);
    const { model } = stubModel({
      proposals: [
        {
          kind: "delete-with-dependencies",
          targetFile: "src/effects.ts",
          targetSymbol: "registered",
          rationale: "register 只往一个从没被读过的计数器里写",
          operations: [
            { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
            { op: "delete-declaration", file: "src/effects.ts", symbol: "register" },
          ],
          prediction: { exportsRemoved: 1, filesRemoved: 0 },
          risk: "low",
        },
      ],
    });

    const flow = await proposeAndValidate({ root, files, contents, model });

    assert.equal(flow.validation.accepted.length, 1, JSON.stringify(flow.validation.rejected));
    assert.equal(flow.validation.accepted[0].risk, "high");

    const text = formatProposalFlow(flow);
    assert.match(text, /risk: low → high/);
    // 主动说出边界，比被问出来强得多
    assert.match(text, /证明不了运行时行为等价/);
  });

  it("模型一条方案都不提：不崩，如实说", async () => {
    const { model } = stubModel({ proposals: [] });

    const flow = await proposeAndValidate({ ...ctx, model });

    assert.equal(flow.validation.accepted.length, 0);
    assert.match(formatProposalFlow(flow), /没有一条方案通过静态校验/);
  });

  it("候选池为空：一次模型调用都不发起", async () => {
    // 面对空清单模型只会编，白花一次调用还引入幻觉风险
    const root = path.join(ROOT, "fixtures", "07-empty-repo");
    const { files, contents } = await scanFiles(root);
    const { model, calls } = stubModel({ proposals: [good] });

    const flow = await proposeAndValidate({ root, files, contents, model });

    assert.equal(calls(), 0, "候选池为空时不该调用模型");
    assert.equal(flow.skipped, true);
    assert.match(formatProposalFlow(flow), /候选池为空/);
  });
});
