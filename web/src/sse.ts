/**
 * SSE 帧解析。
 *
 * ## 为什么自己解析，而不用 EventSource
 *
 * **传输格式仍然是 SSE，换掉的只是客户端。** 这个区分很重要：
 * `text/event-stream` 那套分帧没有任何问题（OpenAI、Anthropic 的流式接口
 * 用的都是它），有问题的是浏览器那个 `EventSource` 实现——
 *
 * - **`onerror` 里什么都拿不到**。没有状态码、没有响应体、没有原因。
 *   401 过期、500 崩了、CORS 配错、DNS 挂了、用户断网，在前端**长得
 *   一模一样**，只有一个空的 error 事件。这是排障做不下去的根因。
 * - **不能自定义请求头**。所以带不了 `traceparent`——**客户端的一次失败，
 *   物理上没法和服务端日志对上号**。也带不了 `Authorization`。
 * - **只能 GET**。参数只能进 URL，prompt 明文躺进 access log 和浏览器历史。
 * - **重连策略不可控**。浏览器按自己的节奏定频重试，没有退避没有抖动，
 *   服务端一挂就是 N 个客户端齐射；也没法区分「该重试」和「重试也没用」。
 *
 * 换成 `fetch` + `ReadableStream` 之后这些全部拿回来了，代价是分帧和
 * 重连要自己写。**而这个项目的代价特别低**：续传的重活全在服务端
 * （`record.events` 的数组下标就是 id），客户端只需要把上次的 id
 * 放进请求头。EventSource 白送的两样，这里本来就只用得上一半。
 *
 * ## 为什么解析器是个独立的纯函数
 *
 * 因为**帧边界和网络分块是两回事**。TCP 想在哪儿切就在哪儿切，一个帧
 * 可能被劈成两个 chunk，两个帧也可能挤在一个 chunk 里。把「喂字符串、
 * 吐完整帧」这件事单独拎出来，就能用任意刁钻的切分方式去测它，
 * 而不需要真起一个服务端。
 */

export interface SseFrame {
  /** 服务端给的事件编号，用于断线续传。心跳这类瞬时事件不带 */
  id?: string;
  /** 事件名。SSE 规范规定省略时为 `message` */
  event: string;
  data: string;
}

/** 帧之间由一个空行分隔，兼容 `\n` 与 `\r\n` */
const FRAME_BOUNDARY = /\r?\n\r?\n/;

function parseFrame(raw: string): SseFrame | undefined {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];

  for (const line of raw.split(/\r?\n|\r/)) {
    // 以冒号开头的是注释行。SSE 常用 `: ping` 保活，但**注释行浏览器
    // 和这里都只当作「还有字节在流动」**，不产生事件——所以我们的心跳
    // 是具名事件而不是注释行，否则 JS 侧根本感知不到。
    //
    // 变异测试如实报告：删掉这行 9/9 全绿，它**确实是冗余的**——冒号在
    // 0 位时下面会把 field 解析成空串，同样落不进任何分支。留着是因为它
    // 直接对应规范条文，读代码的人不必自己推导这个等价性；一旦字段解析
    // 逻辑改动，这个等价就不再成立
    if (line.startsWith(":")) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // 规范规定冒号后紧跟的**一个**空格要去掉，多余的空格是数据的一部分
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    // 含 NUL 的 id 按规范必须忽略，否则会污染后续的续传编号
    else if (field === "id" && !value.includes("\0")) id = value;
    // `retry` 是给 EventSource 的重连间隔用的，我们自己管退避，读了也没用
  }

  // 只有注释或空字段的帧不该产生事件
  if (data.length === 0 && id === undefined) return undefined;
  // 多行 data 按规范用 \n 拼接（而不是丢掉除第一行以外的部分）
  return { id, event, data: data.join("\n") };
}

/**
 * 增量解析器。喂任意切分的字符串块，吐出这一块里凑齐的完整帧。
 *
 * 没凑齐的部分留在内部缓冲里等下一块——**这正是自己解析时最容易漏的地方**，
 * 漏了的表现是「偶发丢事件」或者「JSON.parse 报错」，且只在网络慢的时候出现。
 */
export function createSseParser(): (chunk: string) => SseFrame[] {
  let buffer = "";

  return (chunk: string): SseFrame[] => {
    buffer += chunk;
    const frames: SseFrame[] = [];

    for (;;) {
      const match = FRAME_BOUNDARY.exec(buffer);
      if (!match) break;

      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);

      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }

    return frames;
  };
}

/**
 * 把一条 `fetch` 响应体读成帧流。
 *
 * `TextDecoder` 必须开 `stream: true`：一个多字节字符**可以被 TCP 从中间
 * 劈开**，不开的话每次分块边界都可能吐出一个替换字符。这个项目的事件
 * 标签全是中文，不开等于必坏。
 */
export async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parse(decoder.decode(value, { stream: true }))) yield frame;
    }
  } finally {
    // 提前 break（拿到 done 事件、或者外部取消）时必须放锁，
    // 否则这条响应体会一直被占着，连接也不会真正释放
    reader.releaseLock();
  }
}
