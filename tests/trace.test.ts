import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newTrace, parseTraceparent, shortTrace } from "../src/core/trace.js";

/**
 * W3C Trace Context。
 *
 * 这套东西**只服务于排障**——它是「用户报的编号」和「服务端日志」之间
 * 唯一的桥。所以它的正确性标准和业务代码不同：
 * **宁可生成一个新的，也绝不能因为它让请求失败。**
 */
describe("Trace Context", () => {
  const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("生成的 id 符合规范的长度与字符集", () => {
    const { traceId, spanId } = newTrace();
    assert.match(traceId, /^[0-9a-f]{32}$/, "trace-id 是 16 字节");
    assert.match(spanId, /^[0-9a-f]{16}$/, "span-id 是 8 字节");
  });

  it("两次生成不能撞", () => {
    assert.notEqual(newTrace().traceId, newTrace().traceId);
  });

  it("合法的 traceparent：trace-id 沿用，span-id 换新", () => {
    const parsed = parseTraceparent(VALID);

    // trace-id 全程不变，链路才连得起来
    assert.equal(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    // 收到的 span-id 是**对方**那一段，我们这一段必须新开一个
    assert.notEqual(parsed.spanId, "00f067aa0ba902b7");
    assert.match(parsed.spanId, /^[0-9a-f]{16}$/);
  });

  it("脏数据一律降级成新链路，绝不抛错", () => {
    // 这个头来自客户端，可能是任何东西——旧版本、代理改写、伪造。
    // 为一个只用于排障的字段让请求失败，是把手段当成了目的
    const bogus = [
      undefined,
      "",
      "garbage",
      "00-4bf92f35-00f067aa0ba902b7-01", // trace-id 长度不对
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01", // span-id 长度不对
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01", // 规范要求小写
      "4bf92f3577b34da6a3ce929d0e0e4736", // 只有 trace-id，没有分段
    ];

    for (const header of bogus) {
      const parsed = parseTraceparent(header);
      assert.match(parsed.traceId, /^[0-9a-f]{32}$/, `应降级成新链路：${String(header)}`);
      assert.notEqual(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    }
  });

  it("全 0 的 id 是规范里的「未知」占位，不能照单全收", () => {
    // 有些中间件在丢失上下文时会填全 0。收下它，所有这类请求会挤成同一条链路，
    // 而那正好等于没有链路
    const zeroTrace = parseTraceparent(`00-${"0".repeat(32)}-00f067aa0ba902b7-01`);
    assert.notEqual(zeroTrace.traceId, "0".repeat(32));

    const zeroSpan = parseTraceparent(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`);
    assert.notEqual(
      zeroSpan.traceId,
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "span 无效时整条都不可信",
    );
  });

  it("ff 是规范保留的无效版本号", () => {
    const parsed = parseTraceparent(VALID.replace(/^00/, "ff"));
    assert.notEqual(parsed.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("前后空白要容忍——代理加空格是常事", () => {
    assert.equal(parseTraceparent(`  ${VALID}  `).traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  });

  it("短号取前 8 位，够人在电话里念", () => {
    assert.equal(shortTrace("4bf92f3577b34da6a3ce929d0e0e4736"), "4bf92f35");
  });
});
