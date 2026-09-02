// 对照组：被 index.ts 引用，绝不能出现在死导出列表里
export function formatName(name: string): string {
  return name.trim();
}
