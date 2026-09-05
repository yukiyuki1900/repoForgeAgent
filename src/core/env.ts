import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 极简 .env 加载。
 *
 * 不引入 dotenv：需要的只是 KEY=VALUE 与注释，十几行就够，
 * 而且能明确控制两条语义——
 *   1. 已经显式 export 的环境变量优先，命令行永远压过配置文件
 *   2. .env.local 覆盖 .env，便于本地放私密值而不动提交进仓库的模板
 *
 * Node 的 --env-file 在文件不存在时会直接报错，不适合「可选配置」场景。
 */
const FILES = [".env", ".env.local"];

export function loadEnv(cwd: string = process.cwd()): void {
  for (const name of FILES) {
    const file = path.join(cwd, name);
    if (!existsSync(file)) continue;

    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const entry = parseLine(line);
      if (!entry) continue;
      // 后加载的文件可以覆盖先加载的，但都不覆盖真实环境变量
      if (process.env[entry.key] === undefined) process.env[entry.key] = entry.value;
    }
  }
}

function parseLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const separator = trimmed.indexOf("=");
  if (separator <= 0) return undefined;

  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();

  // 允许用引号包裹含空格的值
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) value = value.slice(1, -1);

  return { key, value };
}
