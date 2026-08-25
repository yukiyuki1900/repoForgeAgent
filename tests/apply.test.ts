import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { analyzeCycles } from "../src/analyzers.js";
import { applyTypeOnlyRefactor } from "../src/apply.js";
import { extractGraph } from "../src/graph.js";
import { scanFiles } from "../src/scanner.js";

/**
 * `--apply` 的端到端验证。
 *
 * dry-run 的判定已经由 fixtures 覆盖，这里要证明的是另一件事：
 * **写入真的发生了、验证真的会拦、回滚真的能还原**。
 * 所以每个用例都建一个真的 git 仓库，跑完再读回文件内容对账，
 * 而不是断言函数的返回值——返回值说「已应用」而磁盘没变，是最坏的一种绿灯。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".tmp-apply-test");

let current: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 把某个 fixture 复制成一个独立的、已提交的 git 仓库 */
function sandboxFrom(fixture: string): string {
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

async function analyze(root: string) {
  const { files, contents } = await scanFiles(root);
  const { edges } = extractGraph(root, files, contents);
  return { root, files, contents, edges, cycles: analyzeCycles(files, edges) };
}

afterEach(() => {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
});

describe("applyTypeOnlyRefactor", () => {
  it("纯类型环：写入磁盘，环归零", async () => {
    const dir = sandboxFrom("13-type-only-cycle");
    const input = await analyze(dir);
    assert.equal(input.cycles.length, 1, "前置条件：fixture 必须有一个环");

    const result = await applyTypeOnlyRefactor(input);

    assert.equal(result.status, "applied", result.reason ?? "");
    assert.equal(result.edits.length, 2);
    assert.equal(result.typecheck?.introduced.length, 0);
    assert.deepEqual(result.cycles, { before: 1, predicted: 0, actual: 0 });

    // 断言磁盘而不是返回值
    const order = fs.readFileSync(path.join(dir, "src/order.ts"), "utf8");
    const cart = fs.readFileSync(path.join(dir, "src/cart.ts"), "utf8");
    assert.match(order, /^import type \{ Cart \} from "\.\/cart";$/m);
    assert.match(cart, /^import type \{ Order \} from "\.\/order";$/m);

    // 只动 import 那一行，函数体原样保留
    assert.match(order, /export function createOrder\(cart: Cart\): Order \{/);

    // 产物落盘且 diff 非空
    assert.ok(result.diffPath && fs.existsSync(result.diffPath));
    assert.match(fs.readFileSync(result.diffPath, "utf8"), /^\+import type \{ Cart \}/m);
    assert.ok(result.reportPath && fs.existsSync(result.reportPath));

    // 重跑一次分析，环确实没了
    const again = await analyze(dir);
    assert.equal(again.cycles.length, 0);
  });

  it("模拟与实测对不上时还原改动，但保留 diff", async () => {
    const dir = sandboxFrom("13-type-only-cycle");
    const input = await analyze(dir);
    const order = input.files.find((file) => file.path === "src/order.ts")!;
    const cart = input.files.find((file) => file.path === "src/cart.ts")!;

    // 伪造两条源码里并不存在的边。改造删不掉它们，模拟就会预测「环还在」，
    // 而磁盘上的实测结果是 0 个环——正是「预测与现实脱节」该被拦下的形态
    const ghost = { line: 99 };
    const edges = [
      ...input.edges,
      {
        from: order.id,
        to: cart.id,
        kind: "import" as const,
        location: { file: order.path, ...ghost },
      },
      {
        from: cart.id,
        to: order.id,
        kind: "import" as const,
        location: { file: cart.path, ...ghost },
      },
    ];

    const before = fs.readFileSync(path.join(dir, "src/order.ts"), "utf8");
    const result = await applyTypeOnlyRefactor({ ...input, edges });

    assert.equal(result.status, "rolled-back");
    assert.equal(result.cycles?.predicted, 1);
    assert.equal(result.cycles?.actual, 0);

    // 磁盘必须回到改动前
    assert.equal(fs.readFileSync(path.join(dir, "src/order.ts"), "utf8"), before);
    assert.equal(git(dir, ["status", "--porcelain", "--", "src"]).trim(), "");

    // 但改了什么要留档，否则人工无从复盘
    assert.ok(result.diffPath);
    assert.match(fs.readFileSync(result.diffPath, "utf8"), /\+import type \{ Cart \}/);
  });

  it("运行时环：没有可拆的边，不写任何文件", async () => {
    const dir = sandboxFrom("14-runtime-cycle");
    const before = fs.readFileSync(path.join(dir, "src/order.ts"), "utf8");

    const result = await applyTypeOnlyRefactor(await analyze(dir));

    assert.equal(result.status, "no-op");
    assert.equal(result.edits.length, 0);
    assert.equal(fs.readFileSync(path.join(dir, "src/order.ts"), "utf8"), before);
    assert.equal(git(dir, ["status", "--porcelain"]).trim(), "");
  });

  it("目标文件有未提交改动时拒绝写入", async () => {
    const dir = sandboxFrom("13-type-only-cycle");
    const target = path.join(dir, "src/order.ts");
    fs.appendFileSync(target, "\n// 本地未提交的改动\n");
    const dirty = fs.readFileSync(target, "utf8");

    const result = await applyTypeOnlyRefactor(await analyze(dir));

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /未提交/);
    // 用户的改动必须原封不动
    assert.equal(fs.readFileSync(target, "utf8"), dirty);
  });

  it("目标文件不受 git 跟踪时拒绝写入", async () => {
    const dir = sandboxFrom("13-type-only-cycle");
    // 去掉自己的 .git 之后，这些文件对任何仓库来说都是 untracked，
    // 没有 `git checkout --` 可用，也就没有回滚保证
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    const before = fs.readFileSync(path.join(dir, "src/order.ts"), "utf8");

    const result = await applyTypeOnlyRefactor(await analyze(dir));

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /git/);
    assert.equal(fs.readFileSync(path.join(dir, "src/order.ts"), "utf8"), before);
  });
});
