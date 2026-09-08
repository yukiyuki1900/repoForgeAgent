import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 文档和代码的一致性。
 *
 * ## 为什么这件事需要测试
 *
 * 文档腐坏是**静默的**：源码目录重构之后，`docs/ARCHITECTURE.md` 里那棵结构树
 * 立刻就成了一张错的地图，但没有任何东西会报错——CI 全绿、类型检查通过、所有用例
 * 都在跑。它唯一的表现是**下一个人照着它找 `src/tasks.ts`，扑了个空**。
 *
 * 这次人工核对时，实际找到的正是这一类：结构树停在目录重构之前，8 个文件
 * 从来没被列进去过，还有一条指向 `../src/tasks.ts` 的死链。**它们已经错了
 * 很久，而没有任何一次提交因此变红。**
 *
 * ## 为什么只测这三件事
 *
 * 判据是**能不能机器判定、会不会误报**。「README 讲得清不清楚」测不了；
 * 而「链接指向的文件在不在」「结构树和磁盘一不一致」「文档里的命令在不在
 * package.json 里」这三件，答案是唯一的，改错了必然红。
 *
 * 反过来，**刻意不测的**：文档里的数字（「9 个只读工具」）、示例输出、
 * 措辞。它们要么依赖运行结果，要么正常演进就会变——**为它们写断言，
 * 换来的是每次改文档都要改测试，那种测试最后一定被注释掉。**
 *
 * ## 三条都验证过真的会红
 *
 * 一组永远绿的检查等于没有检查，而这类「扫描 + 比对」的用例**特别容易
 * 写成永远绿的**：正则没匹配上、目录走错、集合是空的——每一种都表现为
 * 「没找到问题」。所以三条断言分别注入过一次真实破坏：
 *
 * ```
 * 往 LIMITATIONS.md 加一条指向不存在文件的链接   → 红
 * 从结构树里删掉 history.ts 那一行                → 红
 * 往文档里写一句 pnpm nonexistent-script          → 红
 * 全部还原                                        → 绿
 * ```
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 不进这些目录：依赖、构建产物、git worktree 拷贝 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".worktrees",
  "coverage",
  ".reposurgeon",
]);

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(path.join(dir, entry.name), accept));
    } else if (accept(entry.name)) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

const markdownFiles = walk(ROOT, (name) => name.endsWith(".md"));

describe("文档与代码的一致性", () => {
  /**
   * 死链是文档里**最廉价也最伤人**的一类错：读者点过去扑空，
   * 而写的人永远不会知道——他自己不会去点自己刚写的链接。
   */
  it("文档里的相对链接都指向真实存在的文件", () => {
    const broken: string[] = [];

    for (const file of markdownFiles) {
      const content = fs.readFileSync(file, "utf8");
      // 只查相对链接。http(s) 要联网、纯锚点是页内跳转，都不是这一层的事
      for (const match of content.matchAll(/\[[^\]]*\]\((\.{1,2}\/[^)#\s]+)/g)) {
        const target = path.resolve(path.dirname(file), match[1]);
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(ROOT, file)} → ${match[1]}`);
        }
      }
    }

    assert.deepEqual(broken, [], `有链接指向了不存在的文件：\n${broken.join("\n")}`);
  });

  /**
   * 源码结构树是**新人读代码的第一张地图**。
   *
   * 它和别的文档段落不一样：措辞过时只是不够好，而地图过时是**把人带到
   * 错的地方**。所以这一条卡得最死——双向断言，多列一个文件和少列一个
   * 文件同样算错。
   *
   * 多列出来的通常是删掉的文件（读者会去找一个不存在的东西），
   * 少列的通常是新加的目录（读者以为项目里没有这一块）。
   *
   * **这棵树原本在 README 里。** README 收窄成「项目介绍 + 使用方法」之后
   * 它迁到了 `docs/ARCHITECTURE.md`——检查跟着搬家，而不是趁机取消。
   * 一个因为文件挪了位置就被删掉的检查，等于承认它本来就没在守什么。
   */
  it("源码结构树和磁盘上的文件完全一致", () => {
    const doc = path.join(ROOT, "docs", "ARCHITECTURE.md");
    assert.ok(fs.existsSync(doc), "docs/ARCHITECTURE.md 不见了——源码结构树就住在这里");

    const content = fs.readFileSync(doc, "utf8");

    // 结构树是那个以 `src/` 开头的代码块。用内容特征定位而不是数第几个块——
    // 后者会在任何人往前面插一段示例时静默失效
    const block = content.match(/```\r?\nsrc\/\r?\n([\s\S]*?)```/);
    assert.ok(block, "找不到源码结构树——它是新人读代码的第一张地图，不该被删掉");

    const listed = new Set(block[1].match(/[\w.-]+\.tsx?/g) ?? []);
    const actual = new Set(
      [
        ...walk(path.join(ROOT, "src"), (name) => name.endsWith(".ts")),
        ...walk(path.join(ROOT, "web", "src"), (name) => /\.tsx?$/.test(name)),
      ].map((file) => path.basename(file)),
    );

    const missing = [...actual].filter((name) => !listed.has(name)).sort();
    const stale = [...listed].filter((name) => !actual.has(name)).sort();

    assert.deepEqual(missing, [], `这些文件在磁盘上，但结构树没列：${missing.join(", ")}`);
    assert.deepEqual(stale, [], `结构树列了这些文件，但磁盘上没有：${stale.join(", ")}`);
  });

  /**
   * 文档里的命令是**用户第一件会照抄的东西**。
   *
   * 脚本改名或删掉时，文档里那行 `pnpm xxx` 不会跟着变——用户复制粘贴，
   * 拿到的是一句 `Command "xxx" not found`。**第一条命令就跑不通的项目，
   * 没人会读到第二段。**
   */
  it("文档里出现的 pnpm 脚本都在 package.json 里", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const scripts = new Set(Object.keys(pkg.scripts));
    // pnpm 自带的子命令不是脚本，它们永远存在
    const builtin = new Set([
      "install",
      "add",
      "remove",
      "update",
      "rebuild",
      "run",
      "exec",
      "dlx",
      "why",
      "list",
      "link",
      "test",
      "start",
    ]);

    // 占位符统一写成尖括号形式（`pnpm <script>`）：那不是一条能跑的命令，
    // 不该被当成脚本名来查。**这条约定是被这个检查自己逼出来的**——
    // 它第一次跑起来就抓到了 README 里一句 `pnpm xxx` 的占位写法
    const unknown = new Set<string>();
    for (const file of markdownFiles) {
      const content = fs.readFileSync(file, "utf8");
      for (const match of content.matchAll(/\bpnpm (?:--dir \S+ )?([a-z][\w:-]*)/g)) {
        const name = match[1];
        if (!scripts.has(name) && !builtin.has(name)) {
          unknown.add(`${path.relative(ROOT, file)}: pnpm ${name}`);
        }
      }
    }

    assert.deepEqual(
      [...unknown].sort(),
      [],
      `文档里的这些命令在 package.json 里不存在：\n${[...unknown].join("\n")}`,
    );
  });
});
