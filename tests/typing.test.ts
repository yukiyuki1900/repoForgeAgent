import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { calculateMetrics } from "../src/analyze/analyzers.js";
import type { FileNode, Language } from "../src/core/analysis.js";
import { isTyped } from "../src/scan/scanner.js";

/**
 * typing 维度的口径。
 *
 * ## 这组用例修的是一个「分数看起来很合理」的 bug
 *
 * 原本的判定是 `file.language.startsWith("ts")`，而 `.vue` 的 language 就是
 * `"vue"`——**一个 100% 用 `<script setup lang="ts">` 写的 Vue3 项目，
 * 每个 SFC 都被算成没有类型。**
 *
 * 它比崩溃难发现得多：程序不报错，报告照常生成，分数也是个合理的数字，
 * 只是**系统性地偏低**。没有任何信号提示你口径错了——除非你手算一遍。
 *
 * 这也是为什么最后那条端到端用例才是真正的回归测试：前面几条测的是
 * 判定函数本身，**只有它测的是「这个分数不会再算错」**。
 */
describe("typing 维度的判定口径", () => {
  it(".ts / .tsx 一律算有类型", () => {
    assert.equal(isTyped("ts", "export const a = 1"), true);
    assert.equal(isTyped("tsx", "export const A = () => null"), true);
  });

  it(".js / .jsx 一律算没类型", () => {
    // 就算里面全是 JSDoc 类型注解也不算。这个维度衡量的是「编译器能不能
    // 检查」，JSDoc 在没开 checkJs 的项目里不参与检查
    assert.equal(isTyped("js", "/** @type {number} */ const a = 1"), false);
    assert.equal(isTyped("jsx", "export default () => null"), false);
  });

  it('SFC 带 <script setup lang="ts"> 算有类型', () => {
    assert.equal(isTyped("vue", '<script setup lang="ts">\nconst a = 1\n</script>'), true);
  });

  it("属性顺序和引号都不固定，都要认", () => {
    // `<script lang='ts' setup>` 是完全合法的写法，正则写死顺序就会漏判
    assert.equal(isTyped("vue", "<script lang='ts' setup>\n</script>"), true);
    assert.equal(isTyped("vue", '<script lang="ts">\n</script>'), true);
  });

  it("SFC 不带 lang 就是没类型", () => {
    assert.equal(isTyped("vue", "<script setup>\nconst a = 1\n</script>"), false);
  });

  /**
   * 防正则误伤。
   *
   * `[^>]*` 把匹配限制在 script 开标签内部。少了它，模板里任何一处
   * `lang="ts"` 字样都会让整个文件被判成有类型——**而这种误判的方向
   * 是「分数偏高」，比偏低更危险。**
   */
  it('模板或字符串里出现 lang="ts" 字样不算', () => {
    const content = [
      "<template>",
      '  <code>lang="ts"</code>',
      "</template>",
      "<script>",
      "</script>",
    ].join("\n");
    assert.equal(isTyped("vue", content), false);
  });

  /**
   * 端到端：这条才是真正的回归测试。
   *
   * 修改之前，这个仓库的 typing 维度是 0——所有文件都是 `.vue`，
   * 而 `"vue".startsWith("ts")` 为假。
   */
  it("全是 TS 写的 Vue 仓库，typing 维度应该是满分", () => {
    const files = [
      fakeFile("src/App.vue", "vue", true),
      fakeFile("src/views/Home.vue", "vue", true),
      fakeFile("src/store/index.ts", "ts", true),
    ];

    const metrics = calculateMetrics(files, []);
    assert.equal(metrics.dimensions.typing, 100);
  });

  it('一半 SFC 没写 lang="ts" 时如实反映', () => {
    const files = [fakeFile("src/App.vue", "vue", true), fakeFile("src/Legacy.vue", "vue", false)];

    const metrics = calculateMetrics(files, []);
    assert.equal(metrics.dimensions.typing, 50);
  });
});

function fakeFile(filePath: string, language: Language, typed: boolean): FileNode {
  return {
    id: createHash("sha1").update(filePath).digest("hex"),
    path: filePath,
    language,
    typed,
    size: 100,
    contentHash: "x",
    lineCount: 10,
    // 复杂度固定为 1，让 typing 之外的维度不参与这组断言
    complexity: 1,
  };
}
