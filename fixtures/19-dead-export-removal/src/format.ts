// 没有外部引用者，但 render 还在用 —— 去掉 export，声明保留
// 与 config.ts 的区别在于这里是函数声明，走的是另一条改写分支
export function pad(value: string): string {
  return ` ${value} `;
}

export function render(value: string): string {
  return pad(value);
}
