// 真正的死导出：仓库内没有任何引用
export function unusedHelper(value: string): string {
  return value.toUpperCase();
}

export interface UnusedOptions {
  retries: number;
}
