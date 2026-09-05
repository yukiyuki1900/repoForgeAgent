import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { applyProposal } from "../src/refactor/execute.js";
import type { Proposal } from "../src/refactor/propose.js";
import { scanFiles } from "../src/scan/scanner.js";

/**
 * 执行模型方案的端到端验证。
 *
 * C3 校验的是**方案说得对不对**，这里校验的是**执行有没有真的做到**——
 * 两件事必须分开测。返回值说「已执行」而磁盘没变，是最坏的一种绿灯。
 *
 * 这组用例刻意绕过 C3 直接把方案喂给执行器，包括几条 C3 本来就会拦下的。
 * 那不是在测无效输入，是在证明**两层是独立的防线**：即使校验层被绕过、
 * 被改坏、或者哪天换了实现，执行层的类型检查和对账仍然拦得住。
 * 一条只在上游正确时才成立的防线，不叫防线。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".tmp-execute-test");

let current: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 把 fixture 复制成一个独立的、已提交的 git 仓库 */
function sandbox(fixture: string): string {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  current = dir;

  fs.cpSync(path.join(ROOT, "fixtures", fixture, "src"), path.join(dir, "src"), {
    recursive: true,
  });

  git(dir, ["init", "-q"]);
  git(dir, ["add", "-A"]);
  git(dir, [
    "-c",
    "user.email=eval@reposurgeon.local",
    "-c",
    "user.name=eval",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);

  return dir;
}

const exists = (dir: string, file: string) => fs.existsSync(path.join(dir, file));
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), "utf8");

afterEach(() => {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
});

/** src/dead.ts 两个导出全死、无人 import */
const deleteDeadFile: Proposal = {
  kind: "delete-file",
  targetFile: "src/dead.ts",
  targetSymbol: "unusedHelper",
  rationale: "整个文件的导出都没人用",
  operations: [{ op: "delete-file", file: "src/dead.ts", symbol: "" }],
  prediction: { exportsRemoved: 2, filesRemoved: 1 },
  risk: "low",
};

/** export const registered = register()：初始化有副作用，A2 不敢动 */
const deleteWithDependency: Proposal = {
  kind: "delete-with-dependencies",
  targetFile: "src/effects.ts",
  targetSymbol: "registered",
  rationale: "register 只往一个从没被读过的计数器里写",
  operations: [
    { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
    { op: "delete-declaration", file: "src/effects.ts", symbol: "register" },
  ],
  prediction: { exportsRemoved: 1, filesRemoved: 0 },
  risk: "high",
};

describe("applyProposal", () => {
  it("删整个文件：磁盘上真的没了，导出数与预测一致", async () => {
    const dir = sandbox("18-dead-exports");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: structuredClone(deleteDeadFile),
    });

    assert.equal(result.status, "applied", result.reason ?? "");
    assert.equal(result.typecheck?.introduced.length, 0);
    assert.equal(exists(dir, "src/dead.ts"), false);
    assert.equal(result.exports?.actual, result.exports?.predicted);
    assert.equal(result.exports?.before - result.exports?.actual, 2, "导出应当恰好少 2 个");
    assert.deepEqual(result.files, { predicted: 1, actual: 1, survived: [] });

    // 其它文件一个字节都不该动
    assert.equal(git(dir, ["status", "--porcelain", "--", "src/used.ts"]).trim(), "");
  });

  it("连带删除私有依赖：目标和依赖一起消失，同文件其它导出留着", async () => {
    const dir = sandbox("19-dead-export-removal");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: structuredClone(deleteWithDependency),
    });

    assert.equal(result.status, "applied", result.reason ?? "");

    const source = read(dir, "src/effects.ts");
    assert.equal(/\bregistered\b/.test(source), false, "registered 应已被删除");
    assert.equal(/function register\b/.test(source), false, "register 应已被连带删除");
    assert.match(source, /export const activeFlag/, "同文件的其它导出不该被牵连");
    assert.equal(result.exports?.before - result.exports?.actual, 1);
  });

  it("预测数字不对：改动整体还原，diff 留档", async () => {
    const dir = sandbox("18-dead-exports");
    const before = read(dir, "src/dead.ts");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      // 方案本身能执行，只是模型说会少 5 个导出，实际只会少 2 个
      proposal: {
        ...structuredClone(deleteDeadFile),
        prediction: { exportsRemoved: 5, filesRemoved: 1 },
      },
    });

    assert.equal(result.status, "rolled-back");
    assert.equal(exists(dir, "src/dead.ts"), true, "回滚后文件必须回来");
    assert.equal(read(dir, "src/dead.ts"), before);
    assert.match(result.reason ?? "", /不一致/);

    // 失败的那份 diff 恰恰最该留给人看：它说明工具想改什么、为什么判失败
    assert.ok(result.diffPath && fs.statSync(result.diffPath).size > 0);
    assert.match(fs.readFileSync(result.reportPath!, "utf8"), /改动已还原/);
  });

  it("文件数预测不对：导出数对得上也照样回滚", async () => {
    // 导出减少量是对的（2 个），只有 filesRemoved 说成了 2。
    // 单看导出对账这条会通过——**两个数字必须各自对账**，
    // 否则「删对了几个导出」就能掩盖「删错了几个文件」
    const dir = sandbox("18-dead-exports");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: {
        ...structuredClone(deleteDeadFile),
        prediction: { exportsRemoved: 2, filesRemoved: 2 },
      },
    });

    assert.equal(result.status, "rolled-back");
    assert.equal(result.exports?.actual, result.exports?.predicted, "导出这一项本身是对的");
    assert.match(result.reason ?? "", /实际删除 1 个文件，方案预测 2 个/);
    assert.equal(exists(dir, "src/dead.ts"), true, "回滚后文件必须回来");
  });

  it("会引入类型错误：一个字节都不写", async () => {
    // config.ts 被 index.ts import，删掉它 index.ts 立刻报错。
    // C3 本来就会拦下这条（入边不为 0），这里绕过它直接执行——
    // 证明执行层的类型检查是独立成立的，不依赖上游先拦一道
    const dir = sandbox("19-dead-export-removal");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: {
        kind: "delete-file",
        targetFile: "src/config.ts",
        targetSymbol: "internalPath",
        rationale: "看起来没人用",
        operations: [{ op: "delete-file", file: "src/config.ts", symbol: "" }],
        prediction: { exportsRemoved: 2, filesRemoved: 1 },
        risk: "low",
      },
    });

    assert.equal(result.status, "aborted");
    assert.ok((result.typecheck?.introduced.length ?? 0) > 0);
    assert.equal(exists(dir, "src/config.ts"), true);
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "工作区必须保持干净");
  });

  it("目标文件有未提交改动：拒绝执行，用户的改动原封不动", async () => {
    const dir = sandbox("18-dead-exports");
    const mine = "// 我正在写的东西\n";
    fs.appendFileSync(path.join(dir, "src/dead.ts"), mine);

    const { files, contents } = await scanFiles(dir);
    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: structuredClone(deleteDeadFile),
    });

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /未提交的改动/);
    assert.match(read(dir, "src/dead.ts"), /我正在写的东西/);
  });

  it("指令里的符号执行时已不存在：整条放弃，不留半条执行成功的方案", async () => {
    // 半条执行成功的方案，它的 prediction 就不再有任何意义——
    // 对账通过与否都说明不了问题，所以宁可整条放弃
    const dir = sandbox("19-dead-export-removal");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: {
        ...structuredClone(deleteWithDependency),
        operations: [
          { op: "delete-declaration", file: "src/effects.ts", symbol: "registered" },
          { op: "delete-declaration", file: "src/effects.ts", symbol: "neverExisted" },
        ],
      },
    });

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /neverExisted/);
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "", "工作区必须保持干净");
  });

  it("高风险方案的报告里写明「证明不了行为等价」", async () => {
    const dir = sandbox("19-dead-export-removal");
    const { files, contents } = await scanFiles(dir);

    const result = await applyProposal({
      root: dir,
      files,
      contents,
      proposal: structuredClone(deleteWithDependency),
    });

    assert.equal(result.status, "applied", result.reason ?? "");
    // 主动说出边界，比被问出来强得多
    assert.match(fs.readFileSync(result.reportPath!, "utf8"), /证明不了运行时行为等价/);
  });
});
