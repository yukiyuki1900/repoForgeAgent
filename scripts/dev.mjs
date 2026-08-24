#!/usr/bin/env node
/**
 * 同时启动 API 与 Web 看板。
 *
 * 直接用 `pnpm api & pnpm web:dev` 有两个问题：两者输出混在一起分不清来源，
 * 而且 API 启动失败会被 Vite 的成功日志盖过去——页面能打开，但所有接口都不通，
 * 看起来像是「界面有问题」，实际是后端根本没起来。
 *
 * 这里给每行输出加来源前缀，并且任一进程异常退出就立刻停掉另一个并报错。
 */
import { spawn } from "node:child_process";
import net from "node:net";

const RESET = "\x1b[0m";

// 专用变量名：通用的 PORT 会被容器 / CI 注入，导致监听到意外端口
const API_PORT = Number(process.env.REPOSURGEON_API_PORT ?? 3100);
const WEB_PORT = Number(process.env.REPOSURGEON_WEB_PORT ?? 5173);

const TASKS = [
  { name: "api", args: ["api"], color: "\x1b[36m" },
  { name: "web", args: ["web:dev"], color: "\x1b[35m" },
];

const children = [];
let shuttingDown = false;

function shutdown(reason, code) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.error(`\n\x1b[31m[dev]${RESET} ${reason}，正在停止其余进程`);
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = code;
}

/** 按行加前缀，避免两个进程的输出交错成一团 */
function pipeWithPrefix(stream, target, prefix) {
  stream.setEncoding("utf8");
  let pending = "";

  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) target.write(`${prefix}${line}\n`);
  });

  stream.on("end", () => {
    if (pending) target.write(`${prefix}${pending}\n`);
  });
}

/**
 * 端口是否已被占用。
 *
 * 端口被上一轮没退干净的进程占着，是最容易误导人的故障：新进程起不来，
 * 但浏览器照常能打开页面——连的其实是**跑着旧代码的旧进程**，
 * 于是「改了代码没生效」「警告又出现了」这类现象全都对不上。
 */
function isPortBusy(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", (error) => resolve(error.code === "EADDRINUSE"));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, "127.0.0.1");
  });
}

async function ensurePortsFree() {
  const busy = [];
  for (const [name, port] of [
    ["API", API_PORT],
    ["看板", WEB_PORT],
  ]) {
    if (await isPortBusy(port)) busy.push({ name, port });
  }
  if (busy.length === 0) return;

  const list = busy.map((item) => `${item.name}(${item.port})`).join("、");
  console.error(
    `\x1b[31m[dev]${RESET} 端口已被占用：${list}\n` +
      `\x1b[31m[dev]${RESET} 很可能是上一轮的进程没退干净——它跑的是旧代码，\n` +
      `      继续启动会出现「页面能开但改动不生效」的假象。\n\n` +
      `  先终止：pnpm stop\n` +
      `  再启动：pnpm dev\n`,
  );
  process.exit(1);
}

await ensurePortsFree();

for (const task of TASKS) {
  const child = spawn("pnpm", task.args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  children.push(child);

  const prefix = `${task.color}[${task.name}]${RESET} `;
  pipeWithPrefix(child.stdout, process.stdout, prefix);
  pipeWithPrefix(child.stderr, process.stderr, prefix);

  child.on("error", (error) => shutdown(`${task.name} 启动失败：${error.message}`, 1));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code === 0) {
      shutdown(`${task.name} 已退出`, 0);
      return;
    }
    shutdown(`${task.name} 异常退出（code ${code ?? signal}）`, code ?? 1);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown("收到中断信号", 0));
}

console.log(
  `\x1b[32m[dev]${RESET} API → http://127.0.0.1:3100    看板 → http://127.0.0.1:5173\n` +
    `\x1b[32m[dev]${RESET} 任一进程异常退出都会停止另一个，不会出现「页面能开但接口全挂」的情况\n`,
);
