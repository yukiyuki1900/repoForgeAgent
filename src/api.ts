import Koa from "koa";
// @koa/bodyparser v5 只有命名导出，默认导入会拿到模块命名空间对象
import { bodyParser } from "@koa/bodyparser";
import Router from "@koa/router";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { PassThrough } from "node:stream";
import type { AnalysisResult } from "./model.js";
import type { QueryPlan, RetrievalResult } from "./retrieval.js";
import { runAnalysis, type ProgressEvent } from "./workflow.js";

const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
const DEFAULT_PORT = 3100;
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

app.listen(Number(process.env.PORT ?? DEFAULT_PORT), "127.0.0.1", () => {
  console.log("Repo Surgeon API listening");
});
