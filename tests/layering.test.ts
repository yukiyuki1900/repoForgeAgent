import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * 分层约束。
 *
 * `src/` 原来是 36 个文件平铺在一级目录里。这个项目本身干的就是「发现
 * 仓库结构问题」，自己的源码却没有可见的结构——**这条测试是为了让新的
 * 结构不退化**。
 *
 * 目录顺序就是依赖方向，**只能自上而下**：
 *
 * ```
 * core      跨切面基础与共享类型（无领域知识）
 *   ↓
 * scan      从磁盘到语义图
 *   ↓
 * analyze   只读分析
 *   ↓
 * agent     模型与工具
 *   ↓
 * refactor  改造与验证
 *   ↓
 * report / task
 *   ↓
 * 根目录     三个入口 + 顶层编排
 * ```
 *
 * 没有这条测试的话，分层只是一次性的整理：**下一个人加一行 import
 * 就能把它破坏掉，而没有任何东西会因此变红**——这正是循环依赖长出来的
 * 方式，也是这个项目在别人仓库里天天检出的那种问题。
 */
const LAYERS = ["core", "scan", "analyze", "agent", "refactor", "report", "task", ""] as const;

/** 越靠后越上层。根目录（空串）在最顶上，谁都可以依赖它下面的 */
const rank = (layer: string): number => LAYERS.indexOf(layer as (typeof LAYERS)[number]);

interface Edge {
  from: string;
  to: string;
  fromLayer: string;
  toLayer: string;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const layerOf = (file: string): string => {
  const dir = path.dirname(file);
  return dir === SRC ? "" : path.relative(SRC, dir);
};

function edges(): Edge[] {
  const found: Edge[] = [];
  for (const file of sourceFiles(SRC)) {
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(/from "(\.[^"]+)\.js"/g)) {
      const target = path.resolve(path.dirname(file), `${match[1]}.ts`);
      found.push({
        from: path.relative(SRC, file),
        to: path.relative(SRC, target),
        fromLayer: layerOf(file),
        toLayer: layerOf(target),
      });
    }
  }
  return found;
}

describe("src 的分层", () => {
  it("每个文件都落在已知的层里", () => {
    // 新建一个目录却不登记，分层检查就会静默漏掉它——
    // 那时这条测试还是绿的，但已经不保护任何东西了
    const unknown = sourceFiles(SRC)
      .map(layerOf)
      .filter((layer) => rank(layer) === -1);

    assert.deepEqual([...new Set(unknown)], [], "有目录不在 LAYERS 里，先决定它属于哪一层");
  });

  it("依赖只能自上而下，不能反向", () => {
    const violations = edges()
      .filter((edge) => edge.fromLayer !== edge.toLayer)
      .filter((edge) => rank(edge.toLayer) >= rank(edge.fromLayer))
      .map(
        (edge) =>
          `${edge.from} → ${edge.to}（${edge.fromLayer || "根"} 依赖了更上层的 ${edge.toLayer || "根"}）`,
      );

    assert.deepEqual(violations, [], "反向依赖会长成循环依赖");
  });

  it("入口和顶层编排之外，根目录不该再放文件", () => {
    // 根目录是最容易变回垃圾场的地方：谁都能往里扔一个「暂时不知道
    // 放哪」的文件，扔够十个就退回原样了
    const atRoot = sourceFiles(SRC)
      .filter((file) => path.dirname(file) === SRC)
      .map((file) => path.basename(file))
      .sort();

    assert.deepEqual(atRoot, ["api.ts", "cli.ts", "mcp.ts", "workflow.ts"]);
  });

  it("core 不依赖任何其它层——它是底座", () => {
    // core 一旦反向依赖，整个方向感就没了
    const leaked = edges()
      .filter((edge) => edge.fromLayer === "core" && edge.toLayer !== "core")
      .map((edge) => `${edge.from} → ${edge.to}`);

    assert.deepEqual(leaked, [], "core 里的东西不该知道领域逻辑");
  });
});
