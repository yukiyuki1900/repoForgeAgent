import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkModelConfig, describeModelProblem } from "../src/agent/llm.js";

/**
 * 模型配置的自检。
 *
 * ## 这组用例是为一个真实的坑写的
 *
 * `OPENAI_BASE_URL` 和 `REPOSURGEON_MODEL` 在代码里是两个互相独立的可选项，
 * 在现实里却是**一对**：换网关必然换模型名。只配前者时，程序会拿着默认的
 * `gpt-4o-mini` 去请求 DeepSeek 的端点，拿回来一句「模型不存在」——
 * **而那句报错里没有任何东西指向真正的原因。**
 *
 * 这类 bug 的特征是：配置本身语法合法、每一项单独看都没问题、程序也照常
 * 启动，只在真正发请求时炸，且错误信息把人引向错误的方向（多数人会先去
 * 检查 API Key）。**能在启动路径上判定的错误，不该留到网络层去暴露。**
 *
 * ## 为什么测的是纯函数而不是 `resolveModel()`
 *
 * `resolveModel()` 读 `process.env`、构造 provider，验证它要来回改全局变量，
 * 用例之间还会互相污染。所以把「配置对不对」单独切成 `checkModelConfig(env)`：
 * 入参就是环境，出参就是结论，**一个专门用来报配置错误的函数，自己不该
 * 只能靠改全局状态来验证。**
 */
describe("模型配置自检", () => {
  it("没有 key 就是没配，这是允许的状态", () => {
    // 项目的核心承诺是「事实由确定性代码产出」，不配 LLM 也能跑完分析。
    // 所以缺 key 不是错误，只是「ask 用不了」
    assert.equal(checkModelConfig({}), "missing-key");
  });

  it("只配 key、走官方端点时，默认模型名是成立的", () => {
    assert.equal(checkModelConfig({ OPENAI_API_KEY: "sk-x" }), undefined);
  });

  it("配了非官方网关却没指定模型，判定为配置错误", () => {
    // 这一条就是那个坑本身：看起来配好了，实际配了一半
    assert.equal(
      checkModelConfig({ OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "https://api.deepseek.com/v1" }),
      "gateway-without-model",
    );
  });

  it("网关和模型名成对出现时放行", () => {
    assert.equal(
      checkModelConfig({
        OPENAI_API_KEY: "sk-x",
        OPENAI_BASE_URL: "https://api.deepseek.com/v1",
        REPOSURGEON_MODEL: "deepseek-chat",
      }),
      undefined,
    );
  });

  it("显式指向官方端点时不算网关，默认值仍然成立", () => {
    // 有人会把官方地址原样写进 .env（为了和别的环境保持同一份模板）。
    // 这不是「换了网关」，不该因此报错
    assert.equal(
      checkModelConfig({ OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "https://api.openai.com/v1" }),
      undefined,
    );
  });

  it("空字符串等于没配，不该被当成配了网关", () => {
    // `.env` 里留一行 `OPENAI_BASE_URL=` 是很常见的写法。
    // 若不 trim，它会被判成「配了一个空网关」，报一个用户完全看不懂的错
    assert.equal(
      checkModelConfig({ OPENAI_API_KEY: "sk-x", OPENAI_BASE_URL: "  ", REPOSURGEON_MODEL: "" }),
      undefined,
    );
  });

  /**
   * 两种问题的**修法不同**，所以文案必须不同。
   *
   * 压成同一句「模型未配置」的话，第二种情况下用户会去反复检查一个
   * 本来就没问题的 key——**错误信息把人引向错误的地方，比不报错更费时间。**
   */
  it("两类问题给出的是两种修法，不是同一句话", () => {
    const missing = describeModelProblem("missing-key");
    const halfway = describeModelProblem("gateway-without-model");

    assert.notEqual(missing, halfway);
    assert.match(missing, /OPENAI_API_KEY/);
    assert.match(halfway, /REPOSURGEON_MODEL/);
  });
});
