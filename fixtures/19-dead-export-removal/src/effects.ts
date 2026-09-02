let counter = 0;

function register(): number {
  counter += 1;
  return counter;
}

// 没有外部引用者，但初始化表达式是函数调用 —— 删掉就少执行一次 register()
export const registered = register();

export const activeFlag = true;
