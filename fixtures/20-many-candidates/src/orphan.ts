// 整个文件死透：两个导出都没人用、没有任何文件 import 它、顶层无副作用。
// 这是候选池里最该排在最前面的一类
export function forgotten(): string {
  return "forgotten";
}

export interface ForgottenOptions {
  retries: number;
}
