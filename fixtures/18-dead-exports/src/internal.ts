// buildUrl 只在本文件里用 —— 该报，但改法是「去掉 export」而不是删声明
export function buildUrl(base: string): string {
  return `${base}/api`;
}

// callApi 谁都没用 —— 该报，且可以整条删除
export function callApi(): string {
  return buildUrl("https://example.com");
}
