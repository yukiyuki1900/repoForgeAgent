// 没有外部引用者，但 readConfig 还在用它 —— 只能去掉 export，不能删声明
export const internalPath = "/api";

export function readConfig(): string {
  return internalPath;
}
