// 框架按名字查找的导出：静态引用分析永远看不到调用方
export function getServerSideProps(): { props: Record<string, never> } {
  return { props: {} };
}
