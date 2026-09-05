import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { applyDeadExportRemoval } from "../src/refactor/prune.js";
import { scanFiles } from "../src/scan/scanner.js";

/**
 * 死导出清理的端到端验证。
 *
 * 判定已经由 `fixtures/19-dead-export-removal` 覆盖，这里证明的是另一件事：
 * **删除真的落到了磁盘上、有副作用的声明真的没被碰、对账不上真的会还原**。
 *
 * 和 `apply.test.ts` 同构——两条改造链路共用一副验证骨架，
 * 测试也就该长得一样。不一样的只有第二层验证拿什么对账：
 * 那边是环数，这边是导出总数。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".tmp-prune-test");
const FIXTURE = "19-dead-export-removal";

let current: string | undefined;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 把 fixture 复制成一个独立的、已提交的 git 仓库 */
function sandbox(): string {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  current = dir;

  fs.cpSync(path.join(ROOT, "fixtures", FIXTURE, "src"), path.join(dir, "src"), {
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

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), "utf8");

afterEach(() => {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
});

describe("applyDeadExportRemoval", () => {
  it("两种改法各自落盘，导出总数与预测一致", async () => {
    const dir = sandbox();
    const { files, contents } = await scanFiles(dir);

    const result = await applyDeadExportRemoval({ root: dir, files, contents });

    assert.equal(result.status, "applied", result.reason ?? "");
    assert.equal(result.edits.length, 3);
    assert.equal(result.typecheck?.introduced.length, 0);
    assert.deepEqual(result.exports, { before: 9, predicted: 6, actual: 6 });

    // ── 断言磁盘，不是返回值 ──────────────────────────

    // 整条删除：deadHelper 连函数体一起消失，activeHelper 原样保留
    const utils = read(dir, "src/utils.ts");
    assert.doesNotMatch(utils, /deadHelper/);
    assert.match(utils, /export function activeHelper\(\): string \{/);

    // 去掉 export（变量分支）：声明还在、初始值还在，只是不再导出
    const config = read(dir, "src/config.ts");
    assert.match(config, /^const internalPath = "\/api";$/m);
    assert.doesNotMatch(config, /export const internalPath/);
    assert.match(config, /export function readConfig\(\): string \{/);
    assert.match(config, /return internalPath;/);

    // 去掉 export（函数声明分支）：函数体一字不动
    const format = read(dir, "src/format.ts");
    assert.match(format, /^function pad\(value: string\): string \{$/m);
    assert.doesNotMatch(format, /export function pad/);
    assert.match(format, /return ` \$\{value\} `;/);
    assert.match(format, /export function render\(value: string\): string \{/);

    // 有副作用的初始化一个字节都不能动
    assert.equal(
      read(dir, "src/effects.ts"),
      "let counter = 0;\n\nfunction register(): number {\n  counter += 1;\n  return counter;\n}\n\n// 没有外部引用者，但初始化表达式是函数调用 —— 删掉就少执行一次 register()\nexport const registered = register();\n\nexport const activeFlag = true;\n",
    );

    // 产物落盘
    assert.ok(result.diffPath && fs.existsSync(result.diffPath));
    assert.match(fs.readFileSync(result.diffPath, "utf8"), /-export function deadHelper/);
    assert.ok(result.reportPath && fs.existsSync(result.reportPath));
  });

  it("拒绝删除初始化有副作用的导出，并说明原因", async () => {
    const dir = sandbox();
    const { files, contents } = await scanFiles(dir);

    const result = await applyDeadExportRemoval({ root: dir, files, contents });

    const blocked = result.skipped.find((item) => item.symbol === "registered");
    assert.ok(blocked, "registered 必须出现在被拒绝的列表里");
    assert.match(blocked.reason, /副作用/);
  });

  it("预测与实测对不上时还原改动，但保留 diff", async () => {
    const dir = sandbox();
    const scanned = await scanFiles(dir);

    // 从输入里藏掉一个文件：计划只看得到 7 个导出，实测扫描却是 9 个。
    // 改动本身完全正确，但预测的基数是错的——正是「预测与现实脱节」该被拦下的形态
    const files = scanned.files.filter((file) => file.path !== "src/effects.ts");

    const before = read(dir, "src/utils.ts");
    const result = await applyDeadExportRemoval({ root: dir, files, contents: scanned.contents });

    assert.equal(result.status, "rolled-back");
    assert.equal(result.exports?.predicted, 4);
    assert.equal(result.exports?.actual, 6);

    // 磁盘必须回到改动前
    assert.equal(read(dir, "src/utils.ts"), before);
    assert.equal(git(dir, ["status", "--porcelain", "--", "src"]).trim(), "");

    // 但改了什么要留档，否则人工无从复盘
    assert.ok(result.diffPath);
    assert.match(fs.readFileSync(result.diffPath, "utf8"), /-export function deadHelper/);
  });

  it("目标文件有未提交改动时拒绝写入", async () => {
    const dir = sandbox();
    const target = path.join(dir, "src/utils.ts");
    fs.appendFileSync(target, "\n// 本地未提交的改动\n");
    const dirty = fs.readFileSync(target, "utf8");

    const { files, contents } = await scanFiles(dir);
    const result = await applyDeadExportRemoval({ root: dir, files, contents });

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /未提交/);
    assert.equal(fs.readFileSync(target, "utf8"), dirty);
  });

  it("目标文件不受 git 跟踪时拒绝写入", async () => {
    const dir = sandbox();
    // 没有 `git checkout --` 可用，也就没有回滚保证
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    const before = read(dir, "src/utils.ts");

    const { files, contents } = await scanFiles(dir);
    const result = await applyDeadExportRemoval({ root: dir, files, contents });

    assert.equal(result.status, "aborted");
    assert.match(result.reason ?? "", /git/);
    assert.equal(read(dir, "src/utils.ts"), before);
  });
});
