#!/usr/bin/env node
/**
 * 终止占用本项目端口的残留进程。
 *
 * `pnpm api & pnpm web:dev` 这种启动方式下，Ctrl+C 只中断前台的 Vite，
 * 后台的 API 会活下来继续占着端口。下次启动时新进程抢不到端口直接退出，
 * 页面却照常能打开——连的是跑着旧代码的旧进程。
 * 「改了代码不生效」「已修复的警告又出现」多半都是这么来的。
 *
 * 安全前提：只终止**确认属于本项目**的进程。端口上跑着别人的服务时
 * 只提示不动手——曾经因为读了通用的 PORT 环境变量而误杀无关进程。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PORTS = [
  { label: "API", port: Number(process.env.REPOSURGEON_API_PORT ?? 3100) },
  { label: "看板", port: Number(process.env.REPOSURGEON_WEB_PORT ?? 5173) },
];

/** 本项目进程的特征：命令行里同时出现项目路径与已知入口 */
const ENTRY_HINTS = ["src/api.ts", "scripts/dev.mjs", "vite", "web:dev"];

const force = process.argv.includes("--force");

function findPids(port) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      const pids = new Set();
      for (const line of output.split("\n")) {
        if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== "0") pids.add(pid);
      }
      return [...pids];
    }

    const output = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    return output.split("\n").filter(Boolean);
  } catch {
    // lsof / netstat 没有匹配项时退出码非 0，属正常情况
    return [];
  }
}

function commandOf(pid) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "wmic",
        ["process", "where", `ProcessId=${pid}`, "get", "CommandLine"],
        { encoding: "utf8" },
      );
      return output.split("\n").slice(1).join(" ").trim();
    }
    return execFileSync("ps", ["-p", pid, "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function belongsToProject(command) {
  if (!command) return false;
  const inProject = command.includes(PROJECT_ROOT);
  const hasEntry = ENTRY_HINTS.some((hint) => command.includes(hint));
  return inProject && hasEntry;
}

function kill(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

let stopped = 0;
let skipped = 0;

for (const { label, port } of PORTS) {
  const pids = findPids(port);
  if (pids.length === 0) {
    console.log(`${label} 端口 ${port}：空闲`);
    continue;
  }

  for (const pid of pids) {
    const command = commandOf(pid);
    const mine = belongsToProject(command);

    if (!mine && !force) {
      skipped += 1;
      console.log(
        `${label} 端口 ${port}：PID ${pid} 不属于本项目，已跳过\n` +
          `    ${command || "（无法读取命令行）"}\n` +
          `    确认要终止请执行：pnpm stop --force`,
      );
      continue;
    }

    const ok = kill(pid);
    stopped += ok ? 1 : 0;
    console.log(`${label} 端口 ${port}：${ok ? "已终止" : "终止失败"} PID ${pid}`);
  }
}

if (stopped > 0) {
  console.log(`\n已终止 ${stopped} 个进程，现在可以执行 pnpm dev`);
} else if (skipped > 0) {
  console.log("\n没有终止任何进程：端口被其它程序占用");
} else {
  console.log("\n没有需要终止的进程");
}
