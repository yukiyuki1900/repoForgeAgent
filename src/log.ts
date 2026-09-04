/**
 * 结构化日志。
 *
 * ## 这是排障链条上缺的最后一环
 *
 * trace-id 之前已经能生成、能回传、能显示给用户了——但用户报了编号过来，
 * **服务端日志里搜不到它**。桥两头都搭好了，中间没铺板。
 *
 * 所以每一条日志都必须带 `traceId`。这不是「顺手加个字段」：
 * **不带它的日志，在排障时约等于不存在**——你能看到「有个任务失败了」，
 * 但对不上用户说的那一次。
 *
 * ## 为什么写 stderr 而不是 stdout
 *
 * **stdout 在这个项目里是协议通道。** `mcp.ts` 用 stdio transport 跟
 * Claude Code / Cursor 说 JSON-RPC，任何一行混进 stdout 的日志都会让
 * 客户端解析失败，而且报错完全看不出根因（`mcp.ts` 因此把 console.log
 * 整个改道到了 stderr）。
 *
 * 日志走 stderr 还有个额外好处：`pnpm analyze > report.txt` 这类重定向
 * 不会把日志混进产物里。
 *
 * ## 为什么是 JSON 行而不是给人看的格式
 *
 * 因为它的读者是 `grep` 和日志系统，不是人。一行一个对象，
 * `grep <编号>` 直接就能捞出一次请求的全部记录。
 */

export interface LogFields {
  /** 排障编号。**每条日志都必须有**，否则这条日志在排障时等于不存在 */
  traceId: string;
  [key: string]: unknown;
}

type Sink = (record: Record<string, unknown>) => void;

const stderrSink: Sink = (record) => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

const silent: Sink = () => {};

/**
 * 默认输出到 stderr，`REPOSURGEON_LOG=off` 可以彻底关掉。
 *
 * 测试里默认关掉：一百多个用例各起几个任务，日志会把断言失败的信息淹掉。
 * 真要断言日志内容的用例用 `captureLogs()` 单独开。
 */
let sink: Sink = process.env.REPOSURGEON_LOG === "off" ? silent : stderrSink;

export function log(event: string, fields: LogFields): void {
  sink({ ts: new Date().toISOString(), event, ...fields });
}

/**
 * 把日志接到一个数组上，返回收集到的记录和还原函数。
 *
 * 有这个出口，「失败时有没有记下编号」才是**可断言的**——
 * 否则这件事只能靠人跑一遍去看，而那等于没有保障。
 */
export function captureLogs(): { records: Record<string, unknown>[]; restore: () => void } {
  const previous = sink;
  const records: Record<string, unknown>[] = [];
  sink = (record) => records.push(record);
  return { records, restore: () => (sink = previous) };
}
