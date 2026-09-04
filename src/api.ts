import Koa from "koa";
// @koa/bodyparser v5 只有命名导出，默认导入会拿到模块命名空间对象
import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { loadEnv } from "./env.js";
import { runAskJob, runRefactorJob } from "./jobs.js";
import { resolveModel } from "./llm.js";
import { locateDirectories, type Fingerprint } from "./locate.js";
import { readLatestRun, readRunSummaries } from "./storage.js";
import {
  attachStream,
  cancelTask,
  getTask,
  startTask,
  summaryOf,
  toResponse,
  type TaskRecord,
} from "./tasks.js";
import { runAnalysis } from "./workflow.js";
import { TIMEOUTS } from "./limits.js";

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

app.use(async (ctx, next) => {
  ctx.set("Access-Control-Allow-Origin", WEB_ORIGIN);
  ctx.set("Access-Control-Allow-Headers", "Content-Type");
  ctx.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (ctx.method === "OPTIONS") {
    ctx.status = 204;
    return;
  }
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

  const record = startTask({
    kind: "analyze",
    root,
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

  accepted(ctx, record);
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

  const record = startTask({
    kind: "refactor",
    root,
    meta: { apply: shouldApply },
    timeoutMs: TIMEOUTS.task.refactor,
    run: ({ emit }) => runRefactorJob(root, shouldApply, emit),
  });

  accepted(ctx, record);
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
    ctx.body = {
      error:
        "ask 需要模型：确定性分析可以没有 LLM，但「自己决定查什么」不行。请在 .env 配置 OPENAI_API_KEY",
    };
    return;
  }

  const record = startTask({
    kind: "ask",
    root,
    meta: { question },
    timeoutMs: TIMEOUTS.task.ask,
    run: ({ emit, emitText, signal }) =>
      runAskJob(root, question, model, emit, Number(body.maxSteps) || undefined, emitText, signal),
  });

  accepted(ctx, record);
});

router.get("/tasks/:taskId", (ctx) => {
  const record = getTask(ctx.params.taskId);
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: "task not found" };
    return;
  }
  ctx.body = toResponse(record);
});

/**
 * 停止一个任务。
 *
 * 必须有一个真实的服务端接口——前端把 EventSource 关掉只是「不看了」，
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

/** 三种任务的受理响应格式一致，客户端只认 statusUrl / eventsUrl */
function accepted(ctx: Koa.Context, record: TaskRecord): void {
  ctx.status = 202;
  ctx.body = {
    taskId: record.taskId,
    kind: record.kind,
    status: record.status,
    statusUrl: `/tasks/${record.taskId}`,
    eventsUrl: `/tasks/${record.taskId}/events`,
  };
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
