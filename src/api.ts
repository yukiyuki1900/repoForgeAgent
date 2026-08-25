import Koa from "koa";
// @koa/bodyparser v5 只有命名导出，默认导入会拿到模块命名空间对象
import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AnalysisResult } from "./model.js";
import type { QueryPlan, RetrievalResult } from "./retrieval.js";
import { loadEnv } from "./env.js";
import { locateDirectories, type Fingerprint } from "./locate.js";
import { readLatestRun, readRunSummaries } from "./storage.js";
import { runAnalysis, type ProgressEvent } from "./workflow.js";

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

type RunStatus = "running" | "completed" | "failed";

interface RunResult {
  report?: AnalysisResult;
  queryPlan?: QueryPlan;
  retrieval: RetrievalResult[];
}

interface RunRecord {
  runId: string;
  root: string;
  query?: string;
  status: RunStatus;
  currentStep: string;
  startedAt: string;
  finishedAt?: string;
  /** 已发生的事件，供后接入的订阅者回放，避免错过前面的进度 */
  events: ProgressEvent[];
  subscribers: Set<PassThrough>;
  /**
   * 只保留最终产物，不持有整个 WorkflowState——后者含有 contents（全仓源码），
   * 几次分析就足以把常驻内存推到 GB 级。
   */
  result?: RunResult;
  error?: string;
}

const app = new Koa();
const router = new Router();
const runs = new Map<string, RunRecord>();

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
 * 提交分析任务：立刻返回 runId，分析在后台执行。
 *
 * 此前是同步阻塞实现，稍大的仓库必然请求超时。
 */
router.post("/analysis", (ctx) => {
  const body = (ctx.request.body ?? {}) as { root?: string; query?: string };
  if (!body.root) {
    ctx.status = 400;
    ctx.body = { error: "root is required" };
    return;
  }

  // 不校验的话，不存在的路径会一路跑到底并产出一份「0 文件」的空报告，
  // 看起来像分析成功了
  if (!isDirectory(body.root)) {
    ctx.status = 400;
    ctx.body = { error: `root is not an existing directory: ${body.root}` };
    return;
  }

  const runId = randomUUID();
  const record: RunRecord = {
    runId,
    root: body.root,
    query: body.query,
    status: "running",
    currentStep: "start",
    startedAt: new Date().toISOString(),
    events: [],
    subscribers: new Set(),
  };
  runs.set(runId, record);
  evictOldRuns();

  // 不 await：请求立即返回，进度通过 SSE 推送
  void execute(record);

  ctx.status = 202;
  ctx.body = {
    runId,
    status: record.status,
    statusUrl: `/analysis/${runId}`,
    eventsUrl: `/analysis/${runId}/events`,
  };
});

router.get("/analysis/:runId", (ctx) => {
  const record = runs.get(ctx.params.runId);
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: "analysis run not found" };
    return;
  }
  ctx.body = toResponse(record);
});

/**
 * 节点级进度流。
 *
 * 连接建立时先回放已发生的事件，再订阅后续事件；无论任务是否已经结束，
 * 结束时都统一以 `done` 事件收尾并关闭流，两条路径的协议完全一致。
 */
router.get("/analysis/:runId/events", (ctx) => {
  const record = runs.get(ctx.params.runId);
  if (!record) {
    ctx.status = 404;
    ctx.body = { error: "analysis run not found" };
    return;
  }

  ctx.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  ctx.status = 200;

  const stream = new PassThrough();
  ctx.body = stream;

  for (const event of record.events) {
    stream.write(formatEvent("progress", event));
  }

  if (record.status !== "running") {
    stream.write(formatEvent("done", summaryOf(record)));
    stream.end();
    return;
  }

  record.subscribers.add(stream);

  const cleanup = () => record.subscribers.delete(stream);
  stream.on("close", cleanup);
  ctx.req.on("close", cleanup);
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
  const requested = typeof ctx.query.path === "string" && ctx.query.path ? ctx.query.path : homedir();
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

async function execute(record: RunRecord): Promise<void> {
  try {
    const state = await runAnalysis(record.root, {
      query: record.query,
      runId: record.runId,
      onProgress: (event) => publish(record, event),
    });
    record.result = {
      report: state.report,
      queryPlan: state.queryPlan,
      retrieval: state.retrieval,
    };
    record.status = "completed";
  } catch (error) {
    record.status = "failed";
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    record.finishedAt = new Date().toISOString();
    finishSubscribers(record);
  }
}

function publish(record: RunRecord, event: ProgressEvent): void {
  record.events.push(event);
  if (event.phase === "start") record.currentStep = event.node;

  const payload = formatEvent("progress", event);
  for (const stream of record.subscribers) {
    stream.write(payload);
  }
}

/** 终态统一走 done 事件并关闭流，否则标准 SSE 客户端会一直挂着 */
function finishSubscribers(record: RunRecord): void {
  const payload = formatEvent("done", summaryOf(record));
  for (const stream of record.subscribers) {
    stream.write(payload);
    stream.end();
  }
  record.subscribers.clear();
}

/** done 事件只带轻量摘要，完整报告由客户端按需拉 statusUrl */
function summaryOf(record: RunRecord) {
  return {
    runId: record.runId,
    status: record.status,
    currentStep: record.currentStep,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
  };
}

function toResponse(record: RunRecord) {
  return {
    runId: record.runId,
    status: record.status,
    currentStep: record.currentStep,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    events: record.events,
    report: record.result?.report,
    queryPlan: record.result?.queryPlan,
    retrieval: record.result?.retrieval ?? [],
  };
}

function formatEvent(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function evictOldRuns(): void {
  const finished = [...runs.values()]
    .filter((record) => record.status !== "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  for (const record of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_RUNS))) {
    runs.delete(record.runId);
  }
}

app.use(bodyParser()).use(router.routes()).use(router.allowedMethods());

app.listen(API_PORT, "127.0.0.1", () => {
  console.log(`Repo Surgeon API listening on http://127.0.0.1:${API_PORT}`);
});
