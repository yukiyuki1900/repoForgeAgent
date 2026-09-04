/**
 * W3C Trace Context。
 *
 * 规范：https://www.w3.org/TR/trace-context/
 *
 * ## 它解决什么
 *
 * 一次请求穿过多个服务时，让所有服务知道「我们在处理同一件事」。
 * 在它之前每家 APM 一套自己的头（Zipkin 的 `X-B3-*`、Jaeger 的
 * `uber-trace-id`、Datadog 的 `x-datadog-*`），跨厂商调用链路直接断掉。
 *
 * ```
 * traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *              ─┬ ────────────────┬─────────────── ───────┬──────── ─┬
 *            version           trace-id                span-id    flags
 *            2 hex           32 hex（16 字节）        16 hex（8 字节）  2 hex
 * ```
 *
 * **trace-id 全程不变，span-id 每一跳都换**（接收方把收到的 span-id
 * 当作自己的 parent）。flags 目前只定义了最低位：`01` = 采样。
 *
 * ## 这个项目用得上它的哪一半
 *
 * **说实话：只用得上 trace-id。** 这是个单进程工具，没有第二个服务要
 * 传播、没有 collector，span 的父子树只有一层——那套机制在这儿是摆设。
 *
 * 还是按标准来，是因为两件事：
 *
 * 1. **浏览器算真正的第二跳。** 客户端一段、服务端一段，是货真价实的
 *    两段链路——正好对应要解决的那个问题：用户说「卡住了」，
 *    **能用这个 id 在服务端日志里找到他那次请求**。
 * 2. 成本是十几行，而自造格式将来接 APM 一定要改。
 *
 * 顺带一提，`traceparent` **不在 CORS 安全清单里**，跨域要显式配
 * `Access-Control-Allow-Headers`；而 `EventSource` 压根发不了自定义头——
 * 这是「EventSource 排障做不下去」最硬的一条实证：不是麻烦，是做不到。
 */

import { randomBytes } from "node:crypto";

export interface TraceContext {
  /** 整条链路的标识，32 位小写十六进制 */
  traceId: string;
  /** 当前这一段的标识，16 位小写十六进制 */
  spanId: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE = "0".repeat(32);
const ALL_ZERO_SPAN = "0".repeat(16);

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function newTrace(): TraceContext {
  return { traceId: hex(16), spanId: hex(8) };
}

/**
 * 解析客户端送来的 `traceparent`。
 *
 * **解析不出来就自己生成一个，绝不抛错。** 这个头来自客户端，可能是任何
 * 东西——旧版本、代理改写、伪造。为一个**只用于排障**的字段让请求失败，
 * 是把手段当成了目的。
 *
 * 全 0 的 trace-id / span-id 规范明令无效（它们是「未知」的占位值），
 * 有些中间件在丢失上下文时会填这个，照单全收会让所有这类请求挤成同一条链路。
 */
export function parseTraceparent(header: string | undefined): TraceContext {
  const match = header === undefined ? null : TRACEPARENT.exec(header.trim());
  if (!match) return newTrace();

  const [, version, traceId, spanId] = match;
  // `ff` 是规范保留的无效版本号
  if (version === "ff") return newTrace();
  if (traceId === ALL_ZERO_TRACE || spanId === ALL_ZERO_SPAN) return newTrace();

  // 收到的 span-id 是**对方**那一段。我们这一段要新开一个，
  // 它的 parent 才是收到的那个——trace-id 保持不变，链路才连得起来
  return { traceId, spanId: hex(8) };
}

/** 供人念的短号。排障时用户报的是这个，不是 32 位全长 */
export function shortTrace(traceId: string): string {
  return traceId.slice(0, 8);
}
