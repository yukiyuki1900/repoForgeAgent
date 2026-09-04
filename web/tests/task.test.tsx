import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { runTask, TaskCancelled, TaskDisconnected, type TaskEvent } from "../src/task.js";

/**
 * 任务客户端。
 *
 * 这一组用例测的全是**换掉 EventSource 才有的能力**：能看见状态码、
 * 能自己带请求头、能自己决定要不要重连。EventSource 时代这些全部做不到，
 * 所以也就没什么可测的——那本身就是「排障做不下去」的症状。
 */

interface Call {
  url: string;
  headers: Record<string, string>;
  method: string;
}

const encoder = new TextEncoder();

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sse(chunks: string[], traceId = "aaaabbbbccccddddeeeeffff00001111"): Response {
  return new Response(sseBody(chunks), {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Trace-Id": traceId },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Trace-Id": "aaaabbbbccccddddeeeeffff00001111",
    },
  });
}

const ACCEPTED = {
  taskId: "task-1",
  kind: "ask" as const,
  status: "running",
  statusUrl: "/tasks/task-1",
  eventsUrl: "/tasks/task-1/events",
  traceId: "aaaabbbbccccddddeeeeffff00001111",
};

const progress = (id: number, label: string): string =>
  `id: ${id}\nevent: progress\ndata: ${JSON.stringify({ at: "now", channel: "step", label })}\n\n`;
const DONE = `event: done\ndata: {}\n\n`;

/**
 * 按顺序回放预设响应，并记录每次请求。
 *
 * 响应工厂拿得到 `init`，因为**真实的 fetch 会在 abort 时让正在进行的
 * 读取失败**——不模拟这一点，「永不结束的流」在测试里就真的永不结束，
 * 用例挂起还会拖垮同文件的其它用例。
 */
function stubFetch(responses: Array<(init?: RequestInit) => Response>): Call[] {
  const calls: Call[] = [];
  let index = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next(init);
  }) as typeof fetch;

  return calls;
}

const realFetch = globalThis.fetch;
const realRandom = Math.random;

describe("任务客户端", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    Math.random = realRandom;
  });

  // 退避是「全抖动」，随机数固定成 0 就等于零延迟——
  // 这样测的还是真实的重试逻辑，只是不用真等十几秒
  const noBackoff = (): void => {
    Math.random = () => 0;
  };

  const collect = async (): Promise<{ events: TaskEvent[]; text: string }> => {
    const events: TaskEvent[] = [];
    let text = "";
    await runTask({
      url: "/ask",
      body: { root: "/tmp", question: "?" },
      onEvent: (event) => events.push(event),
      onText: (delta, replace) => {
        text = replace ? delta : text + delta;
      },
    });
    return { events, text };
  };

  it("每个请求都带 traceparent，格式符合 W3C 规范", async () => {
    const calls = stubFetch([
      () => json(ACCEPTED, 202),
      () => sse([progress(0, "唯一一步"), DONE]),
      () => json({ ...ACCEPTED, status: "completed", events: [] }),
    ]);

    await collect();

    // **这是 EventSource 物理上做不到的事**：它发不了任何自定义头，
    // 所以客户端的失败永远和服务端日志对不上号
    for (const call of calls) {
      assert.match(
        call.headers.traceparent,
        /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
        `${call.url} 少了合法的 traceparent`,
      );
    }
    // 同一次任务的三个请求必须属于同一条链路
    const traceIds = new Set(calls.map((c) => c.headers.traceparent.split("-")[1]));
    assert.equal(traceIds.size, 1, "trace-id 全程不变，链路才连得起来");
  });

  it("断在半路时用 Last-Event-ID 续传，而不是从头再来一遍", async () => {
    noBackoff();
    const calls = stubFetch([
      () => json(ACCEPTED, 202),
      // 第一次连接：发了两条就断了（流结束但没有 done）
      () => sse([progress(0, "第一步"), progress(1, "第二步")]),
      // 第二次连接：服务端按 Last-Event-ID 只补发之后的
      () => sse([progress(2, "第三步"), DONE]),
      () => json({ ...ACCEPTED, status: "completed", events: [] }),
    ]);

    const { events } = await collect();

    const reconnect = calls.find((c, i) => i > 1 && c.url.includes("/events"));
    assert.equal(reconnect?.headers["Last-Event-ID"], "1", "重连必须带上最后收到的编号");
    assert.deepEqual(
      events.map((e) => e.label),
      ["第一步", "第二步", "第三步"],
      "续传的结果应该是一条完整时间线，不重不漏",
    );
  });

  it("重试没有意义的失败立刻放手，不做无谓重连", async () => {
    noBackoff();
    // 404 = 任务不存在（多半是服务端重启了），重连一万次也一样。
    // **EventSource 会对着它一遍遍重连到天荒地老**，因为它看不见状态码
    const calls = stubFetch([
      () => json(ACCEPTED, 202),
      () => json({ error: "task not found" }, 404),
    ]);

    await assert.rejects(collect(), (error: Error) => {
      assert.ok(error instanceof TaskDisconnected);
      assert.match(error.message, /task not found/, "要把服务端给的真实原因带出来");
      return true;
    });

    assert.equal(calls.length, 2, "不该有第三次请求");
  });

  it("可以重试的失败会重连，并且最终能成功", async () => {
    noBackoff();
    const calls = stubFetch([
      () => json(ACCEPTED, 202),
      () => json({ error: "boom" }, 500),
      () => json({ error: "boom" }, 500),
      () => sse([progress(0, "终于连上了"), DONE]),
      () => json({ ...ACCEPTED, status: "completed", events: [] }),
    ]);

    const { events } = await collect();

    assert.deepEqual(
      events.map((e) => e.label),
      ["终于连上了"],
    );
    assert.equal(calls.length, 5);
  });

  it("连续失败到上限就放弃，并且说明任务仍在后台", async () => {
    noBackoff();
    const calls = stubFetch([() => json(ACCEPTED, 202), () => json({ error: "boom" }, 503)]);

    await assert.rejects(collect(), (error: Error) => {
      assert.ok(error instanceof TaskDisconnected);
      // 这句措辞是产品决定：连接断了 ≠ 任务失败，不该诱导用户重试
      assert.match(error.message, /仍在后台继续/);
      return true;
    });

    // 1 次提交 + 1 次首连 + 5 次重连
    assert.equal(calls.length, 7, `重连次数应为上限值，实际 ${calls.length - 2}`);
  });

  it("错误信息里带排障编号，用户报得出来", async () => {
    noBackoff();
    stubFetch([() => json(ACCEPTED, 202), () => json({ error: "task not found" }, 404)]);

    await assert.rejects(collect(), (error: Error) => {
      // 取服务端回的 X-Trace-Id 的前 8 位。没有这个，用户说「我卡住了」
      // 在日志里对应不到任何东西
      assert.match(error.message, /编号 aaaabbbb/);
      return true;
    });
  });

  it("提交阶段就失败时，编号取服务端响应头上的那个", async () => {
    // 这条和上一条走的是**两条不同的路**：上一条的编号来自受理响应体，
    // 而提交都没成功的时候那个响应体压根不存在，只能从响应头拿。
    // 变异测试抓到过：把 requestFailed 的编号去掉，上一条照样绿
    stubFetch([() => json({ error: "root is required" }, 400)]);

    await assert.rejects(collect(), (error: Error) => {
      assert.match(error.message, /root is required/);
      assert.match(error.message, /编号 aaaabbbb/, "提交失败也必须能报编号");
      return true;
    });
  });

  it("断了又连上就重新计数——只有连续失败才该放弃", async () => {
    noBackoff();
    // 一个跑了十分钟、中间断过六次但每次都续上的任务是**健康的**。
    // 按累计次数算的话，它会在第六次断开时被判死，而那时它明明一直在推进
    const flaky = Array.from({ length: 6 }, (_, i) => () => sse([progress(i, `第 ${i} 步`)]));
    const calls = stubFetch([
      () => json(ACCEPTED, 202),
      ...flaky,
      () => sse([DONE]),
      () => json({ ...ACCEPTED, status: "completed", events: [] }),
    ]);

    const { events } = await collect();

    assert.equal(events.length, 6, "六次断连的进度都要留下");
    assert.equal(calls.length, 9, "1 提交 + 6 次断掉的连接 + 1 次收尾 + 1 次拉状态");
  });

  it("用户取消时，会真的通知服务端，而不只是不看了", async () => {
    const controller = new AbortController();
    const calls = stubFetch([
      () => json(ACCEPTED, 202),
      (init) => {
        // 连上之后立刻取消
        queueMicrotask(() => controller.abort());
        return new Response(
          new ReadableStream({
            start(stream) {
              // 模拟真实 fetch：abort 时正在进行的读取会失败
              init?.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), {
                once: true,
              });
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
      () => json({ status: "cancelled" }),
    ]);

    await assert.rejects(
      runTask({
        url: "/ask",
        body: {},
        onEvent: () => {},
        signal: controller.signal,
      }),
      (error: Error) => error instanceof TaskCancelled,
    );

    const cancel = calls.find((c) => c.url.includes("/cancel"));
    assert.ok(cancel, "必须调 cancel 接口——关掉连接只是「不看了」，后台照跑照烧 token");
    assert.equal(cancel?.method, "POST");
  });

  it("重连时把已经生成的回答全量补齐，而不是接在旧文本后面", async () => {
    noBackoff();
    stubFetch([
      () => json(ACCEPTED, 202),
      () => sse([`event: delta\ndata: ${JSON.stringify({ delta: "已经写" })}\n\n`]),
      () =>
        sse([
          `event: delta\ndata: ${JSON.stringify({ delta: "已经写了一半", replace: true })}\n\n`,
          DONE,
        ]),
      () => json({ ...ACCEPTED, status: "completed", events: [] }),
    ]);

    const { text } = await collect();

    // 事件靠序号增量续传，文本靠全量替换——两种数据特征不同，策略也不同。
    // 接错了的表现是「已经写已经写了一半」
    assert.equal(text, "已经写了一半");
  });
});
