export function activeHelper(): string {
  return "active";
}

// 文件内外都没人用，且函数声明求值无副作用 —— 可以整条删掉
export function deadHelper(): string {
  return "dead";
}
