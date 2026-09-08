import Koa from "koa";
// @koa/bodyparser v5 只有命名导出，默认导入会拿到模块命名空间对象
import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadEnv } from "./core/env.js";
import { runAskJob, runRefactorJob } from "./task/jobs.js";
import { describeModelUnavailable, resolveModel } from "./agent/llm.js";
import { locateDirectories, type Fingerprint } from "./scan/locate.js";
import { readLatestRun, readRunSummaries } from "./report/storage.js";
import {
  admitOrStart,
  attachStream,
  cancelTask,
  getTask,
  listTasks,
  dedupeKeyOf,
  runningCount,
  setArchiver,
  summaryOf,
  toResponse,
  type StartTaskInput,
  type TaskRecord,
} from "./task/tasks.js";
import {
  archiveTask,
  readArchivedTask,
  readTaskHistory,
  taskLabel,
  type ArchivedTask,
} from "./task/history.js";
import { runAnalysis } from "./workflow.js";
import { log } from "./core/log.js";
import { TIMEOUTS } from "./core/limits.js";
import { parseTraceparent, type TraceContext } from "./core/trace.js";

// 必须在读取任何配置之前加载
loadEnv();

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
/**
 * 用专用变量名而不是通用的 PORT。
 *
 * 容器、PaaS、CI 普遍会注入 PORT，一旦读它，API 就会监听一个意外端口，
 * 而前端 vite proxy 仍指向 3100——表现是页面能开、接口全挂，极难排查。
 */
const DEFAULT_PORT = 3100;
const API_PORT = Number(process.env.REPOSURGEON_API_PORT ?? DEFAULT_PORT);
/** 已完成的 run 保留上限，超出后按开始时间淘汰最旧的 */
const MAX_RETAINED_RUNS = 20;

const app = new Koa();
const router = new Router();

/**
 * 把归档接到任务机制上。
 *
 * 注入而不是让 `tasks.ts` 直接 import：那一层现在只依赖纯模块，
 * 直连 SQLite 之后每个跑任务的单测都会在临时目录里落一个 .db 文件。
 * **进程的组装是 api 这一层的职责，不是任务机制的。**
 */
setArchiver(archiveTask);

app.use(async (ctx, next) => {
  ctx.set("Access-Control-Allow-Origin", WEB_ORIGIN);
  // `traceparent` 和 `Last-Event-ID` **都不在 CORS 安全清单里**，不显式放行
  // 浏览器会在预检阶段就把它们剥掉——而且不报错，表现是「排障编号莫名其妙
  // 对不上」「重连总是从头补」。顺带一提，EventSource 连发这两个头的机会都没有
  ctx.set("Access-Control-Allow-Headers", "Content-Type,traceparent,Last-Event-ID");
  ctx.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  // 跨域下 JS 默认只读得到几个安全响应头，不 expose 的话前端拿不到编号
  ctx.set("Access-Control-Expose-Headers", "X-Trace-Id");
  if (ctx.method === "OPTIONS") {
    ctx.status = 204;
    return;
  }
  await next();
});

/**
 * 贯穿全局的 trace 上下文。
 *
 * 放在最外层是因为**排障编号必须对所有响应都成立**，包括 404、500、
 * 以及任何还没走到业务代码就失败的请求——恰恰是那些最需要能被追溯。
 * 逐个路由去加，一定会漏掉刚加的那个。
 */
app.use(async (ctx, next) => {
  const header = ctx.headers.traceparent;
  const trace = parseTraceparent(Array.isArray(header) ? header[0] : header);
  ctx.state.trace = trace;
  ctx.set("X-Trace-Id", trace.traceId);
  await next();
});

/**
 * 三种模式共用一套提交协议：立刻返回 taskId，进度走 SSE。
 *
 * 路由分开是因为参数与风险都不同——尤其 refactor 会写用户的代码，
 * 不能和只读的分析共用一个入口，否则参数少传一个就可能改盘。
 */
router.post("/analysis", (ctx) => {
  const body = (ctx.request.body ?? {}) as { root?: string; query?: string; full?: boolean };
  const root = requireRoot(ctx, body.root);
  if (!root) return;

  submit(ctx, {
    kind: "analyze",
    root,
    // 键里带上会改变结果的参数。analyze 的 `query` 影响检索范围、
    // `full` 影响是否跑全量——两个不同的分析请求不该被判成同一件事
    dedupeKey: dedupeKeyOf("analyze", root, { query: body.query, full: body.full }),
    traceId: traceOf(ctx),
    timeoutMs: TIMEOUTS.task.analyze,
    run: async ({ emit, signal }) => {
      const state = await runAnalysis(root, {
        query: body.query,
        full: body.full,
        runId: randomUUID(),
        // 之前这里没传 signal，于是「停止」在 analyze 下是半残的：
        // 界面停了、状态写成 cancelled 了，但 narrate 那 18 秒照样跑完
        signal,
        onProgress: (event) =>
          emit({
            channel: "node",
            label: event.node,
            phase: event.phase,
            durationMs: event.durationMs,
            detail: event.detail,
          }),
      });
      return {
        report: state.report,
        queryPlan: state.queryPlan,
        retrieval: state.retrieval,
        plan: state.executionPlan,
      };
    },
  });
});

/**
 * 改造。
 *
 * `apply` 默认 false，必须显式传 true 才写盘——这个默认值是安全边界的一部分：
 * 少传一个参数的后果应该是「什么都没发生」，而不是「代码被改了」。
 * 前端也走两步：先看计划，再确认应用。
 */
router.post("/refactor", (ctx) => {
  const body = (ctx.request.body ?? {}) as { root?: string; apply?: boolean };
  const root = requireRoot(ctx, body.root);
  if (!root) return;

  const shouldApply = body.apply === true;

  submit(ctx, {
    kind: "refactor",
    root,
    // **`apply` 必须进键。** 少了它，dry-run 跑着时点「真执行」会被判成
    // 重复提交、复用那个只读任务——界面显示跑完了，而代码一个字没改。
    // 这是这次修的两条里更要命的一条：它落在写用户代码这条线上
    dedupeKey: dedupeKeyOf("refactor", root, { apply: shouldApply }),
    traceId: traceOf(ctx),
    meta: { apply: shouldApply },
    timeoutMs: TIMEOUTS.task.refactor,
    run: ({ emit }) => runRefactorJob(root, shouldApply, emit),
  });
});

/** 追问：模型自主决定调用哪些只读工具 */
router.post("/ask", (ctx) => {
  const body = (ctx.request.body ?? {}) as { root?: string; question?: string; maxSteps?: number };
  const root = requireRoot(ctx, body.root);
  if (!root) return;

  const question = (body.question ?? "").trim();
  if (!question) {
    ctx.status = 400;
    ctx.body = { error: "question is required" };
    return;
  }

  const model = resolveModel();
  if (!model) {
    ctx.status = 400;
    ctx.body = { error: describeModelUnavailable() };
    return;
  }

  const maxSteps = Number(body.maxSteps) || undefined;

  submit(ctx, {
    kind: "ask",
    root,
    // **`question` 必须进键。** 少了它，问题 A 还在跑时问 B，B 会被判成
    // 重复提交，然后拿到 A 的答案。`maxSteps` 也进——轮次上限不同，
    // 模型能查到的东西就不同，那是另一个问题
    dedupeKey: dedupeKeyOf("ask", root, { question, maxSteps }),
    traceId: traceOf(ctx),
    meta: { question },
    timeoutMs: TIMEOUTS.task.ask,
    run: ({ emit, emitText, signal }) =>
      runAskJob(root, question, model, emit, maxSteps, emitText, signal),
  });
});

/**
 * 某个仓库的任务历史。
 *
 * ## 为什么必须有这条路由
 *
 * 在它之前，taskId 只活在发起它的那个页面里：前端记在 localStorage
 * 一条，刷新能接回来，**关掉标签页就再也没有入口**。而 taskId 是
 * randomUUID，用户不可能记住，也就是说——**一个没被记下来的任务，
 * 等于从来没跑过。**
 *
 * 「能寻址」和「能被发现」是两件事：`/tasks/:taskId` 解决前者，
 * 前提是你手里已经有编号；这条解决后者。
 *
 * ## 内存和归档的关系：谁覆盖谁
 *
 * 归档在任务开始时就写了，所以它是全集，内存只是其中还活着的那部分。
 * 合并时**让内存覆盖归档**：正在跑的任务，`currentStep` 每秒都在变，
 * 而归档只有开始和结束两次写入——**读归档拿到的是它开跑那一刻的样子。**
 *
 * 反过来，SQLite 不可用时归档是空的，这时内存就是唯一的来源。
 * 所以这里不是「二选一」，是**并集，内存优先**。
 */
router.get("/tasks", (ctx) => {
  const root = requireRoot(ctx, typeof ctx.query.root === "string" ? ctx.query.root : undefined);
  if (!root) return;

  const requested = Number(ctx.query.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : 20;

  const live = listTasks().filter((record) => record.root === root);
  const liveIds = new Set(listTasks().map((record) => record.taskId));

  const merged = new Map<string, ArchivedTask>();
  for (const row of readTaskHistory(root, liveIds, limit)) merged.set(row.taskId, row);
  for (const record of live) {
    merged.set(record.taskId, {
      taskId: record.taskId,
      kind: record.kind,
      root: record.root,
      traceId: record.traceId,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      currentStep: record.currentStep,
      label: taskLabel(record),
      error: record.error,
      cancelReason: record.cancelReason,
      resultOmitted: false,
    });
  }

  const tasks = [...merged.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);

  ctx.body = { root, tasks, running: runningCount() };
});

/**
 * 单个任务的全量状态。
 *
 * 内存没有就回落查归档——**内存里查不到不等于这个任务不存在**，
 * 它可能只是被 `evictOld` 挤出去了，或者服务重启过。
 *
 * 回落需要 `?root=`，因为归档是**按仓库分库**存的（跟着
 * `.reposurgeon/index.db` 走）。这是分库换来可移植性的代价：
 * 不带 root 就只能在内存里找。前端从历史列表点进来时本来就知道当前仓库，
 * 带上它不构成负担。
 */
router.get("/tasks/:taskId", (ctx) => {
  const record = getTask(ctx.params.taskId);
  if (record) {
    ctx.body = toResponse(record);
    return;
  }

  const archived = fromArchive(ctx, ctx.params.taskId);
  if (archived) {
    ctx.body = archived;
    return;
  }

  ctx.status = 404;
  ctx.body = { error: "task not found" };
});

/** 内存未命中时按 `?root=` 去归档里找同一个任务 */
function fromArchive(ctx: Koa.Context, taskId: string) {
  const raw = typeof ctx.query.root === "string" ? ctx.query.root : "";
  if (!raw || !isDirectory(raw)) return undefined;

  const liveIds = new Set(listTasks().map((item) => item.taskId));
  const archived = readArchivedTask(path.resolve(raw), taskId, liveIds);
  if (!archived) return undefined;

  // 形状必须和 `toResponse` 完全一致——前端渲染结果的那段代码
  // **不该知道这份数据是从内存来的还是从库里来的**
  return {
    taskId: archived.taskId,
    kind: archived.kind,
    status: archived.status,
    currentStep: archived.currentStep,
    startedAt: archived.startedAt,
    finishedAt: archived.finishedAt,
    error: archived.error,
    failure: archived.failure,
    cancelReason: archived.cancelReason,
    traceId: archived.traceId,
    root: archived.root,
    events: archived.events,
    result: archived.result,
    // 归档特有：结果因为太大没存，界面要能解释「为什么点进来没有结果」
    resultOmitted: archived.resultOmitted,
    archived: true,
  };
}

/**
 * 探针：客户端心跳超时之后，先问一句「你还转得动吗」。
 *
 * ## 为什么不复用上面那个 `/tasks/:taskId`
 *
 * 那个返回全量 `events` 和 `result`——**成本随任务大小增长**，
 * 一次分析的 result 是几 MB。用它当探针会越探越贵，
 * 而探针恰恰是在服务端已经吃力的时候才发的。
 *
 * 独立一条路由，是为了**把「便宜」这件事写在 URL 里**：
 * 换成给老接口加个 `?brief=1`，迟早有人忘了带。
 *
 * ## 它真正的用途不是它的返回值
 *
 * 客户端要区分两种「收不到心跳」：链路假死（该立刻重连）和服务端
 * 事件循环被钉死（**绝不能重连**，重连会触发全量回放，火上浇油）。
 * 这两种在客户端看来一模一样。
 *
 * 所以这个接口的信息量主要在**它答不答得上来**——事件循环被钉死时
 * 它也一样排不上队，那个超时本身就是答案。返回值只是顺带回答了
 * 第二个问题：任务是不是其实已经结束了（`done` 帧丢了的情况）。
 *
 * 这也是为什么这件事必须**客户端主动探**，而不是服务端主动上报：
 * **能上报的前提是还没坏透**，而那正是出问题时最先失去的能力。
 */
router.get("/tasks/:taskId/summary", (ctx) => {
  const record = getTask(ctx.params.taskId);
  if (!record) {
    // 探针也要能看见归档：从历史列表点进一条早就结束的任务时，
    // 客户端问的第一句仍然是「它还在不在」。答不上来的话，
    // 界面只能显示「任务不存在」——**而它明明就在列表里躺着**
    const archived = fromArchive(ctx, ctx.params.taskId);
    if (archived) {
      const { events: _events, result: _result, ...brief } = archived;
      ctx.body = { ...brief, running: runningCount() };
      return;
    }
    ctx.status = 404;
    ctx.body = { error: "task not found" };
    return;
  }
  // 顺带把当前负载告诉客户端。它不需要据此做决定（拒绝是服务端的事），
  // 但排障时「那一刻服务端在跑几个任务」是最想知道的一个数
  ctx.body = { ...summaryOf(record), running: runningCount() };
});

/**
 * 停止一个任务。
 *
 * 必须有一个真实的服务端接口——前端把连接断开只是「不看了」，
 * 后台该跑还跑、该烧的 token 一个不少。**「停止生成」如果只做前端，
 * 那是障眼法。**
 *
 * 幂等：重复取消、取消一个已结束的任务，都返回它当前的状态而不是报错。
 * 用户连点两下停止是常态。
 */
router.post("/tasks/:taskId/cancel", (ctx) => {
  const record = cancelTask(ctx.params.taskId);
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: "task not found" };
    return;
  }
  ctx.body = summaryOf(record);
});

router.get("/tasks/:taskId/events", (ctx) => {
  const record = getTask(ctx.params.taskId);
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: "task not found" };
    return;
  }

  ctx.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  ctx.status = 200;

  // 浏览器重连时自动带上这个头，服务端只补发它之后的事件。
  // 不读它的话重连会把整条时间线再推一遍
  const stream = attachStream(record, ctx.headers["last-event-id"] as string | undefined);
  ctx.body = stream;
  ctx.req.on("close", () => stream.destroy());
});

/** 目录浏览时跳过的噪音目录，避免用户在一堆无关目录里翻找 */
const BROWSE_SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
]);

/**
 * 目录浏览。
 *
 * 浏览器出于安全限制拿不到本地目录的绝对路径（`webkitdirectory` 与
 * File System Access API 都只给相对路径或句柄），所以目录选择必须由
 * 后端提供——服务本来就跑在 127.0.0.1 上，读的是同一台机器的文件系统。
 * 只返回目录名，不返回任何文件内容。
 */
router.get("/fs/browse", (ctx) => {
  const requested =
    typeof ctx.query.path === "string" && ctx.query.path ? ctx.query.path : homedir();
  const current = path.resolve(requested);

  if (!isDirectory(current)) {
    ctx.status = 404;
    ctx.body = { error: `not a directory: ${current}` };
    return;
  }

  let entries: Array<{ name: string; path: string; isRepo: boolean; analyzed: boolean }>;
  try {
    entries = readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => !entry.name.startsWith(".") && !BROWSE_SKIP.has(entry.name))
      .map((entry) => {
        const full = path.join(current, entry.name);
        return {
          name: entry.name,
          path: full,
          isRepo: existsSync(path.join(full, "package.json")),
          analyzed: existsSync(path.join(full, ".reposurgeon", "index.db")),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    ctx.status = 403;
    ctx.body = { error: error instanceof Error ? error.message : String(error) };
    return;
  }

  const parent = path.dirname(current);

  ctx.body = {
    path: current,
    parent: parent === current ? null : parent,
    isRepo: existsSync(path.join(current, "package.json")),
    analyzed: existsSync(path.join(current, ".reposurgeon", "index.db")),
    entries,
  };
});

/**
 * 根据目录名与顶层条目指纹反查绝对路径。
 *
 * 浏览器不会给出所选目录的绝对路径，但本服务就在同一台机器上，
 * 由它来定位即可。实现见 locate.ts。
 */
router.post("/fs/locate", (ctx) => {
  const body = (ctx.request.body ?? {}) as { name?: string } & Fingerprint;
  if (!body.name) {
    ctx.status = 400;
    ctx.body = { error: "name is required" };
    return;
  }

  ctx.body = locateDirectories(body.name, {
    entries: body.entries,
    packageHash: body.packageHash,
    packageName: body.packageName,
  });
});

/** 常用起点，省去用户从根目录一级级点进来 */
router.get("/fs/roots", (ctx) => {
  const candidates = [
    { label: "当前工作目录", path: process.cwd() },
    { label: "用户主目录", path: homedir() },
  ];
  ctx.body = { roots: candidates.filter((item) => isDirectory(item.path)) };
});

/**
 * 某个仓库的历史分析记录。
 *
 * CLI 与 API 是两个进程，内存不共享；但 `pnpm analyze` 的产物写在目标仓库的
 * .reposurgeon/index.db 里，读它就能在 Web 端看到命令行跑过的结果。
 */
router.get("/repo/runs", (ctx) => {
  const root = typeof ctx.query.root === "string" ? ctx.query.root : "";
  if (!root || !isDirectory(root)) {
    ctx.status = 400;
    ctx.body = { error: "root must be an existing directory" };
    return;
  }
  ctx.body = { root: path.resolve(root), runs: readRunSummaries(root) };
});

/** 最近一次分析的完整报告，用于直接在 Web 端查看 CLI 的分析结果 */
router.get("/repo/runs/latest", (ctx) => {
  const root = typeof ctx.query.root === "string" ? ctx.query.root : "";
  if (!root || !isDirectory(root)) {
    ctx.status = 400;
    ctx.body = { error: "root must be an existing directory" };
    return;
  }

  const report = readLatestRun(root);
  if (!report) {
    ctx.status = 404;
    ctx.body = { error: "no previous analysis found for this repository" };
    return;
  }
  ctx.body = { root: path.resolve(root), report };
});

/** 取本次请求的 trace-id。中间件保证它一定存在 */
function traceOf(ctx: Koa.Context): string {
  return (ctx.state.trace as TraceContext).traceId;
}

/** 三种任务的受理响应格式一致，客户端只认 statusUrl / eventsUrl */
function accepted(ctx: Koa.Context, record: TaskRecord, reused = false): void {
  ctx.status = 202;
  ctx.body = {
    taskId: record.taskId,
    kind: record.kind,
    status: record.status,
    statusUrl: `/tasks/${record.taskId}`,
    eventsUrl: `/tasks/${record.taskId}/events`,
    // 独立于 statusUrl：那个返回全量 events + result，**成本随任务大小增长**，
    // 当探针用会越探越贵。这条只回十来个标量字段
    probeUrl: `/tasks/${record.taskId}/summary`,
    // 复用了一个在跑的任务，不是新建的。前端据此可以不重置已有界面
    reused,
    // 客户端以服务端回的这个为准：我们可能因为解析不出而另生成了一个，
    // 排障时要对上的是**服务端日志里那个**
    traceId: record.traceId,
  };
}

/**
 * 提交一个任务：去重 → 闸门 → 开工，**一步做完**。
 *
 * ## 为什么是一个函数，而不是「先判定、再建任务」
 *
 * 它此前是 `admitted(ctx, ...)` 加 `startTask(...)` 两步。那两步之间是
 * 一段**隐式的临界区**：只要中间插进一次 `await`，两个同时到达的请求就会
 * 双双通过判定，各建一个任务、各烧一次 token——而且不报错。
 *
 * 当时它是安全的，靠的是「三条路由的 handler 恰好都是同步的」。
 * 那是一条**没写下来、也没人守得住的不变量**。合成一个函数之后，
 * 这件事由函数边界保证，不再依赖谁记得。
 *
 * ## 为什么键由调用方传
 *
 * 「哪些参数会改变结果」**只有路由自己知道**：ask 是 question，
 * refactor 是 apply，analyze 是 query。放进这里推导，等于每加一种模式
 * 都要回来改这个函数，而漏改不报错——那正是这次要修的 bug 的成因。
 */
function submit<TResult>(
  ctx: Koa.Context,
  input: StartTaskInput<TResult> & { dedupeKey: string },
): void {
  const admission = admitOrStart(input);

  if (admission.decision === "reuse") {
    log("task.reuse", {
      traceId: traceOf(ctx),
      taskId: admission.record.taskId,
      kind: input.kind,
      // 复用掉的这次提交本来会变成一个新任务，值得留痕：
      // 「用户点了几次」和「跑了几次」的差值就在这条日志里
      reusedTraceId: admission.record.traceId,
    });
    accepted(ctx, admission.record, true);
    return;
  }

  if (admission.decision === "busy") {
    log("task.reject", { traceId: traceOf(ctx), kind: input.kind, running: admission.running });
    ctx.status = 429;
    // 429 在客户端的 isRetriable 里是**可重试**的，界面会给重试入口。
    // 这正是想要的：现在忙不代表这个请求本身有问题
    ctx.set("Retry-After", "30");
    ctx.body = {
      error: `同时进行的任务已达上限（${admission.running} 个），请等前面的跑完再试`,
      running: admission.running,
    };
    return;
  }

  accepted(ctx, admission.record as TaskRecord);
}

/**
 * 校验 root 并返回绝对路径。
 *
 * 不校验的话，不存在的路径会一路跑到底并产出一份「0 文件」的空报告，
 * 看起来像成功了。
 */
function requireRoot(ctx: Koa.Context, root?: string): string | undefined {
  if (!root) {
    ctx.status = 400;
    ctx.body = { error: "root is required" };
    return undefined;
  }
  if (!isDirectory(root)) {
    ctx.status = 400;
    ctx.body = { error: `root is not an existing directory: ${root}` };
    return undefined;
  }
  return path.resolve(root);
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

app.use(bodyParser()).use(router.routes()).use(router.allowedMethods());

app.listen(API_PORT, "127.0.0.1", () => {
  console.log(`Repo Surgeon API listening on http://127.0.0.1:${API_PORT}`);
});
