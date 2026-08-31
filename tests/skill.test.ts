import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildIndex, createTools } from "../src/tools.js";

/**
 * Skill 手册的一致性。
 *
 * 手册是写给模型看的操作说明，它不会被编译、不会被 lint，指向一个不存在的工具
 * 或写错一个命令名，只有等模型照着做失败了才会发现——而那时它已经在别人的
 * 编辑器里跑了。这几条断言把原本靠人工核对的部分固定下来。
 *
 * 另一半是可移植性：Skill 的真身放在中立的 `.agents/skills/`，各客户端目录
 * 用符号链接指过去。链接断了不会有任何报错，只是 Skill 悄悄不再被加载。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = "skills/frontend-repo-checkup";

/** 真身 + 两个客户端入口。Cursor 原生也认 `.agents/`，`.cursor/` 是给旧版本的保险 */
const HOSTS = [".agents", ".claude", ".cursor"];

const canonical = path.join(ROOT, ".agents", SKILL_DIR, "SKILL.md");
const manual = fs.readFileSync(canonical, "utf8");

/** MCP 侧额外注册的工具，不在 tools.ts 里 */
const MCP_ONLY = ["refreshIndex"];

describe("Skill 手册", () => {
  it("每个客户端路径都能读到同一份手册", () => {
    for (const host of HOSTS) {
      const entry = path.join(ROOT, host, SKILL_DIR, "SKILL.md");

      assert.ok(fs.existsSync(entry), `${host}/${SKILL_DIR} 不可达——符号链接可能断了`);
      assert.equal(fs.readFileSync(entry, "utf8"), manual, `${host} 读到的内容与真身不一致`);
    }
  });

  it("客户端目录是指向真身的符号链接，而不是副本", () => {
    for (const host of HOSTS.filter((h) => h !== ".agents")) {
      const entry = path.join(ROOT, host, SKILL_DIR);

      // 副本会漂移：改了一边忘了另一边，两个客户端行为就此分叉
      assert.ok(fs.lstatSync(entry).isSymbolicLink(), `${host}/${SKILL_DIR} 是副本，应当是符号链接`);

      // 相对链接才能跟着仓库走，绝对路径 clone 到别处就废了
      const target = fs.readlinkSync(entry);
      assert.ok(!path.isAbsolute(target), `${host} 的链接是绝对路径：${target}`);
      assert.equal(path.resolve(path.dirname(entry), target), path.join(ROOT, ".agents", SKILL_DIR));
    }
  });

  it("frontmatter 带上了触发所需的两个字段", () => {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(manual);
    assert.ok(frontmatter, "缺少 YAML frontmatter，任何客户端都不会加载它");

    const fields = Object.fromEntries(
      frontmatter[1]
        .split("\n")
        .map((line) => /^(\w+):\s*(.+)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => [match[1], match[2]]),
    );

    assert.ok(fields.name, "缺少 name");
    // description 是模型判断「要不要加载」的唯一依据，太短就等于没有触发条件
    assert.ok(fields.description?.length > 30, "description 太短，模型无从判断何时该用");
  });

  it("手册里调用的工具全部真实存在", async () => {
    const index = await buildIndex(path.join(ROOT, "fixtures/11-vite-alias"));
    const available = new Set([...Object.keys(createTools(index).tools), ...MCP_ONLY]);

    // 只抓 `工具名(` 这种明确的调用形态，避开正文里的普通反引号词
    const called = new Set(
      [...manual.matchAll(/`?\b([a-z][a-zA-Z]+)\(/g)]
        .map((match) => match[1])
        .filter((name) => !["function", "if", "for", "require"].includes(name)),
    );

    for (const name of called) {
      assert.ok(available.has(name), `手册调用了不存在的工具 ${name}()`);
    }

    // 反向：核心能力别在手册里漏掉
    assert.ok(called.size >= 3, "手册几乎没给出具体调用，等于没有可执行步骤");
  });

  it("手册里的 pnpm 命令全部在 package.json 里", () => {
    const scripts = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    for (const [, name] of manual.matchAll(/pnpm ([a-z][\w:]*)/g)) {
      assert.ok(name in scripts.scripts, `手册引用了不存在的命令 pnpm ${name}`);
    }
  });

  it("手册引用的文档都存在", () => {
    for (const [, doc] of manual.matchAll(/`(docs\/[\w.]+\.md)`/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, doc)), `手册引用了不存在的文档 ${doc}`);
    }
  });
});
