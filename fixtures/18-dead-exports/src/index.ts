import { formatName } from "./used";

// 约定入口文件：这两个导出没有仓库内引用，但它们就是对外 API
export function greet(name: string): string {
  return `hi ${formatName(name)}`;
}

export const VERSION = "1.0.0";
