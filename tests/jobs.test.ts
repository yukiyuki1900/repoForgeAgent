import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runRefactorJob } from "../src/jobs.js";
import { TIMEOUTS } from "../src/limits.js";
import {
  attachStream,
  cancelTask,
  formatEvent,
  getTask,
  startTask,
  type TaskEvent,
} from "../src/tasks.js";

/**
 * 前后端契约。
 *
 * 前端的 TypeScript 接口是**手写**的：后端把 `outcome.cycles` 改成
 * `outcome.cycleReport`，两边都能编译通过，页面上只会静静地显示成空白。
 * 编译器管不到跨进程的字段名，所以这层只能靠断言守住。
 *
 * 这里对着 `web/src/RefactorPanel.tsx` 里读到的每一个字段做检查——
 * 改了后端却忘了改前端时，跑测试就会红。
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = path.join(ROOT, ".tmp-jobs-test");

let current: string | undefined;

function sandboxFrom(fixture: string): string {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const dir = fs.mkdtempSync(path.join(SANDBOX, "repo-"));
  current = dir;

  fs.cpSync(path.join(ROOT, "fixtures", fixture, "src"), path.join(dir, "src"), {
    recursive: true,
  });

  const git = (args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["add", "-A"]);
  git([
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

afterEach(() => {
  if (current) fs.rmSync(current, { recursive: true, force: true });
  current = undefined;
});

describe("改造任务的返回契约", () => {
  it("dry-run 的字段与前端读取的一致", async () => {
    const events: TaskEvent[] = [];
    const result = await runRefactorJob(sandboxFrom("13-type-only-cycle"), false, (event) =>
      events.push({ ...event, at: "" }),
    );

    assert.equal(result.applied, false);
    assert.equal(result.outcome, undefined, "未应用时不该有 outcome");
    assert.ok(result.text.length > 0);

    // RefactorPanel 读的是这些字段
    const plan = result.plan!;
    assert.equal(typeof plan.cyclesBefore, "number");
    assert.equal(typeof plan.cyclesAfter, "number");
    assert.equal(typeof plan.filesAffected, "number");
    assert.ok(Array.isArray(plan.blockers));
    assert.ok(Array.isArray(plan.cycles));

    const cycle = plan.cycles[0];
    assert.ok(Array.isArray(cycle.files));
    assert.ok(Array.isArray(cycle.candidates));
    assert.ok(Array.isArray(cycle.blocked));
    assert.equal(typeof cycle.breakable, "boolean");

    const candidate = cycle.candidates[0];
    assert.equal(typeof candidate.file, "string");
    assert.equal(typeof candidate.line, "number");
    assert.equal(typeof candidate.specifier, "string");
    assert.ok(Array.isArray(candidate.names));

    // 进度事件的形状同样是契约的一部分
    assert.ok(events.every((event) => event.channel === "step"));
    assert.ok(events.some((event) => event.detail?.includes("个文件")));
  });

  it("apply 的 outcome 字段与前端读取的一致", async () => {
    const result = await runRefactorJob(sandboxFrom("13-type-only-cycle"), true, () => {});

    assert.equal(result.applied, true);
    const outcome = result.outcome!;

    assert.equal(outcome.status, "applied");
    assert.ok(Array.isArray(outcome.edits));
    assert.ok(Array.isArray(outcome.skipped));
    assert.equal(typeof outcome.outputDir, "string");
    assert.ok(typeof outcome.diff === "string" && outcome.diff.includes("import type"));

    const typecheck = outcome.typecheck as { baselineErrors: number; introduced: unknown[] };
    assert.equal(typeof typecheck.baselineErrors, "number");
    assert.ok(Array.isArray(typecheck.introduced));

    const cycles = outcome.cycles as { before: number; predicted: number; actual: number };
    assert.deepEqual(cycles, { before: 1, predicted: 0, actual: 0 });
  });

  it("没有循环依赖时给出明确文案，而不是空计划", async () => {
    const result = await runRefactorJob(sandboxFrom("09-src-layout"), false, () => {});

    assert.equal(result.plan, null);
    assert.match(result.text, /没有循环依赖/);
  });
});

describe("任务状态机", () => {
  it("成功的任务留下结果与终态", async () => {
    const record = startTask({
      kind: "refactor",
      root: "/tmp",
      run: async ({ emit }) => {
        emit({ channel: "step", label: "干活" });
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.status, "completed");
    assert.deepEqual(record.result, { ok: true });
    assert.equal(record.events.length, 1);
    assert.ok(record.finishedAt);
  });

  it("流式文本累积在 record 上，不进事件数组", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ emitText }) => {
        emitText("前半段");
        emitText("后半段");
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.text, "前半段后半段");
    // 几千个 token 逐条塞进 events 会让内存与回放体积一起失控
    assert.equal(record.events.length, 0);
  });

  it("失败的任务把原因写进事件流，而不是只留一个空状态", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async () => {
        throw new Error("模型不可用");
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.status, "failed");
    assert.equal(record.error, "模型不可用");
    // 前端的时间线要能看到失败，否则界面上只是「转圈然后什么都没有」
    assert.ok(record.events.some((event) => event.phase === "error"));
  });
});

/**
 * 取消与超时。
 *
 * 这组用例守的是一句话：**「停止生成」如果只做前端，那是障眼法。**
 * 前端关掉 EventSource 只是不看了，后台该跑还跑、该烧的 token 一个不少。
 * 所以断言的重点不是「界面停了」，而是**下游真的收到了 signal**。
 */
describe("任务的取消与超时", () => {
  it("取消会把 signal 传到任务体，而不只是改个状态", async () => {
    let observed: AbortSignal | undefined;

    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ signal }) => {
        observed = signal;
        // 模拟一个不会自己结束的长任务
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(observed?.aborted, false, "任务开始时不应已被取消");

    cancelTask(record.taskId);

    assert.equal(record.status, "cancelled");
    assert.equal(record.cancelReason, "user");
    // 这一条才是重点：下游真的收到了信号
    assert.equal(observed?.aborted, true);
    // 用户主动停的不是故障，不该留错误信息
    assert.equal(record.error, undefined);
    assert.ok(record.finishedAt, "取消后要立刻有终态时间，界面不能继续转圈");
  });

  it("取消是幂等的：第二次不覆盖第一次的原因", () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: () => new Promise(() => {}),
    });

    // 两次都用同一个原因是测不出覆盖的——第一次先用 timeout，
    // 再用 user 取消，原因还是 timeout 才说明守卫真的在
    const first = cancelTask(record.taskId, "timeout");
    const finishedAt = record.finishedAt;
    const second = cancelTask(record.taskId, "user");

    assert.equal(first?.status, "cancelled");
    assert.equal(second?.status, "cancelled");
    assert.equal(second?.cancelReason, "timeout", "第二次不该把原因覆盖掉");
    assert.equal(record.finishedAt, finishedAt, "终态时间也不该被改写");
    assert.equal(record.events.length, 1, "不该重复发一条取消事件");
  });

  it("任务体在 abort 时抛错，也算取消而不是失败", async () => {
    // 大多数库（包括 ai SDK）拿到 signal 后是**抛 AbortError**，
    // 不是安静返回。这条路径和「吞掉 abort 正常返回」是两个分支，
    // 都得测——它们在代码里是 if/else 的两边
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ signal }) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
        });
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    cancelTask(record.taskId);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(record.status, "cancelled");
    // 被取消时下游抛的错是预期内的，不该当成故障留在界面上
    assert.equal(record.error, undefined);
  });

  it("超时走同一条路，但原因可区分", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      timeoutMs: 30,
      run: () => new Promise(() => {}),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(record.status, "cancelled");
    // 状态相同、原因不同：前端据此决定是「你停的，什么都不用说」
    // 还是「超时了，给个重试按钮」
    assert.equal(record.cancelReason, "timeout");
    assert.ok(record.events.some((event) => event.label.includes("超时")));
  });

  it("任务体吞掉 abort 正常返回时，仍然算取消", async () => {
    // 有些库拿到 signal 后不抛错，而是提前返回部分结果。
    // 以信号为准，不以「它返回没返回」为准
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        return { partial: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    cancelTask(record.taskId);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(record.status, "cancelled");
  });

  it("正常完成的任务不会被超时定时器改掉终态", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      timeoutMs: 30,
      run: async () => ({ ok: true }),
    });

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(record.status, "completed");
    assert.equal(record.cancelReason, undefined);
  });

  it("不传 timeoutMs 时，兜底值按 kind 取，不是一个跨模式的常量", (t) => {
    // 原来的兜底是一个五分钟的常量。三条路由都显式传了各自的值，所以
    // 线上没暴露——但新加一种模式只要忘了传，就静默拿到五分钟，
    // ask 那种要十分钟的直接被腰斩。漏传的失败是**不报错**的那种。
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.after(() => t.mock.timers.reset());

    const record = startTask({
      kind: "ask", // 十分钟那一档
      root: "/tmp",
      run: () => new Promise(() => {}),
    });

    t.mock.timers.tick(TIMEOUTS.task.analyze + 1000);
    assert.equal(record.status, "running", "ask 不该按 analyze 的五分钟被砍掉");

    t.mock.timers.tick(TIMEOUTS.task.ask - TIMEOUTS.task.analyze);
    assert.equal(record.status, "cancelled", "到了自己那一档还是要兜住");
    assert.equal(record.cancelReason, "timeout");
  });
});

/**
 * 断线重连。
 *
 * 服务端本来就支持中途接入回放，但重连时把整条时间线**再推一遍**，
 * 前端事件列表会直接翻倍。SSE 协议自带的 `id:` + `Last-Event-ID`
 * 正是为这件事准备的——浏览器自动带上，客户端一行代码都不用写。
 */
describe("SSE 事件的可续传", () => {
  const read = (stream: PassThrough): string => String(stream.read() ?? "");

  it("事件带 id，重连时只补发之后的", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ emit }) => {
        emit({ channel: "step", label: "第一步" });
        emit({ channel: "step", label: "第二步" });
        emit({ channel: "step", label: "第三步" });
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const full = read(attachStream(record));
    assert.match(full, /id: 0\n/);
    assert.match(full, /第一步/);

    // 断在第一条之后重连：只该看到第二、三步
    const resumed = read(attachStream(record, "0"));
    assert.doesNotMatch(resumed, /第一步/);
    assert.match(resumed, /第二步/);
    assert.match(resumed, /第三步/);
  });

  it("订阅之后会持续发心跳，且心跳不带 id", async (t) => {
    // 心跳解决的是一个前端**没资格自己判断**的问题：连接看起来开着、
    // 但一个字节都过不来。用「多久没进度」去猜必然误杀慢任务，
    // 而心跳是定频的，收不到就只可能是链路问题。
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: () => new Promise(() => {}), // 永不结束，好让心跳有机会发出来
      timeoutMs: 60_000,
    });

    const stream = attachStream(record, undefined, 20);
    // 清理挂在 after 上而不是写在用例末尾：断言一失败就抛，末尾的清理直接
    // 跳过。**但别指望它能兜住整个文件**——这里还有一堆用例只关心事件内容、
    // 压根不关流，实测去掉 unref 后退出时仍有 4 个 Timeout 活着。
    // 让这个文件能正常退出的是 unref，不是清理写得多干净
    t.after(() => {
      stream.destroy();
      cancelTask(record.taskId);
    });

    await new Promise((resolve) => setTimeout(resolve, 90));
    const received = String(stream.read() ?? "");

    // 具名事件而不是 SSE 注释行（`: ping`）——注释行浏览器会吞掉，
    // JS 侧感知不到，那样只能保活代理，帮不了前端判断
    assert.match(received, /event: ping\n/, "心跳必须是具名事件");
    assert.ok(
      received.split("event: ping").length - 1 >= 2,
      "心跳要持续发，只发一次等于没有",
    );
    // 心跳不进 events 数组，给它编号会污染 Last-Event-ID 续传
    assert.doesNotMatch(received, /id: \d+\nevent: ping/, "心跳不该带 id");
  });

  it("流关掉之后心跳必须停，否则每个断开的连接都留一个定时器", async (t) => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: () => new Promise(() => {}),
      timeoutMs: 60_000,
    });
    t.after(() => cancelTask(record.taskId));

    const stream = attachStream(record, undefined, 20);
    await new Promise((resolve) => setTimeout(resolve, 50));
    stream.destroy();

    // 直接数「关掉之后还写了几次」。
    // 第一版这里断言的是 subscribers 被清空——那是 delete 干的，
    // 跟 clearInterval 毫无关系，变异测试里删掉 clearInterval 照样全绿
    let writesAfterClose = 0;
    stream.write = () => {
      writesAfterClose += 1;
      return true;
    };

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(writesAfterClose, 0, "流关掉后心跳必须停，否则每个断开的连接都漏一个定时器");
    assert.equal(record.subscribers.size, 0, "订阅者也要清掉");
  });

  it("任务结束到流关闭之间的空隙里，心跳不能再往流里写", async (t) => {
    // 这条是实测撞出来的，不是假想的边界：
    // `finish()` 调 `end()` 只结束**可写端**，`close` 要等读端也消费完才来，
    // 而 `clearInterval` 挂在 `close` 上。没人读这条流的时候，这段空隙可以
    // 无限长——心跳每一次触发都是 `ERR_STREAM_WRITE_AFTER_END`，
    // 而流上没人听 `error` 就是未捕获错误，**直接崩进程**。
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async () => ({ ok: true }),
      timeoutMs: 60_000,
    });

    const stream = attachStream(record, undefined, 20);
    t.after(() => stream.destroy());

    const errors: string[] = [];
    stream.on("error", (err: NodeJS.ErrnoException) => errors.push(err.code ?? err.message));

    // 故意不读这条流：读端不消费，`close` 就不会来，空隙一直开着
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.deepEqual(errors, [], "任务已结束的流上不该再有写入");
  });

  it("心跳定时器不能吊住事件循环", async (t) => {
    // 心跳是 setInterval，默认会 ref 住事件循环——一条挂着心跳的流足以
    // 让整个进程无法自然退出（实测：去掉 unref 后进程挂死，只能被强杀）。
    // 心跳只是给活着的连接保活，它自己没有「让进程继续跑」的资格。
    const timers = (): number =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: () => new Promise(() => {}),
      timeoutMs: 60_000,
    });

    const before = timers();
    const stream = attachStream(record, undefined, 20);
    t.after(() => {
      stream.destroy();
      cancelTask(record.taskId);
    });

    assert.equal(timers(), before, "心跳定时器必须 unref，否则进程退不出去");
  });

  it("实时推送的事件也带 id，不只是回放的那份", async () => {
    // 事件有两条出路：实时推给已订阅的流、以及回放给新接入的流。
    // 只测回放会漏掉实时那条——变异测试就是这么抓到我的：
    // 把实时推送的 id 去掉，全部用例照样绿
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ emit }) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        emit({ channel: "step", label: "订阅之后才发生的" });
        return { ok: true };
      },
    });

    const stream = attachStream(record);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const received = String(stream.read() ?? "");
    assert.match(received, /订阅之后才发生的/);
    assert.match(received, /id: 0\n/, "实时推送的事件必须带 id，否则断线后无从续传");
  });

  it("Last-Event-ID 是脏数据时从头补，不是崩掉", () => {
    const record = startTask({
      kind: "refactor",
      root: "/tmp",
      run: async ({ emit }) => {
        emit({ channel: "step", label: "唯一一步" });
        return { ok: true };
      },
    });

    // 这个头来自客户端，可能是任何东西
    for (const bogus of ["", "abc", "-5", "NaN"]) {
      assert.match(read(attachStream(record, bogus)), /唯一一步/, `Last-Event-ID=${bogus}`);
    }
  });

  it("文本走全量替换，不参与序号续传", async () => {
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ emitText }) => {
        emitText("已经");
        emitText("写了一半");
        return { ok: true };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // 事件、文本两种数据特征不同，续传策略也不同：
    // 事件离散可数、必须不重不漏，文本连续、只关心最终形态
    const resumed = read(attachStream(record, "999"));
    assert.match(resumed, /"replace":true/);
    assert.match(resumed, /已经写了一半/);
  });
});

/**
 * 后台任务是**离线**的。
 *
 * 用户发起之后可以断网、可以关页面、可以换设备，**只有显式 cancel
 * 才该终止它**。这不是「顺便也支持」，而是这个模块的核心不变量——
 * 一次 analyze 要跑几十秒到几分钟，要求用户盯着页面才是设计错误。
 *
 * 这一组用例存在的理由是：这条不变量之前**只是碰巧成立**。
 * 没有任何东西守着它，而破坏它只需要在某个写入点上少一道守卫——
 * 异常会顺着 `emit()` 冒进任务体，被 try/catch 抓成 `failed`，
 * 于是「一个客户端掉线」变成「后台任务被判死」。
 */
describe("离线任务不受客户端影响", () => {
  const read = (stream: PassThrough): string => String(stream.read() ?? "");

  it("订阅者断开后，任务照常跑完，事件一条不少", async () => {
    let resume: (() => void) | undefined;
    const record = startTask({
      kind: "analyze",
      root: "/tmp",
      run: async ({ emit, emitText }) => {
        emit({ channel: "step", label: "断开之前" });
        await new Promise<void>((r) => (resume = r));
        // 这一段是在「已经没有任何订阅者」的情况下跑的
        emit({ channel: "step", label: "断开之后" });
        emitText("断开期间生成的回答");
        return { ok: true };
      },
    });

    const stream = attachStream(record, undefined, 20);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 模拟客户端断开：api.ts 里 ctx.req.on("close") 走的就是这一行
    stream.destroy();

    // 写这条断言时我先写的是 `size === 0`，结果**当场变红**——
    // `destroy()` 是同步打标记、异步派发 `close`，而移出 subscribers 挂在
    // `close` 上。所以这一瞬间流已经死了、却还在集合里。
    // 这正是 `push()` 那道守卫存在的窗口，不是测试写错了
    assert.equal(record.subscribers.size, 1, "destroy 之后 close 之前，它还在集合里");
    assert.equal(stream.destroyed, true);

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(record.subscribers.size, 0, "close 到了才真的清掉");

    resume?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(record.status, "completed", "客户端断开不该让任务失败或取消");
    assert.deepEqual(record.result, { ok: true });
    assert.deepEqual(
      record.events.map((e) => e.label),
      ["断开之前", "断开之后"],
      "没人听的时候事件照样要进 events，否则重新连上就缺一块",
    );
    assert.equal(record.text, "断开期间生成的回答");
  });

  it("链路是「带错误地」断掉的时候，也不能波及任务", async () => {
    // 上一条用的是干净的 destroy()，那种情况 Node 会静默吞掉后续写入。
    // 但**真实的断线不是干净的**：socket hang up、代理掐断，Node 是
    // `destroy(err)` ——之后每一次 write 都会把那个 error 重新抛出来。
    //
    // 而我们这条 PassThrough 上**没有人监听 error**：Koa 的 respond 是
    // `body.pipe(res)`，`pipe()` 不给源流挂 error 监听，`onFinished` 听的
    // 是 response 不是它。所以未捕获 → 崩进程 → **所有任务陪葬**。
    // 一个用户的网络抖动，会杀掉其他所有人正在跑的任务。
    let resume: (() => void) | undefined;
    const record = startTask({
      kind: "analyze",
      root: "/tmp",
      run: async ({ emit }) => {
        await new Promise<void>((r) => (resume = r));
        emit({ channel: "step", label: "断开之后仍然继续" });
        return { ok: true };
      },
    });

    const stream = attachStream(record, undefined, 20);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 故意不挂 error 监听——就是要复现线上那条没人兜底的路径
    stream.destroy(new Error("socket hang up"));

    resume?.();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(record.status, "completed", "对面怎么断的，都不该改变任务的命运");
    assert.ok(record.events.some((e) => e.label === "断开之后仍然继续"));
  });

  it("断开期间产生的一切，重新连上能完整拿回来", async () => {
    let resume: (() => void) | undefined;
    const record = startTask({
      kind: "ask",
      root: "/tmp",
      run: async ({ emit, emitText }) => {
        emit({ channel: "step", label: "第一步" });
        await new Promise<void>((r) => (resume = r));
        emit({ channel: "step", label: "第二步" });
        emitText("完整的回答");
        return { ok: true };
      },
    });

    const first = attachStream(record, undefined, 20);
    await new Promise((resolve) => setTimeout(resolve, 30));
    read(first); // 消费掉「第一步」
    first.destroy();

    resume?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 关了页面重新打开：没有 Last-Event-ID，从头补
    const reopened = read(attachStream(record));
    assert.match(reopened, /第一步/);
    assert.match(reopened, /第二步/, "断开期间的事件必须补得回来");
    assert.match(reopened, /完整的回答/);
    assert.match(reopened, /event: done/, "任务已经结束，直接以 done 收尾");
  });

  it("所有订阅者都走光，任务也不会被取消", async () => {
    const record = startTask({
      kind: "analyze",
      root: "/tmp",
      run: async ({ emit }) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        emit({ channel: "step", label: "没人看也要跑完" });
        return { ok: true };
      },
    });

    // 两个标签页，然后全关掉
    const a = attachStream(record, undefined, 20);
    const b = attachStream(record, undefined, 20);
    a.destroy();
    b.destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(record.subscribers.size, 0);
    assert.equal(record.status, "running", "没人订阅不是取消的理由");

    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(record.status, "completed");
  });

  it("只有显式 cancel 才终止——断开不是意图表达", async () => {
    const make = (): ReturnType<typeof startTask> =>
      startTask({
        kind: "analyze",
        root: "/tmp",
        run: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        timeoutMs: 60_000,
      });

    const disconnected = make();
    attachStream(disconnected, undefined, 20).destroy();

    const stopped = make();
    cancelTask(stopped.taskId);

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(disconnected.status, "running", "断开 ≠ 停止");
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.cancelReason, "user");

    cancelTask(disconnected.taskId);
  });

  it("running 的任务永远不会被淘汰，哪怕没人在看", async () => {
    // 关掉页面几分钟后回来，任务记录还得在。淘汰只挑已完成的
    const alive = startTask({
      kind: "analyze",
      root: "/tmp",
      run: () => new Promise(() => {}),
      timeoutMs: 60_000,
    });

    // 冲掉保留上限：制造远超 MAX_RETAINED 的已完成任务
    for (let i = 0; i < 30; i += 1) {
      startTask({ kind: "ask", root: "/tmp", run: async () => ({ i }) });
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    startTask({ kind: "ask", root: "/tmp", run: async () => ({ last: true }) });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(getTask(alive.taskId), "正在跑的任务不该被淘汰掉");
    cancelTask(alive.taskId);
  });
});
