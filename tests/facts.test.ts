import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectProposalFacts,
  estimateFactsTokens,
  isWholeFileDead,
  renderProposalFacts,
} from "../src/facts.js";
import { scanFiles } from "../src/scanner.js";

/**
 * 给模型的事实包。
 *
 * 这一层不产生任何判断，但它决定了模型能不能做对判断——喂错了事实，
 * 后面的静态校验和对账再严也只是拦住一个本来就不该产生的方案。
 *
 * 三件必须盯住的事，全部来自 `docs/PROPOSAL.md` 里写下的约束：
 * 候选只能是规则放弃的那部分、声明源码必须给、**截断必须说出来**。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function factsOf(fixture: string) {
  const dir = path.join(ROOT, "fixtures", fixture);
  const { files, contents } = await scanFiles(dir);
  return collectProposalFacts({ root: dir, files, contents });
}

describe("提方案的事实包", () => {
  it("候选只收规则放弃的部分，工具已自动处理的不进来", async () => {
    const facts = await factsOf("19-dead-export-removal");

    // 这个 fixture 里 3 个已被规则自动清理，模型不该再看到它们
    assert.equal(facts.autoHandled, 3);

    const symbols = facts.candidates.map((item) => item.symbol).sort();
    assert.deepEqual(symbols, ["main", "registered"]);

    const registered = facts.candidates.find((item) => item.symbol === "registered");
    assert.equal(registered?.origin, "blocked");
    assert.match(registered?.whyToolRefused ?? "", /副作用/);

    const main = facts.candidates.find((item) => item.symbol === "main");
    assert.equal(main?.origin, "excluded");
    assert.match(main?.whyToolRefused ?? "", /入口文件/);
  });

  it("带上声明源码——不给源码，模型只能靠符号名猜", async () => {
    const facts = await factsOf("19-dead-export-removal");
    const registered = facts.candidates.find((item) => item.symbol === "registered");

    // 变量要取到整条语句，只给 `registered = register()` 看不出它是不是导出
    assert.match(registered?.declarationText ?? "", /^export const registered = register\(\);$/);
    assert.equal(registered?.declarationOmittedLines, 0);
  });

  it("整个文件死透的排最前，入口导出排最后", async () => {
    const facts = await factsOf("20-many-candidates");

    // orphan.ts 两个导出全死、无人 import、顶层无副作用；同分时按行号排
    assert.deepEqual(
      facts.candidates.slice(0, 2).map((item) => item.symbol),
      ["forgotten", "ForgottenOptions"],
    );
    assert.ok(isWholeFileDead(facts.candidates[0]));

    // 入口导出最可能真的是对外 API，排在最后
    assert.equal(facts.candidates.at(-1)?.origin, "excluded");
    assert.match(facts.candidates.at(-1)?.whyToolRefused ?? "", /入口文件/);
  });

  it("候选超过上限时截断，并在上下文里明说少了多少", async () => {
    const facts = await factsOf("20-many-candidates");

    assert.equal(facts.totalCandidates, 34);
    assert.equal(facts.candidates.length, 30);
    assert.equal(facts.omittedCandidates, 4);

    // 静默截断会让模型把「前 30 条」当成全部，然后得出「其余都还在用」的错误结论
    const rendered = renderProposalFacts(facts);
    assert.match(rendered, /\*\*另有 4 个未列出\*\*/);
    assert.match(rendered, /不要据此判断/);
  });

  it("没有截断时不写警告——每一条提示都该有信息量", async () => {
    const facts = await factsOf("19-dead-export-removal");

    assert.equal(facts.omittedCandidates, 0);
    assert.doesNotMatch(renderProposalFacts(facts), /未列出/);
  });

  it("整文件死透的判定要求四个条件同时成立", async () => {
    const facts = await factsOf("18-dead-exports");

    // dead.ts：两个导出全死、无人 import、顶层无副作用
    const unusedHelper = facts.candidates.find((item) => item.symbol === "unusedHelper");
    assert.ok(unusedHelper && isWholeFileDead(unusedHelper));

    // helper.ts 的 parseFlag 被测试文件 import，入边不为 0
    const parseFlag = facts.candidates.find((item) => item.symbol === "parseFlag");
    assert.equal(parseFlag?.origin, "test-only");
    assert.ok(parseFlag && parseFlag.fileInboundCount > 0);
    assert.ok(parseFlag && !isWholeFileDead(parseFlag));
  });

  it("上下文规模受控", async () => {
    const facts = await factsOf("20-many-candidates");
    // 30 个候选、每个带声明源码，仍应远低于 12k 预算
    assert.ok(estimateFactsTokens(facts) < 12_000, "超出给模型的 token 预算");
  });
});
