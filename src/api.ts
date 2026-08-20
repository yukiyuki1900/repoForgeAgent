import Koa from "koa";
import bodyParser from "@koa/bodyparser";
import Router from "@koa/router";
import { randomUUID } from "node:crypto";
import { runAnalysis, type WorkflowState } from "./workflow.js";

const WEB_ORIGIN = "http://127.0.0.1:5173";
const DEFAULT_PORT = 3100;

const app = new Koa();
const router = new Router();
const runs = new Map<string, WorkflowState>();

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
 * 注意：当前是同步阻塞实现，请求会一直等到整个分析流程结束。
 * 大仓库上容易超时，后续需要改为后台任务 + SSE 进度推送。
 */
router.post("/analysis", async (ctx) => {
  const body = (ctx.request.body ?? {}) as { root?: string; query?: string };
  if (!body.root) {
    ctx.status = 400;
    ctx.body = { error: "root is required" };
    return;
  }

  const runId = randomUUID();
  const state = await runAnalysis(body.root, body.query, runId);
  runs.set(runId, state);

  ctx.body = toResponse(runId, state);
});

router.get("/analysis/:runId", (ctx) => {
  const state = runs.get(ctx.params.runId);
  if (!state) {
    ctx.status = 404;
    ctx.body = { error: "analysis run not found" };
    return;
  }

  ctx.body = toResponse(ctx.params.runId, state);
});

function toResponse(runId: string, state: WorkflowState) {
  return {
    runId,
    status: state.report ? "completed" : "running",
    currentStep: state.currentStep,
    report: state.report,
    queryPlan: state.queryPlan,
    retrieval: state.retrieval,
  };
}

app.use(bodyParser()).use(router.routes()).use(router.allowedMethods());

app.listen(Number(process.env.PORT ?? DEFAULT_PORT), "127.0.0.1", () => {
  console.log("Repo Surgeon API listening");
});
