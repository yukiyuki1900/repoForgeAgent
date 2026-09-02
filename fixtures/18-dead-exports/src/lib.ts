// package.json 的 main 指向 dist/lib.js，回推到这里，同样是对外入口
export function publicApi(): string {
  return "public";
}
