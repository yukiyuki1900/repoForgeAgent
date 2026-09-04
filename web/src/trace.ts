/**
 * 浏览器侧的 W3C Trace Context 生成。
 *
 * 格式说明见服务端的 `src/trace.ts`，那边有完整的取舍记录。
 * 这里只做一件事：**在请求发出之前就把 trace-id 定下来**。
 *
 * 顺序很关键——如果等服务端生成再回传，那么「请求根本没到服务端」
 * 的那一类失败（DNS、断网、代理拒绝）就永远没有编号，
 * 而**那恰恰是最需要编号的一类**。
 */

export interface TraceContext {
  traceId: string;
  spanId: string;
  /** 直接放进请求头的完整值 */
  traceparent: string;
}

function hex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function newTrace(): TraceContext {
  const traceId = hex(16);
  const spanId = hex(8);
  // 版本 00，采样位 01。单机工具没有采样决策，恒为「记录」
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` };
}

/** 供人念的短号。界面上报错时给这个，32 位没人念得完 */
export function shortTrace(traceId: string): string {
  return traceId.slice(0, 8);
}
