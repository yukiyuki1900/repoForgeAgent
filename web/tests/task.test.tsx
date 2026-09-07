import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  describeConnection,
  runTask,
  TaskCancelled,
  TaskDisconnected,
  type ConnectionState,
  type TaskEvent,
} from "../src/task.js";

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
  probeUrl: "/tasks/task-1/summary",
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

  /**
   * 复用别人正在跑的任务时，这个页面只是个观察者。
   *
   * 点「离开」发 cancel 的话，另一个页面上正在生成的回答会**半句话断掉**，
   * 而那边的用户什么都没做。复用是系统替他做的决定，他甚至不知道自己
   * 被并了过去——**你没发起的任务，你没有权力替别人终止。**
   */
  it("搭上别人的任务时，离开只断自己，不发 cancel", async () => {
    const controller = new AbortController();
    const calls = stubFetch([
      () => json({ ...ACCEPTED, reused: true }, 202),
      (init) => {
        queueMicrotask(() => controller.abort());
        return new Response(
          new ReadableStream({
            start(stream) {
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
      runTask({ url: "/ask", body: {}, onEvent: () => {}, signal: controller.signal }),
      (error: Error) => error instanceof TaskCancelled,
    );

    assert.equal(
      calls.find((c) => c.url.includes("/cancel")),
      undefined,
      "复用来的任务不该被这个页面掐掉",
    );
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

  /**
   * 心跳超时之后先探一下，再决定要不要重连。
   *
   * **「收不到心跳」是一个症状、两个病因**：链路假死该尽快重连，服务端
   * 事件循环被钉死则绝不能重连——重连要回放全部历史事件，是火上浇油。
   * 这两种在客户端看来一模一样，所以要花一个极轻的请求把它们分开。
   */
  describe("心跳超时", () => {
    /** 一条永远不来数据、但响应 abort 的流：真实假死就长这样 */
    const silent = () => (init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener("abort", () => stream.error(new Error("aborted")), {
              once: true,
            });
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );

    const runWithFastHeartbeat = (): Promise<unknown> =>
      runTask({
        url: "/ask",
        body: {},
        onEvent: () => {},
        // 真等 45 秒的用例没人会跑
        heartbeatTimeoutMs: 20,
      });

    it("撞上阈值会主动断开并去探，而不是干等着", async () => {
      noBackoff();
      const calls = stubFetch([
        () => json(ACCEPTED, 202),
        silent(),
        () => json({ status: "running" }),
        () => sse([DONE]),
        () => json({ ...ACCEPTED, status: "completed", events: [] }),
      ]);

      await runWithFastHeartbeat();

      const probe = calls.find((c) => c.url.includes("/summary"));
      assert.ok(probe, "必须探一下——不探就分不清是链路假死还是服务端忙");
      assert.equal(probe?.method, "GET");
      assert.ok(probe?.headers.traceparent, "探针也要带编号，否则这一跳在日志里断了");
    });

    it("探针说服务端还活着 → 立刻重连", async () => {
      noBackoff();
      const calls = stubFetch([
        () => json(ACCEPTED, 202),
        silent(),
        () => json({ status: "running" }),
        () => sse([progress(0, "续上了"), DONE]),
        () => json({ ...ACCEPTED, status: "completed", events: [] }),
      ]);

      const events: TaskEvent[] = [];
      await runTask({
        url: "/ask",
        body: {},
        onEvent: (e) => events.push(e),
        heartbeatTimeoutMs: 20,
      });

      assert.equal(events.length, 1, "服务端好好的，重连就该接得上");
      assert.equal(calls.filter((c) => c.url.includes("/events")).length, 2, "断一次、重连一次");
    });

    it("探针说任务其实已经结束了 → 不重连，直接收尾", async () => {
      noBackoff();
      const calls = stubFetch([
        () => json(ACCEPTED, 202),
        silent(),
        // done 帧丢了，但任务在服务端早就完成了
        () => json({ status: "completed" }),
        () => json({ ...ACCEPTED, status: "completed", events: [] }),
      ]);

      const status = await runWithFastHeartbeat();

      assert.equal((status as { status: string }).status, "completed");
      assert.equal(
        calls.filter((c) => c.url.includes("/events")).length,
        1,
        "**这一条是白捡的**：不探的话要白白重连一次才发现任务早就结束了",
      );
    });

    it("探针也答不上来 → 判定服务端在忙，退避拉长而不是马上回去加压", async () => {
      // 这条是整组的重点。**退避长度就是这里唯一能观察到的行为差异**：
      // 重连照样会发生，区别只在等多久——所以断言必须落在时长上
      const waits: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        if (typeof ms === "number" && ms > 0) waits.push(ms);
        return realSetTimeout(fn, 0);
      }) as typeof globalThis.setTimeout;

      Math.random = () => 0; // 普通退避归零，剩下的只可能是「忙」那条下限

      try {
        stubFetch([
          () => json(ACCEPTED, 202),
          silent(),
          // 探针自己超时——事件循环被钉死时它也一样排不上队
          () => {
            throw new Error("probe timed out");
          },
          () => sse([DONE]),
          () => json({ ...ACCEPTED, status: "completed", events: [] }),
        ]);

        await runWithFastHeartbeat();
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }

      assert.ok(
        waits.some((ms) => ms >= 8_000),
        `服务端在忙的时候必须拉长退避，实际等待：${waits.join(", ")}`,
      );
    });

    it("用户取消优先于心跳超时——那是两件事", async () => {
      const controller = new AbortController();
      stubFetch([
        () => json(ACCEPTED, 202),
        (init) => {
          queueMicrotask(() => controller.abort());
          return new Response(
            new ReadableStream({
              start(stream) {
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
          heartbeatTimeoutMs: 20,
        }),
        (error: Error) => error instanceof TaskCancelled,
        "用户点了停止，就不该再被解释成「链路有问题」",
      );
    });

    it("重连次数已经用尽时点停止，说的是「已停止」而不是「连接中断」", async () => {
      // **这条是变异测试逼出来的。** 原来只有上面那条取消用例，而它
      // 删掉 `runTask` 里的「取消优先」总闸之后**依然全绿**——因为
      // `delay()` 撞上 abort 也会抛 `TaskCancelled`，两条路的结果一样。
      //
      // 唯一真正需要那道总闸的是这个边界：重连预算刚好耗尽的同一刻用户
      // 点了停止。没有它，用户会看到「重连 5 次仍未恢复」——**明明是他
      // 自己停的，却被告知网络有问题**。
      noBackoff();
      const controller = new AbortController();
      let attempts = 0;
      const dead = (): Response => {
        attempts += 1;
        // 第 6 次失败会让 attempt 超出上限；赶在那之前点停止
        if (attempts >= 6) controller.abort();
        throw new Error("network down");
      };

      stubFetch([
        () => json(ACCEPTED, 202),
        dead,
        dead,
        dead,
        dead,
        dead,
        dead,
        () => json({ status: "cancelled" }),
      ]);

      await assert.rejects(
        runTask({ url: "/ask", body: {}, onEvent: () => {}, signal: controller.signal }),
        (error: Error) => error instanceof TaskCancelled,
        "用户的意图优先于我们自己的重连预算",
      );
    });
  });

  /**
   * 重连期间界面上要有反馈。
   *
   * 服务端卡住时一轮是「45 秒等心跳 + 5 秒探针 + 8 秒退避」≈ 58 秒，
   * 五轮将近五分钟——**这段时间界面一声不吭，就成了假死**。
   * 这一组守的是「等待也要有反馈」这条原则在重连路径上也成立。
   */
  describe("重连时的界面反馈", () => {
    const states: ConnectionState[] = [];
    const track = (state: ConnectionState): number => states.push(state);

    it("一次都没断过就不该冒出任何链路提示", async () => {
      stubFetch([
        () => json(ACCEPTED, 202),
        () => sse([progress(0, "一步到位"), DONE]),
        () => json({ ...ACCEPTED, status: "completed", events: [] }),
      ]);
      states.length = 0;

      await runTask({ url: "/ask", body: {}, onEvent: () => {}, onConnectionChange: track });

      assert.deepEqual(states, [], "顺利跑完还弹「已连接」，是在制造噪音");
    });

    it("断开时报出第几次，恢复时再报一声", async () => {
      noBackoff();
      stubFetch([
        () => json(ACCEPTED, 202),
        () => sse([progress(0, "第一步")]), // 流意外结束
        () => sse([progress(1, "续上了"), DONE]),
        () => json({ ...ACCEPTED, status: "completed", events: [] }),
      ]);
      states.length = 0;

      await runTask({ url: "/ask", body: {}, onEvent: () => {}, onConnectionChange: track });

      assert.equal(states.length, 2, "一次断、一次恢复");
      assert.deepEqual(states[0], {
        status: "reconnecting",
        attempt: 1,
        max: 5,
        serverBusy: false,
      });
      assert.deepEqual(states[1], { status: "connected" });
    });

    it("提示排在重连请求之前，不是等完才补报", async () => {
      // **报晚了等于没报**：用户要的正是「这段安静是有人在处理」。
      //
      // 第一版这条我是去拦 setTimeout 的，结果**误抓了心跳看门狗**
      // ——它也是一个 setTimeout，而且排在更前面。改成直接看
      // 「提示」和「重连请求」的先后，测的才是真正在乎的那件事
      noBackoff();
      const order: string[] = [];
      stubFetch([
        () => {
          order.push("提交");
          return json(ACCEPTED, 202);
        },
        () => {
          order.push("首连");
          return sse([progress(0, "第一步")]); // 流意外结束
        },
        () => {
          order.push("重连");
          return sse([DONE]);
        },
        () => json({ ...ACCEPTED, status: "completed", events: [] }),
      ]);

      await runTask({
        url: "/ask",
        body: {},
        onEvent: () => {},
        onConnectionChange: () => order.push("提示"),
      });

      assert.deepEqual(
        order.slice(0, 4),
        ["提交", "首连", "提示", "重连"],
        "提示必须在重连动作之前发出",
      );
    });

    it("服务端在忙和普通断线，说法要不一样", () => {
      // 同一个界面位置说两件不同的事，用户没法判断该不该管
      const busy = describeConnection({
        status: "reconnecting",
        attempt: 2,
        max: 5,
        serverBusy: true,
      });
      const plain = describeConnection({
        status: "reconnecting",
        attempt: 2,
        max: 5,
        serverBusy: false,
      });

      assert.notEqual(busy, plain);
      assert.match(busy, /繁忙/);
      assert.match(plain, /重连/);
      // 这句是这一刻用户最需要知道的：界面卡住了，但活还在干
      for (const text of [busy, plain]) assert.match(text, /任务仍在后台继续/);
      assert.match(busy, /2\/5/, "要说清第几次，否则用户不知道还要等多久");
    });
  });
});
