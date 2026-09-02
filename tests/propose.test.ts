import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { MockLanguageModelV1 } from "ai/test";
import { collectProposalFacts, type ProposalFacts } from "../src/facts.js";
import { proposeCleanup } from "../src/propose.js";
import { scanFiles } from "../src/scanner.js";

/**
 * 模型提方案这一层。
 *
 * **桩模型测的是约束，不是回答质量。** 真实模型提的方案好不好，需要 key
 * 且不可复现，不在这里测。但下面这几件事必须能回归，它们才是这个功能可信的全部理由：
 *
 * - 没有数字预测的方案能不能进来（不能——schema 拦，不是提示词拦）
 * - 候选池空的时候会不会白调一次模型
 * - 模型一条方案都不提时会不会崩
 * - 事实到底有没有喂进 prompt
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let facts: ProposalFacts;

before(async () => {
  const dir = path.join(ROOT, "fixtures", "18-dead-exports");
  const { files, contents } = await scanFiles(dir);
  facts = collectProposalFacts({ root: dir, files, contents });
});

/** 桩模型：把给定对象当作模型的结构化输出返回，并记下它收到的提示词 */
function stubModel(payload: unknown): { model: MockLanguageModelV1; seen: string[] } {
  const seen: string[] = [];

  const model = new MockLanguageModelV1({
    // 不声明就会先撞上「模型没有默认对象生成模式」，那会让下面几条断言
    // 因为一个与被测逻辑无关的错误而「通过」——假绿比失败更危险
    defaultObjectGenerationMode: "json",
    doGenerate: async (options) => {
      seen.push(JSON.stringify(options.prompt));
      return {
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: "stop" as const,
        usage: { promptTokens: 100, completionTokens: 50 },
        text: JSON.stringify(payload),
      };
    },
  });

  return { model, seen };
}

const validProposal = {
  kind: "delete-file",
  targetFile: "src/dead.ts",
  targetSymbol: "unusedHelper",
  rationale: "整个文件的导出都没人用，也没有任何文件 import 它",
  operations: [{ op: "delete-file", file: "src/dead.ts", symbol: "" }],
  prediction: { exportsRemoved: 2, filesRemoved: 1 },
  risk: "low",
};

describe("模型提方案", () => {
  it("正常方案原样返回", async () => {
    const { model } = stubModel({ proposals: [validProposal] });

    const result = await proposeCleanup(model, facts);

    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].kind, "delete-file");
    assert.equal(result.proposals[0].prediction.exportsRemoved, 2);
  });

  it("预测为 0 的方案进不来——约束在 schema 上，不在提示词里", async () => {
    const { model } = stubModel({
      proposals: [{ ...validProposal, prediction: { exportsRemoved: 0, filesRemoved: 0 } }],
    });

    // 一个不能被证伪的方案和一段客套话没有区别，不该有办法表达出来
    await assert.rejects(() => proposeCleanup(model, facts));
  });

  it("缺少 prediction 字段的方案进不来", async () => {
    const { prediction: _omitted, ...withoutPrediction } = validProposal;
    const { model } = stubModel({ proposals: [withoutPrediction] });

    await assert.rejects(() => proposeCleanup(model, facts));
  });

  it("方案类型不在枚举里就进不来", async () => {
    const { model } = stubModel({
      proposals: [{ ...validProposal, kind: "refactor-architecture" }],
    });

    await assert.rejects(() => proposeCleanup(model, facts));
  });

  it("模型一条都提不出来时不崩——这是可接受的答案", async () => {
    const { model } = stubModel({ proposals: [] });

    const result = await proposeCleanup(model, facts);
    assert.deepEqual(result.proposals, []);
  });

  it("候选池为空时根本不调用模型", async () => {
    const { model, seen } = stubModel({ proposals: [validProposal] });
    const empty: ProposalFacts = { ...facts, candidates: [], totalCandidates: 0 };

    const result = await proposeCleanup(model, empty);

    assert.deepEqual(result.proposals, []);
    // 面对空清单模型只会编，白花一次调用还引入幻觉风险
    assert.equal(seen.length, 0, "候选池为空时不该发起调用");
  });

  it("事实确实喂进了提示词", async () => {
    const { model, seen } = stubModel({ proposals: [] });

    await proposeCleanup(model, facts);

    assert.equal(seen.length, 1);
    const prompt = seen[0];
    // 候选的符号名、工具拒绝的理由、声明源码都要在
    assert.match(prompt, /unusedHelper/);
    assert.match(prompt, /不再是 ES module/);
    assert.match(prompt, /value.toUpperCase/);
  });
});
