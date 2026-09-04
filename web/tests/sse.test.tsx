import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSseParser, readSseFrames } from "../src/sse.js";

/**
 * 帧解析。
 *
 * 换掉 EventSource 之后，分帧成了我们自己的责任——**而这正是自己实现
 * 最容易出事的地方**：漏了的表现是「偶发丢事件」或者 JSON.parse 报错，
 * 而且只在网络慢、包被切碎的时候出现，本地永远复现不了。
 *
 * 所以解析器被单独拎出来做成纯函数：可以用任意刁钻的切分方式喂它，
 * 不需要真起一个服务端。
 */
describe("SSE 帧解析", () => {
  const frame = (id: number, event: string, data: unknown): string =>
    `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  it("一次喂进多个完整帧", () => {
    const parse = createSseParser();
    const frames = parse(
      frame(0, "progress", { label: "第一步" }) + frame(1, "progress", { label: "第二步" }),
    );

    assert.equal(frames.length, 2);
    assert.deepEqual(
      frames.map((f) => f.id),
      ["0", "1"],
    );
    assert.equal(JSON.parse(frames[0].data).label, "第一步");
  });

  it("一个帧被切成任意多块也要拼得回来", () => {
    // TCP 想在哪儿切就在哪儿切。逐字符喂是最狠的一种切法：
    // 如果实现是「按 chunk 找空行」而不是「累积缓冲」，这条必挂
    const whole = frame(0, "progress", { label: "被切碎的一步" });
    const parse = createSseParser();

    const collected = [...whole].flatMap((char) => parse(char));

    assert.equal(collected.length, 1, "无论切多碎，凑齐了才该吐出一帧");
    assert.equal(JSON.parse(collected[0].data).label, "被切碎的一步");
  });

  it("没凑齐的部分要留在缓冲里，不能当成完整帧吐出去", () => {
    const parse = createSseParser();
    assert.deepEqual(parse('id: 0\nevent: progress\ndata: {"label":"半'), []);
    // 补齐后才出来，而且内容完整
    const frames = parse('截"}\n\n');
    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].data).label, "半截");
  });

  it("多行 data 按规范用换行拼接，不是只取第一行", () => {
    const parse = createSseParser();
    const [only] = parse("data: 第一行\ndata: 第二行\n\n");
    assert.equal(only.data, "第一行\n第二行");
  });

  it("注释行不产生事件", () => {
    // `: ping` 这种保活注释浏览器会吞掉、JS 侧感知不到——
    // 这也正是我们的心跳发成具名事件而不是注释行的原因
    const parse = createSseParser();
    assert.deepEqual(parse(": keep-alive\n\n"), []);
    assert.equal(parse(": 注释\ndata: 真数据\n\n").length, 1);
  });

  it("兼容 CRLF，也兼容 event 省略时默认为 message", () => {
    const parse = createSseParser();
    const [only] = parse("data: 裸数据\r\n\r\n");
    assert.equal(only.event, "message", "SSE 规范规定省略 event 时是 message");
    assert.equal(only.data, "裸数据");
  });

  it("冒号后只去掉一个空格，多余的空格属于数据", () => {
    const parse = createSseParser();
    const [only] = parse("data:  两个空格开头\n\n");
    assert.equal(only.data, " 两个空格开头");
  });

  it("心跳这类不带 id 的帧，id 是 undefined 而不是空串", () => {
    // 前端拿它去更新 lastEventId，空串会让重连时的 Last-Event-ID 变成 ""，
    // 服务端解析不出就从头补——表现是「重连后事件翻倍」
    const parse = createSseParser();
    const [ping] = parse("event: ping\ndata: {}\n\n");
    assert.equal(ping.id, undefined);
  });

  it("含 NUL 的 id 按规范必须忽略", () => {
    // 这个 id 会被前端存下来、下次重连当 Last-Event-ID 发回去。
    // 收下一个含 NUL 的值，等于让服务端拿脏数据去切事件数组
    const parse = createSseParser();
    const [only] = parse("id: 3\u00004\ndata: 正常数据\n\n");
    assert.equal(only.id, undefined, "脏 id 该丢掉，但帧本身还要照常投递");
    assert.equal(only.data, "正常数据");
  });

  it("多字节字符被从中间劈开也不能变成乱码", async () => {
    // 事件标签全是中文，一个汉字 3 个字节。TextDecoder 不开 stream 模式的话，
    // 每个分块边界都可能吐出替换字符——而这只在特定长度下才复现
    const payload = new TextEncoder().encode(frame(0, "progress", { label: "循环依赖" }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // 在汉字中间切开
        controller.enqueue(payload.slice(0, 40));
        controller.enqueue(payload.slice(40, 41));
        controller.enqueue(payload.slice(41));
        controller.close();
      },
    });

    const frames = [];
    for await (const f of readSseFrames(body)) frames.push(f);

    assert.equal(frames.length, 1);
    assert.equal(JSON.parse(frames[0].data).label, "循环依赖");
  });
});
